import { intentUnitLines } from '@wow/agent-os';
import type { HostCheck, Issue, ReviewComment } from '@wow/contracts';
import type { GitHubConfig } from '../trackers/github.js';
import {
  TrackerError,
  field,
  getJsonAnswer,
  headersOf,
  trimBase,
  type RequestOptions,
} from '../trackers/http.js';
import {
  HostFailure,
  hostLink as link,
  hostTime as time,
  validTime,
  waitBound,
  webLinksIn,
  type FoundChangeRequest,
  type HostAdapter,
  type HostChangeRequest,
  type WaitOptions,
} from './adapter.js';

// GitHub and GitHub Enterprise Server (the same API under https://<host>/api/v3) as a host: finds
// a plan's pull requests with one search and reads each one's state, checks and review comments.
// Read only: it sends GET requests and nothing else.

export interface GitHubHostOptions extends RequestOptions, WaitOptions {
  // How many of the newest pull requests are read when the host has no search.
  readonly listFallbackCount: number;
}

// GitHub's largest page. A plan with more pull requests or a pull request with more review
// comments than one page shows the newest ones.
const pageSize = 100;

// A search endpoint that is not there (older or restricted Enterprise Server) or that turns the
// query down: the newest pull requests are read instead.
const noSearch = new Set([404, 405, 410, 422, 501]);
// An endpoint this host does not have: no checks from it.
const missingEndpoint = new Set([404, 410, 501]);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// One item of a search (an issue with `pull_request`) or of the pull request list.
function found(item: unknown): FoundChangeRequest | undefined {
  const number = field(item, 'number');
  const url = link(field(item, 'html_url'));
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0 || url === null) {
    return undefined;
  }
  const mergedAt = time(
    field(item, 'merged_at') ?? field(field(item, 'pull_request'), 'merged_at'),
  );
  const head = field(item, 'head');
  const branch = field(head, 'ref');
  const sha = field(head, 'sha');
  // A deleted fork's head repository is null. Anything but the same name as the base repository
  // counts as a fork, so an answer that leaves it out never lets a fork through.
  const headRepo = field(field(head, 'repo'), 'full_name');
  const baseRepo = field(field(field(item, 'base'), 'repo'), 'full_name');
  const fromFork = !(
    typeof headRepo === 'string' &&
    typeof baseRepo === 'string' &&
    headRepo.toLowerCase() === baseRepo.toLowerCase()
  );
  return {
    number,
    title: text(field(item, 'title')),
    url,
    state: mergedAt !== null ? 'merged' : field(item, 'state') === 'open' ? 'open' : 'closed',
    draft: field(item, 'draft') === true,
    mergedAt,
    units: intentUnitLines(text(field(item, 'body'))),
    links: webLinksIn(text(field(item, 'body'))),
    ...(typeof branch === 'string' && typeof sha === 'string'
      ? { head: { branch, sha, fromFork } }
      : {}),
  };
}

const failedConclusions = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
  'stale',
]);

function checkRun(run: unknown): HostCheck | undefined {
  const name = text(field(run, 'name'));
  if (name === '') return undefined;
  const conclusion = field(run, 'conclusion');
  const state =
    field(run, 'status') !== 'completed'
      ? 'pending'
      : typeof conclusion === 'string' && failedConclusions.has(conclusion)
        ? 'failure'
        : 'success';
  return { name, state, url: link(field(run, 'html_url')) };
}

function commitStatus(status: unknown): HostCheck | undefined {
  const name = text(field(status, 'context'));
  if (name === '') return undefined;
  const reported = field(status, 'state');
  const state = reported === 'success' ? 'success' : reported === 'pending' ? 'pending' : 'failure';
  return { name, state, url: link(field(status, 'target_url')) };
}

export function checkStateOf(checks: readonly HostCheck[]): HostChangeRequest['checkState'] {
  if (checks.some((check) => check.state === 'failure')) return 'failure';
  if (checks.some((check) => check.state === 'pending')) return 'pending';
  return checks.length > 0 ? 'success' : 'none';
}

function reviewComment(comment: unknown): ReviewComment | undefined {
  const id = field(comment, 'id');
  const url = link(field(comment, 'html_url'));
  if ((typeof id !== 'number' && typeof id !== 'string') || String(id) === '' || url === null) {
    return undefined;
  }
  return {
    id: String(id),
    author: text(field(field(comment, 'user'), 'login')),
    body: text(field(comment, 'body')),
    path: textOrNull(field(comment, 'path')),
    url,
    createdAt: time(field(comment, 'created_at')),
  };
}

function issueOf(body: unknown, number: number, comments: ReviewComment[]): Issue | undefined {
  const url = link(field(body, 'html_url'));
  if (url === null) return undefined;
  return {
    host: 'github',
    number,
    title: text(field(body, 'title')),
    state: field(body, 'state') === 'closed' ? 'closed' : 'open',
    author: text(field(field(body, 'user'), 'login')),
    labels: list(field(body, 'labels')).flatMap((label) => {
      const name = typeof label === 'string' ? label : field(label, 'name');
      return typeof name === 'string' && name !== '' ? [name] : [];
    }),
    body: text(field(body, 'body')),
    url,
    comments,
  };
}

const newestId = (comments: readonly ReviewComment[]): string | null =>
  comments.reduce<string | null>(
    (newest, comment) =>
      newest === null || Number(comment.id) > Number(newest) ? comment.id : newest,
    null,
  );

const tokenSetting = 'trackers.github.token';

export function createGitHubHost(
  config: GitHubConfig,
  name: string,
  options: GitHubHostOptions,
): HostAdapter {
  const base = trimBase(config.baseUrl);
  const repo = `${base}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  const headers = {
    authorization: `Bearer ${config.token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  const clock = options.clock ?? (() => new Date());
  const bounded = waitBound(options);
  let requests = 0;
  let waitUntil: Date | undefined;

  let left: { remaining: number; resetAt: Date } | undefined;

  // GitHub says how many requests are left and when the count starts again; a refusal for the
  // limit says how long to stay away. Answers whether this answer says the limit is used up.
  const noteLimit = (answer: Headers): boolean => {
    const remaining = Number(answer.get('x-ratelimit-remaining') ?? Number.NaN);
    const reset = Number(answer.get('x-ratelimit-reset') ?? Number.NaN);
    const retryAfter = Number(answer.get('retry-after') ?? Number.NaN);
    if (Number.isFinite(remaining) && validTime(reset * 1000) && reset > 0) {
      left = { remaining, resetAt: new Date(reset * 1000) };
    }
    const until =
      Number.isFinite(retryAfter) && retryAfter >= 0
        ? clock().getTime() + retryAfter * 1000
        : left?.remaining === 0
          ? left.resetAt.getTime()
          : undefined;
    // A wait that is no date (a number far out of range) says nothing; the refusal is shown as
    // it came.
    if (until === undefined || !validTime(until)) return false;
    waitUntil = new Date(Math.max(bounded(until), waitUntil?.getTime() ?? 0));
    return true;
  };

  const failure = (error: unknown): HostFailure => {
    if (!(error instanceof TrackerError)) {
      return new HostFailure('failed', error instanceof Error ? error.message : String(error));
    }
    const answered = headersOf(error);
    const limited = answered ? noteLimit(answered) : false;
    if ((error.status === 403 || error.status === 429) && limited) {
      return new HostFailure(
        'failed',
        `${name} says its request limit is used up; wow asks again after ${waitUntil?.toISOString() ?? 'a while'}`,
      );
    }
    if (error.status === 401 || error.status === 403) {
      return new HostFailure(
        'refused',
        `${name} refused the GitHub token (${error.message.replace(`${name} answered `, '')}). Check the GitHub token in Settings → Trackers.`,
        tokenSetting,
      );
    }
    if (error.status === 404) {
      return new HostFailure(
        'refused',
        `${name} does not show ${config.owner}/${config.repo} to the GitHub token (it answered 404). Check the repository and that the token in Settings → Trackers may read it.`,
        tokenSetting,
      );
    }
    return new HostFailure('failed', error.message);
  };

  const get = async (url: string): Promise<unknown> => {
    requests += 1;
    const answer = await getJsonAnswer(name, url, headers, options);
    noteLimit(answer.headers);
    return answer.body;
  };

  // `fallback` answers for the statuses in `quiet` instead of failing.
  const getOr = async <T>(
    url: string,
    quiet: ReadonlySet<number>,
    fallback: () => T | Promise<T>,
    read: (body: unknown) => T,
  ): Promise<T> => {
    let body: unknown;
    try {
      body = await get(url);
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

  const pulls = (query: string) =>
    getOr(
      `${repo}/pulls?${query}`,
      none,
      () => [],
      (body) => list(body).flatMap((item) => found(item) ?? []),
    );

  const checks = async (sha: string): Promise<HostCheck[]> => {
    const commit = `${repo}/commits/${encodeURIComponent(sha)}`;
    const runs = await getOr(
      `${commit}/check-runs?per_page=${pageSize}`,
      missingEndpoint,
      () => [],
      (body) => list(field(body, 'check_runs')).flatMap((run) => checkRun(run) ?? []),
    );
    const statuses = await getOr(
      `${commit}/status?per_page=${pageSize}`,
      missingEndpoint,
      () => [],
      (body) => list(field(body, 'statuses')).flatMap((status) => commitStatus(status) ?? []),
    );
    return [...runs, ...statuses];
  };

  return {
    kind: 'github',
    name,
    get requests() {
      return requests;
    },
    get waitUntil() {
      // With fewer requests left than this round took, the next round would be cut short.
      const short =
        left && left.remaining < requests ? new Date(bounded(left.resetAt.getTime())) : undefined;
      if (!short) return waitUntil;
      return waitUntil && waitUntil > short ? waitUntil : short;
    },
    async findForIntent(intentId) {
      // Only the intent id is searched for: a line in bold, underscores or quote marks does not
      // hold the phrase `Intent-Unit: <intent-id>/`, and the lines are read below.
      const query = `"${intentId}" in:body is:pr repo:${config.owner}/${config.repo}`;
      const all = await getOr(
        `${base}/search/issues?q=${encodeURIComponent(query)}&per_page=${pageSize}`,
        noSearch,
        () =>
          pulls(
            `state=all&sort=created&direction=desc&per_page=${Math.min(options.listFallbackCount, pageSize)}`,
          ),
        (body) => list(field(body, 'items')).flatMap((item) => found(item) ?? []),
      );
      // The search matches the id anywhere; only a body with the line itself counts.
      return all.filter((request) => request.units.some((unit) => unit.intentId === intentId));
    },
    async findForBranch(branch) {
      const head = encodeURIComponent(`${config.owner}:${branch}`);
      const [newest] = await pulls(`head=${head}&state=all&sort=created&direction=desc&per_page=1`);
      return newest;
    },
    async readIssue(number) {
      const body = await getOr(
        `${repo}/issues/${number}`,
        none,
        () => undefined,
        (answer) => answer,
      );
      if (field(body, 'pull_request') !== undefined) return 'changeRequest';
      const comments = await getOr(
        `${repo}/issues/${number}/comments?per_page=${pageSize}`,
        none,
        () => [],
        (answer) => list(answer).flatMap((comment) => reviewComment(comment) ?? []),
      );
      const issue = issueOf(body, number, comments);
      if (!issue) {
        throw new HostFailure(
          'failed',
          `${name} answered issue #${number} in a form wow cannot read; check the GitHub API URL`,
        );
      }
      return issue;
    },
    async read(request) {
      const current =
        request.head === undefined
          ? await getOr(
              `${repo}/pulls/${request.number}`,
              none,
              () => undefined,
              (body) => found(body),
            )
          : request;
      if (!current?.head) {
        throw new HostFailure(
          'failed',
          `${name} did not say where pull request #${request.number} is; check the GitHub API URL`,
        );
      }
      const all = await checks(current.head.sha);
      const comments = await getOr(
        `${repo}/pulls/${request.number}/comments?sort=created&direction=desc&per_page=${pageSize}`,
        none,
        () => [],
        (body) => list(body).flatMap((comment) => reviewComment(comment) ?? []),
      );
      return {
        host: 'github',
        number: request.number,
        title: current.title,
        url: current.url,
        state: current.state,
        draft: current.draft,
        mergedAt: current.mergedAt,
        headBranch: current.head.branch,
        headSha: current.head.sha,
        fromFork: current.head.fromFork,
        // The single pull request answer has the body too, but the lines were read when it was
        // found, from the same body.
        units: [...request.units],
        links: [...(current.links ?? request.links ?? [])],
        checkState: checkStateOf(all),
        checks: all,
        comments,
        newestCommentId: newestId(comments),
      };
    },
  };
}
