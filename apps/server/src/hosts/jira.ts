import { jiraAuthorization, type JiraConfig } from '../trackers/jira.js';
import {
  TrackerError,
  field,
  getJsonAnswer,
  headersOf,
  trimBase,
  type RequestOptions,
} from '../trackers/http.js';
import { HostFailure, type TicketAdapter } from './adapter.js';
import { jiraToMarkdown } from './jira-wiki.js';

// Jira Cloud, Server and Data Center as a ticket host (review loop spec 33): reads one issue with
// `GET <base>/rest/api/2/issue/<key>`, with the same sign-in a publish uses (trackers/jira.ts).
// v2 because Server and Data Center accept it. Read only: it sends GET requests and nothing else.

export type JiraSignIn = Pick<JiraConfig, 'baseUrl' | 'authMode' | 'email' | 'token'>;

export interface JiraHostOptions extends RequestOptions {
  readonly clock?: () => Date;
}

const tokenSetting = 'trackers.jira.token';
const issueKey = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;
// A project key as Jira allows it: a letter, then letters, digits or underscores.
const projectKeyShape = /^[A-Za-z][A-Za-z0-9_]*$/;

export const isJiraKey = (key: string): boolean => issueKey.test(key);

// The first `<KEY>-<number>` in a pull request title or a branch name, for the project's Jira
// key, in any case (`abc-12-fix` is ABC-12). Not inside a longer word or number.
export function jiraKeyIn(text: string, projectKey: string): string | undefined {
  const key = projectKey.trim();
  if (!projectKeyShape.test(key)) return undefined;
  const match = new RegExp(`(?<![A-Za-z0-9])${key}-([1-9]\\d*)(?!\\d)`, 'i').exec(text);
  return match ? `${key.toUpperCase()}-${match[1]}` : undefined;
}

// The host has no such issue, or does not show it to the token. Only this ticket is affected,
// so the poller goes on asking about the others.
export class MissingTicket extends HostFailure {}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const webAddress = (value: string): boolean => {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === 'https:' || protocol === 'http:';
};

export function createJiraHost(
  config: JiraSignIn,
  name: string,
  options: JiraHostOptions,
): TicketAdapter {
  const base = trimBase(config.baseUrl);
  const headers = { authorization: jiraAuthorization(config) };
  const clock = options.clock ?? (() => new Date());
  let requests = 0;
  let waitUntil: Date | undefined;

  // Jira says how long to stay away when it refuses for its request limit.
  const noteRetry = (answer: Headers | undefined): boolean => {
    const seconds = Number(answer?.get('retry-after') ?? Number.NaN);
    if (!Number.isFinite(seconds) || seconds < 0) return false;
    const until = clock().getTime() + seconds * 1000;
    if (Number.isNaN(new Date(until).getTime())) return false;
    waitUntil = new Date(Math.max(until, waitUntil?.getTime() ?? 0));
    return true;
  };

  const failure = (key: string, error: unknown): HostFailure => {
    if (!(error instanceof TrackerError)) {
      return new HostFailure('failed', error instanceof Error ? error.message : String(error));
    }
    const said = error.message.replace(`${name} answered `, '');
    if (error.status === 429 && noteRetry(headersOf(error))) {
      return new HostFailure(
        'failed',
        `${name} says its request limit is used up; wow asks again after ${waitUntil?.toISOString() ?? 'a while'}`,
      );
    }
    if (error.status === 401 || error.status === 403) {
      return new HostFailure(
        'refused',
        `${name} refused the Jira token (${said}). Check the Jira token in Settings → Trackers.`,
        tokenSetting,
      );
    }
    if (error.status === 404) {
      return new MissingTicket(
        'refused',
        `${name} shows no issue ${key} to the Jira token (it answered 404). Check that the issue exists and that the token in Settings → Trackers may read it.`,
        tokenSetting,
      );
    }
    return new HostFailure('failed', error.message);
  };

  return {
    kind: 'jira',
    name,
    get requests() {
      return requests;
    },
    get waitUntil() {
      return waitUntil;
    },
    async read(key) {
      if (!isJiraKey(key)) {
        throw new HostFailure('failed', `${key} is not a Jira issue key, so it was not asked for`);
      }
      requests += 1;
      let body: unknown;
      try {
        const answer = await getJsonAnswer(
          name,
          `${base}/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,status,assignee,issuetype,description`,
          headers,
          options,
        );
        body = answer.body;
      } catch (error) {
        throw failure(key, error);
      }
      const fields = field(body, 'fields');
      if (typeof fields !== 'object' || fields === null) {
        throw new HostFailure(
          'failed',
          `${name} answered issue ${key} in a form wow cannot read; check the Jira URL`,
        );
      }
      // The issue may have moved to another key; the answer says where it is now.
      const answered = text(field(body, 'key'));
      const own = isJiraKey(answered) ? answered : key;
      const browse = `${base}/browse/${encodeURIComponent(own)}`;
      const assignee = field(fields, 'assignee');
      return {
        key: own,
        summary: text(field(fields, 'summary')),
        status: text(field(field(fields, 'status'), 'name')),
        assignee:
          assignee === null || assignee === undefined
            ? null
            : text(field(assignee, 'displayName')) || text(field(assignee, 'name')) || null,
        type: text(field(field(fields, 'issuetype'), 'name')),
        description: jiraToMarkdown(text(field(fields, 'description'))),
        url: webAddress(browse) ? browse : null,
      };
    },
  };
}
