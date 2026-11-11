import type { MockAnswer, MockRequest } from './mock-github.js';

// A stand-in for the part of Jira's REST API v2 the ticket adapter reads, with invented issues.
// The server tests answer `fetch` with it and the e2e server answers HTTP with it. It records
// every request, which is how the tests check that wow asks only about the tickets it follows.

export interface MockIssue {
  readonly key: string;
  readonly summary: string;
  readonly status: string;
  readonly assignee: string | null;
  readonly type: string;
  // Wiki markup, as Jira answers it on v2.
  readonly description: string | null;
}

const json = (status: number, body: unknown): MockAnswer => ({ status, body, headers: {} });

export class MockJira {
  issues: MockIssue[] = [];
  // Every request fails with this status and message until it is cleared.
  failure: { status: number; message: string } | undefined;
  // Only this Authorization header is accepted when set.
  authorization: string | undefined;
  // Every request through `fetch` times out while this is on.
  slow = false;
  readonly requests: MockRequest[] = [];

  answer(method: string, pathAndQuery: string, authorization: string | null): MockAnswer {
    this.requests.push({ method, path: pathAndQuery, authorization });
    if (method !== 'GET') return json(405, { errorMessages: ['This mock only reads'] });
    if (this.failure) return json(this.failure.status, { errorMessages: [this.failure.message] });
    if (this.authorization !== undefined && authorization !== this.authorization) {
      return json(401, { errorMessages: ['You are not authenticated.'] });
    }
    const url = new URL(pathAndQuery, 'http://mock.invalid');
    const single = /^\/rest\/api\/2\/issue\/([^/]+)$/.exec(url.pathname);
    const issue = single
      ? this.issues.find((candidate) => candidate.key === decodeURIComponent(single[1] ?? ''))
      : undefined;
    if (!issue) {
      return json(404, {
        errorMessages: ['Issue does not exist or you do not have permission to see it.'],
      });
    }
    return json(200, {
      id: '10001',
      key: issue.key,
      fields: {
        summary: issue.summary,
        status: { name: issue.status },
        assignee: issue.assignee === null ? null : { displayName: issue.assignee },
        issuetype: { name: issue.type },
        description: issue.description,
      },
    });
  }

  // A `fetch` that asks this mock; requests to any other origin, and every request while `slow`
  // is on, fail like an unreachable host or one that does not answer in time.
  fetch(baseUrl: string): typeof fetch {
    const base = baseUrl.replace(/\/+$/, '');
    return (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(`${base}/`)) return Promise.reject(new TypeError('fetch failed'));
      if (this.slow) {
        this.requests.push({
          method: init?.method ?? 'GET',
          path: url.slice(base.length),
          authorization: null,
        });
        return Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
      }
      const authorization = new Headers(init?.headers).get('authorization');
      const answer = this.answer(init?.method ?? 'GET', url.slice(base.length), authorization);
      return Promise.resolve(
        new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { 'content-type': 'application/json', ...answer.headers },
        }),
      );
    };
  }
}
