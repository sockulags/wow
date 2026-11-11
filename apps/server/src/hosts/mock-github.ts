// A stand-in for the part of GitHub's REST API the host adapter reads, with invented pull
// requests. The server tests answer `fetch` with it and the e2e server answers HTTP with it, so
// both see the same host. It records every request, which is how the tests check that wow asks
// about nothing it does not follow.

export interface MockCheckRun {
  readonly name: string;
  readonly status: 'queued' | 'in_progress' | 'completed';
  readonly conclusion: string | null;
}

export interface MockReviewComment {
  readonly id: number | string;
  readonly user: string;
  readonly body: string;
  readonly path: string;
  // Answered as the comment's link instead of the one the mock makes up.
  readonly url?: string;
}

export interface MockPullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly mergedAt?: string;
  readonly draft?: boolean;
  readonly branch: string;
  readonly sha: string;
  readonly checkRuns?: readonly MockCheckRun[];
  // Commit statuses by context: success, pending, failure or error.
  readonly statuses?: Readonly<Record<string, string>>;
  readonly comments?: readonly MockReviewComment[];
  // Answered as the pull request's link instead of the one the mock makes up.
  readonly url?: string;
  // The fork's `owner/repo` its head is in; null for a fork that was deleted. Absent: this
  // repository.
  readonly fork?: string | null;
}

export interface MockRequest {
  readonly method: string;
  // Path and query below the API root, such as `/repos/acme/tea/pulls/12`.
  readonly path: string;
  readonly authorization: string | null;
}

export interface MockAnswer {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export class MockGitHub {
  readonly owner: string;
  readonly repo: string;
  // Where the invented pull requests "live" for their links.
  readonly webUrl: string;
  pulls: MockPullRequest[] = [];
  // Off: the search endpoint is not there, like on an older Enterprise Server.
  search = true;
  // Off: neither check runs nor commit statuses exist on this host.
  checks = true;
  // Every request fails with this status and message until it is cleared.
  failure: { status: number; message: string } | undefined;
  // Only this token is accepted when set.
  token: string | undefined;
  // Sent as the request limit headers when set.
  limit: { remaining: number; reset: number } | undefined;
  // Sent as the Retry-After header when set.
  retryAfter: string | undefined;
  readonly requests: MockRequest[] = [];

  constructor(options: { owner: string; repo: string; webUrl: string }) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.webUrl = options.webUrl.replace(/\/+$/, '');
  }

  #pullUrl(number: number): string {
    return `${this.webUrl}/${this.owner}/${this.repo}/pull/${number}`;
  }

  #pull(pull: MockPullRequest) {
    return {
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      draft: pull.draft ?? false,
      merged_at: pull.mergedAt ?? null,
      html_url: pull.url ?? this.#pullUrl(pull.number),
      head: {
        ref: pull.branch,
        sha: pull.sha,
        repo: pull.fork === null ? null : { full_name: pull.fork ?? `${this.owner}/${this.repo}` },
      },
      base: { repo: { full_name: `${this.owner}/${this.repo}` } },
    };
  }

  answer(method: string, pathAndQuery: string, authorization: string | null): MockAnswer {
    this.requests.push({ method, path: pathAndQuery, authorization });
    const headers: Record<string, string> = this.limit
      ? {
          'x-ratelimit-remaining': String(this.limit.remaining),
          'x-ratelimit-reset': String(this.limit.reset),
        }
      : {};
    if (this.retryAfter !== undefined) headers['retry-after'] = this.retryAfter;
    const json = (status: number, body: unknown): MockAnswer => ({ status, body, headers });
    if (method !== 'GET') return json(405, { message: 'This mock only reads' });
    if (this.failure) return json(this.failure.status, { message: this.failure.message });
    if (this.token !== undefined && authorization !== `Bearer ${this.token}`) {
      return json(401, { message: 'Bad credentials' });
    }
    const url = new URL(pathAndQuery, 'http://mock.invalid');
    const repo = `/repos/${this.owner}/${this.repo}`;
    if (url.pathname === '/search/issues') {
      if (!this.search) return json(404, { message: 'Not Found' });
      const query = url.searchParams.get('q') ?? '';
      const phrase = /"([^"]+)"/.exec(query)?.[1] ?? '';
      if (!query.includes(`repo:${this.owner}/${this.repo}`)) return json(200, { items: [] });
      const items = this.pulls
        .filter((pull) => phrase !== '' && pull.body.includes(phrase))
        .map((pull) => ({
          number: pull.number,
          title: pull.title,
          body: pull.body,
          state: pull.state,
          draft: pull.draft ?? false,
          html_url: pull.url ?? this.#pullUrl(pull.number),
          pull_request: { merged_at: pull.mergedAt ?? null },
        }));
      return json(200, { total_count: items.length, items });
    }
    if (url.pathname === `${repo}/pulls`) {
      const head = url.searchParams.get('head');
      const count = Number(url.searchParams.get('per_page') ?? '30');
      const listed = this.pulls
        .filter((pull) => head === null || head === `${this.owner}:${pull.branch}`)
        .toSorted((a, b) => b.number - a.number)
        .slice(0, count);
      return json(
        200,
        listed.map((pull) => this.#pull(pull)),
      );
    }
    const single = new RegExp(`^${repo}/pulls/(\\d+)(/comments)?$`).exec(url.pathname);
    if (single) {
      const pull = this.pulls.find((candidate) => candidate.number === Number(single[1]));
      if (!pull) return json(404, { message: 'Not Found' });
      if (single[2] === undefined) return json(200, this.#pull(pull));
      return json(
        200,
        (pull.comments ?? []).map((comment) => ({
          id: comment.id,
          user: { login: comment.user },
          body: comment.body,
          path: comment.path,
          html_url: comment.url ?? `${this.#pullUrl(pull.number)}#discussion_r${comment.id}`,
          created_at: '2026-11-03T08:15:00Z',
        })),
      );
    }
    const commit = new RegExp(`^${repo}/commits/([^/]+)/(check-runs|status)$`).exec(url.pathname);
    if (commit) {
      const pull = this.pulls.find((candidate) => candidate.sha === commit[1]);
      if (!this.checks || !pull) return json(404, { message: 'Not Found' });
      if (commit[2] === 'check-runs') {
        const runs = (pull.checkRuns ?? []).map((run, index) => ({
          ...run,
          html_url: `${this.#pullUrl(pull.number)}/checks?check_run_id=${index + 1}`,
        }));
        return json(200, { total_count: runs.length, check_runs: runs });
      }
      const statuses = Object.entries(pull.statuses ?? {}).map(([context, state]) => ({
        context,
        state,
        target_url: `${this.webUrl}/status/${encodeURIComponent(context)}`,
      }));
      return json(200, { state: 'pending', statuses });
    }
    return json(404, { message: 'Not Found' });
  }

  // A `fetch` that asks this mock; requests to any other origin fail like an unreachable host.
  fetch(apiUrl: string): typeof fetch {
    const base = apiUrl.replace(/\/+$/, '');
    return (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(`${base}/`)) return Promise.reject(new TypeError('fetch failed'));
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
