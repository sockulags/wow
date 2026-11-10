// A stand-in for the part of GitLab's v4 API wow reads, with invented merge requests. The server
// tests answer `fetch` with it and the e2e server answers HTTP with it. It records every request,
// so tests can check that wow asks about nothing it does not follow.

export interface MockGitLabJob {
  readonly name: string;
  // success, failed, canceled, skipped, manual, running, pending, …
  readonly status: string;
  readonly allowFailure?: boolean;
}

export interface MockGitLabNote {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  // The file a diff note is on.
  readonly path?: string;
  // GitLab's own notes ("added 1 commit").
  readonly system?: boolean;
}

export interface MockMergeRequest {
  readonly iid: number;
  readonly title: string;
  readonly description: string;
  readonly state: 'opened' | 'closed' | 'merged' | 'locked';
  readonly mergedAt?: string;
  readonly draft?: boolean;
  readonly branch: string;
  readonly sha: string;
  // The head commit's pipeline: its status and jobs. None: no pipeline ran.
  readonly pipeline?: {
    readonly id: number;
    readonly status: string;
    readonly jobs: readonly MockGitLabJob[];
  };
  readonly notes?: readonly MockGitLabNote[];
}

export interface MockGitLabRequest {
  readonly method: string;
  // Path and query below /api/v4, such as `/projects/group%2Fapp/merge_requests?…`.
  readonly path: string;
  readonly token: string | null;
}

export interface MockGitLabAnswer {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export class MockGitLab {
  // The project path with every group, such as `group/sub/app`.
  readonly projectPath: string;
  // Where the invented merge requests "live" for their links.
  readonly webUrl: string;
  mergeRequests: MockMergeRequest[] = [];
  // Off: the merge request search is turned down with 400, like a version that does not know it.
  search = true;
  // Every request fails with this status and message until it is cleared.
  failure: { status: number; message: string } | undefined;
  // Only this token is accepted when set.
  token: string | undefined;
  user = { username: 'mira', name: 'Mira Invented' };
  version = '17.5.2';
  // Sent as RateLimit-Remaining and RateLimit-Reset when set.
  limit: { remaining: number; reset: number } | undefined;
  retryAfter: string | undefined;
  readonly requests: MockGitLabRequest[] = [];

  constructor(options: { projectPath: string; webUrl: string }) {
    this.projectPath = options.projectPath;
    this.webUrl = options.webUrl.replace(/\/+$/, '');
  }

  #url(request: MockMergeRequest): string {
    return `${this.webUrl}/${this.projectPath}/-/merge_requests/${request.iid}`;
  }

  #mergeRequest(request: MockMergeRequest) {
    return {
      iid: request.iid,
      title: request.title,
      description: request.description,
      state: request.state,
      draft: request.draft ?? false,
      merged_at: request.mergedAt ?? null,
      source_branch: request.branch,
      sha: request.sha,
      web_url: this.#url(request),
    };
  }

  answer(method: string, pathAndQuery: string, token: string | null): MockGitLabAnswer {
    this.requests.push({ method, path: pathAndQuery, token });
    const headers: Record<string, string> = this.limit
      ? {
          'ratelimit-remaining': String(this.limit.remaining),
          'ratelimit-reset': String(this.limit.reset),
        }
      : {};
    if (this.retryAfter !== undefined) headers['retry-after'] = this.retryAfter;
    const json = (status: number, body: unknown): MockGitLabAnswer => ({ status, body, headers });
    if (method !== 'GET') return json(405, { message: '405 Method Not Allowed' });
    if (this.failure) return json(this.failure.status, { message: this.failure.message });
    if (this.token !== undefined && token !== this.token) {
      return json(401, { message: '401 Unauthorized' });
    }
    const url = new URL(pathAndQuery, 'http://mock.invalid');
    if (url.pathname === '/user') return json(200, { id: 7, ...this.user });
    if (url.pathname === '/version') return json(200, { version: this.version, revision: 'abc' });
    // The project id is the URL-encoded path, so `/` inside it is `%2F` and splits nothing.
    const project = `/projects/${encodeURIComponent(this.projectPath)}`;
    if (!url.pathname.startsWith(project)) return json(404, { message: '404 Project Not Found' });
    const rest = url.pathname.slice(project.length);
    if (rest === '') return json(200, { id: 70, path_with_namespace: this.projectPath });
    if (rest === '/merge_requests') {
      const search = url.searchParams.get('search');
      if (search !== null && !this.search) {
        return json(400, { error: 'search is invalid' });
      }
      const branch = url.searchParams.get('source_branch');
      const count = Number(url.searchParams.get('per_page') ?? '20');
      const listed = this.mergeRequests
        .filter((request) => search === null || request.description.includes(search))
        .filter((request) => branch === null || request.branch === branch)
        .toSorted((a, b) => b.iid - a.iid)
        .slice(0, count);
      return json(
        200,
        listed.map((request) => this.#mergeRequest(request)),
      );
    }
    const single = /^\/merge_requests\/(\d+)(\/pipelines|\/notes)?$/.exec(rest);
    if (single) {
      const request = this.mergeRequests.find((candidate) => candidate.iid === Number(single[1]));
      if (!request) return json(404, { message: '404 Not found' });
      if (single[2] === undefined) return json(200, this.#mergeRequest(request));
      if (single[2] === '/pipelines') {
        const { pipeline } = request;
        return json(
          200,
          pipeline
            ? [
                {
                  id: pipeline.id,
                  sha: request.sha,
                  status: pipeline.status,
                  web_url: `${this.webUrl}/${this.projectPath}/-/pipelines/${pipeline.id}`,
                },
              ]
            : [],
        );
      }
      return json(
        200,
        (request.notes ?? []).toReversed().map((entry) => ({
          id: entry.id,
          body: entry.body,
          author: { username: entry.author },
          system: entry.system ?? false,
          created_at: '2026-11-03T08:15:00Z',
          ...(entry.path ? { position: { new_path: entry.path, old_path: entry.path } } : {}),
        })),
      );
    }
    const jobs = /^\/pipelines\/(\d+)\/jobs$/.exec(rest);
    if (jobs) {
      const request = this.mergeRequests.find(
        (candidate) => candidate.pipeline?.id === Number(jobs[1]),
      );
      if (!request?.pipeline) return json(404, { message: '404 Not found' });
      const pipelineId = request.pipeline.id;
      return json(
        200,
        request.pipeline.jobs.map((entry, index) => ({
          id: pipelineId * 100 + index,
          name: entry.name,
          status: entry.status,
          allow_failure: entry.allowFailure ?? false,
          web_url: `${this.webUrl}/${this.projectPath}/-/jobs/${pipelineId * 100 + index}`,
        })),
      );
    }
    return json(404, { message: '404 Not Found' });
  }

  // A `fetch` that asks this mock for everything under `<site>/api/v4`; any other address fails
  // like an unreachable host.
  fetch(siteUrl: string): typeof fetch {
    const base = `${siteUrl.replace(/\/+$/, '')}/api/v4`;
    return (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(`${base}/`)) return Promise.reject(new TypeError('fetch failed'));
      const token = new Headers(init?.headers).get('private-token');
      const answer = this.answer(init?.method ?? 'GET', url.slice(base.length), token);
      return Promise.resolve(
        new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { 'content-type': 'application/json', ...answer.headers },
        }),
      );
    };
  }
}
