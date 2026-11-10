import { intentUnitLines } from '@wow/agent-os';
import type { HostCheck, ReviewComment } from '@wow/contracts';
import {
  gitLabApi,
  gitLabHeaders,
  gitLabProjectId,
  type GitLabConfig,
} from '../trackers/gitlab.js';
import {
  TrackerError,
  field,
  getJsonAnswer,
  headersOf,
  type RequestOptions,
} from '../trackers/http.js';
import {
  HostFailure,
  hostLink,
  hostTime,
  validTime,
  type FoundChangeRequest,
  type HostAdapter,
} from './adapter.js';
import { checkStateOf } from './github.js';

// GitLab as a code host (review loop spec 34): merge requests fill the role of pull requests,
// the jobs of the head commit's pipeline are the checks, and the merge request's notes are the
// review comments. API v4 with the PRIVATE-TOKEN header. Read only: it sends GET requests and
// nothing else.

export interface GitLabHostOptions extends RequestOptions {
  // How many of the newest merge requests are read when the search is turned down.
  readonly listFallbackCount: number;
  readonly clock?: () => Date;
}

// GitLab's largest page.
const pageSize = 100;
// A search the host turns down (an older version, or a parameter it does not know): the newest
// merge requests are read instead. 404 is not here: it means the project is not visible.
const noSearch = new Set([400, 405, 422, 501]);
// CI is off for the project or the token may not see it: no checks from it.
const noPipelines = new Set([403, 404, 410, 501]);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function found(item: unknown): FoundChangeRequest | undefined {
  const iid = field(item, 'iid');
  const url = hostLink(field(item, 'web_url'));
  if (typeof iid !== 'number' || !Number.isSafeInteger(iid) || iid <= 0 || url === null) {
    return undefined;
  }
  const reported = field(item, 'state');
  const branch = field(item, 'source_branch');
  const sha = field(item, 'sha');
  return {
    number: iid,
    title: text(field(item, 'title')),
    url,
    state: reported === 'merged' ? 'merged' : reported === 'opened' ? 'open' : 'closed',
    // `work_in_progress` is what versions before 14 call a draft.
    draft: field(item, 'draft') === true || field(item, 'work_in_progress') === true,
    mergedAt: hostTime(field(item, 'merged_at')),
    units: intentUnitLines(text(field(item, 'description'))),
    ...(typeof branch === 'string' && typeof sha === 'string' && sha !== ''
      ? { head: { branch, sha } }
      : {}),
  };
}

// Skipped and manual jobs did not run, so they neither pass nor fail anything. A failure the
// pipeline allows does not fail the merge request either.
function checkState(status: unknown, allowFailure: boolean): HostCheck['state'] | undefined {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
      return allowFailure ? 'success' : 'failure';
    case 'canceled':
      return 'failure';
    case 'skipped':
    case 'manual':
      return undefined;
    default:
      return 'pending';
  }
}

function job(entry: unknown): HostCheck | undefined {
  const name = text(field(entry, 'name'));
  const state = checkState(field(entry, 'status'), field(entry, 'allow_failure') === true);
  if (name === '' || state === undefined) return undefined;
  return { name, state, url: hostLink(field(entry, 'web_url')) };
}

function note(entry: unknown, requestUrl: string): ReviewComment | undefined {
  const id = field(entry, 'id');
  // System notes ("added 1 commit", "changed the description") are GitLab's, not a reviewer's.
  if (field(entry, 'system') === true) return undefined;
  if ((typeof id !== 'number' && typeof id !== 'string') || String(id) === '') return undefined;
  const position = field(entry, 'position');
  const path = field(position, 'new_path') ?? field(position, 'old_path');
  return {
    id: String(id),
    author: text(field(field(entry, 'author'), 'username')),
    body: text(field(entry, 'body')),
    path: typeof path === 'string' && path !== '' ? path : null,
    // Notes have no link of their own; the merge request page has an anchor for each.
    url: `${requestUrl}#note_${encodeURIComponent(String(id))}`,
    createdAt: hostTime(field(entry, 'created_at')),
  };
}

const newestId = (comments: readonly ReviewComment[]): string | null =>
  comments.reduce<string | null>(
    (newest, comment) =>
      newest === null || Number(comment.id) > Number(newest) ? comment.id : newest,
    null,
  );

const tokenSetting = 'trackers.gitlab.token';

export function createGitLabHost(
  config: GitLabConfig,
  name: string,
  given: GitLabHostOptions,
): HostAdapter {
  const options: GitLabHostOptions = { ...given, redirect: 'manual' };
  const project = `${gitLabApi(config.baseUrl)}/projects/${gitLabProjectId(config.projectPath)}`;
  const headers = gitLabHeaders(config.token);
  const clock = options.clock ?? (() => new Date());
  let requests = 0;
  let waitUntil: Date | undefined;
  let left: { remaining: number; resetAt: Date } | undefined;

  // GitLab sends RateLimit-Remaining and RateLimit-Reset where rate limits are on, and
  // Retry-After with a 429. Answers whether this answer says the limit is used up.
  const noteLimit = (answer: Headers): boolean => {
    const remaining = Number(answer.get('ratelimit-remaining') ?? Number.NaN);
    const reset = Number(answer.get('ratelimit-reset') ?? Number.NaN);
    const retryAfter = Number(answer.get('retry-after')?.trim() || Number.NaN);
    if (Number.isFinite(remaining) && reset > 0 && validTime(reset * 1000)) {
      left = { remaining, resetAt: new Date(reset * 1000) };
    }
    const until =
      Number.isFinite(retryAfter) && retryAfter >= 0
        ? clock().getTime() + retryAfter * 1000
        : left?.remaining === 0
          ? left.resetAt.getTime()
          : undefined;
    if (until === undefined || !validTime(until)) return false;
    waitUntil = new Date(Math.max(until, waitUntil?.getTime() ?? 0));
    return true;
  };

  const failure = (error: unknown): HostFailure => {
    if (!(error instanceof TrackerError)) {
      return new HostFailure('failed', error instanceof Error ? error.message : String(error));
    }
    const answered = headersOf(error);
    const limited = answered ? noteLimit(answered) : false;
    if (error.status === 429 && limited) {
      return new HostFailure(
        'failed',
        `${name} says its request limit is used up; wow asks again after ${waitUntil?.toISOString() ?? 'a while'}`,
      );
    }
    if (error.status === 401 || error.status === 403) {
      return new HostFailure(
        'refused',
        `${name} refused the GitLab token (${error.message.replace(`${name} answered `, '')}). Check the GitLab token in Settings → Trackers.`,
        tokenSetting,
      );
    }
    if (error.status === 404) {
      return new HostFailure(
        'refused',
        `${name} does not show ${config.projectPath} to the GitLab token (it answered 404). Check the project's git remote and that the token in Settings → Trackers may read it.`,
        tokenSetting,
      );
    }
    return new HostFailure('failed', error.message);
  };

  const getOr = async <T>(
    url: string,
    quiet: ReadonlySet<number>,
    fallback: () => T | Promise<T>,
    read: (body: unknown) => T,
  ): Promise<T> => {
    let body: unknown;
    try {
      requests += 1;
      const answer = await getJsonAnswer(name, url, headers, options);
      noteLimit(answer.headers);
      body = answer.body;
    } catch (error) {
      if (error instanceof TrackerError && error.status !== undefined && quiet.has(error.status)) {
        const answered = headersOf(error);
        if (answered) noteLimit(answered);
        return fallback();
      }
      throw failure(error);
    }
    return read(body);
  };
  const none = new Set<number>();

  const mergeRequests = (query: string) =>
    getOr(
      `${project}/merge_requests?${query}`,
      none,
      () => [],
      (body) => list(body).flatMap((item) => found(item) ?? []),
    );

  // The jobs of the newest pipeline that ran on the head commit; a pipeline without jobs (an
  // external one) counts as one check.
  const checks = async (iid: number, sha: string): Promise<HostCheck[]> => {
    const pipelines = await getOr(
      `${project}/merge_requests/${iid}/pipelines?per_page=${pageSize}`,
      noPipelines,
      () => [],
      list,
    );
    const pipeline = pipelines.find((entry) => field(entry, 'sha') === sha);
    const id = field(pipeline, 'id');
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return [];
    const jobs = await getOr(
      `${project}/pipelines/${id}/jobs?per_page=${pageSize}`,
      noPipelines,
      () => [],
      list,
    );
    const all = jobs.flatMap((entry) => job(entry) ?? []);
    // The pipeline's own status also counts: a failure in a child pipeline or a job past the
    // first page is not in the list, and a failed or running pipeline must not read as passing.
    const state = checkState(field(pipeline, 'status'), false);
    const seen = jobs.length > 0 && (state === 'success' || all.some((c) => c.state === state));
    if (state === undefined || seen) return all;
    return [...all, { name: `pipeline ${id}`, state, url: hostLink(field(pipeline, 'web_url')) }];
  };

  return {
    kind: 'gitlab',
    name,
    get requests() {
      return requests;
    },
    get waitUntil() {
      const short = left && left.remaining < requests ? left.resetAt : undefined;
      if (!short) return waitUntil;
      return waitUntil && waitUntil > short ? waitUntil : short;
    },
    async findForIntent(intentId) {
      const search = encodeURIComponent(`Intent-Unit: ${intentId}/`);
      const all = await getOr(
        `${project}/merge_requests?state=all&search=${search}&in=description&order_by=created_at&sort=desc&per_page=${pageSize}`,
        noSearch,
        () =>
          mergeRequests(
            `state=all&order_by=created_at&sort=desc&per_page=${Math.min(options.listFallbackCount, pageSize)}`,
          ),
        (body) => list(body).flatMap((item) => found(item) ?? []),
      );
      // The search matches words; only a description with the line itself counts.
      return all.filter((request) => request.units.some((unit) => unit.intentId === intentId));
    },
    async findForBranch(branch) {
      const [newest] = await mergeRequests(
        `state=all&source_branch=${encodeURIComponent(branch)}&order_by=created_at&sort=desc&per_page=1`,
      );
      return newest;
    },
    async read(request) {
      const current =
        request.head === undefined
          ? await getOr(
              `${project}/merge_requests/${request.number}`,
              none,
              () => undefined,
              (body) => found(body),
            )
          : request;
      if (!current?.head) {
        throw new HostFailure(
          'failed',
          `${name} did not say where merge request !${request.number} is; check the GitLab URL`,
        );
      }
      const all = await checks(request.number, current.head.sha);
      const comments = await getOr(
        `${project}/merge_requests/${request.number}/notes?sort=desc&order_by=created_at&per_page=${pageSize}`,
        none,
        () => [],
        (body) => list(body).flatMap((entry) => note(entry, current.url) ?? []),
      );
      return {
        host: 'gitlab',
        number: request.number,
        title: current.title,
        url: current.url,
        state: current.state,
        draft: current.draft,
        mergedAt: current.mergedAt,
        headBranch: current.head.branch,
        headSha: current.head.sha,
        units: [...request.units],
        checkState: checkStateOf(all),
        checks: all,
        comments,
        newestCommentId: newestId(comments),
      };
    },
  };
}
