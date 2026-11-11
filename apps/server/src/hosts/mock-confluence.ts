import type { MockAnswer, MockRequest } from './mock-github.js';

// A stand-in for the part of Confluence's REST API the page adapter reads, with invented pages.
// The server tests answer `fetch` with it and the e2e server answers HTTP with it. It records
// every request, which is how the tests check that wow reads only pages something links to.

export interface MockPage {
  readonly id: string;
  readonly title: string;
  readonly space: string;
  readonly version: number;
  // The rendered body, as Confluence answers `body.view`.
  readonly body: string;
}

const json = (status: number, body: unknown): MockAnswer => ({ status, body, headers: {} });

export class MockConfluence {
  pages: MockPage[] = [];
  // Every request fails with this status and message until it is cleared.
  failure: { status: number; message: string } | undefined;
  // Only this Authorization header is accepted when set.
  authorization: string | undefined;
  // Every request through `fetch` times out while this is on.
  slow = false;
  // The path the site lives under on the host (`/wiki` on Cloud), as the answers' links have it.
  readonly context: string;
  readonly requests: MockRequest[] = [];

  constructor(context = '') {
    this.context = context;
  }

  #content(page: MockPage) {
    return {
      id: page.id,
      type: 'page',
      status: 'current',
      title: page.title,
      space: { key: page.space, name: `${page.space} space` },
      version: { number: page.version },
      body: { view: { value: page.body, representation: 'view' } },
      _links: {
        webui: `/spaces/${page.space}/pages/${page.id}`,
        base: `https://mock.invalid${this.context}`,
      },
    };
  }

  answer(method: string, pathAndQuery: string, authorization: string | null): MockAnswer {
    this.requests.push({ method, path: pathAndQuery, authorization });
    if (method !== 'GET') return json(405, { message: 'This mock only reads' });
    if (this.failure) return json(this.failure.status, { message: this.failure.message });
    if (this.authorization !== undefined && authorization !== this.authorization) {
      return json(401, { message: 'This request requires authentication.' });
    }
    const url = new URL(pathAndQuery, 'http://mock.invalid');
    if (url.pathname === '/rest/api/user/current') {
      return json(200, { type: 'known', username: 'mira', displayName: 'Mira Invented' });
    }
    const single = /^\/rest\/api\/content\/([^/]+)$/.exec(url.pathname);
    if (single) {
      const page = this.pages.find((candidate) => candidate.id === single[1]);
      return page
        ? json(200, this.#content(page))
        : json(404, { message: `No content found with id: ContentId{id=${single[1] ?? ''}}` });
    }
    if (url.pathname === '/rest/api/content') {
      const space = url.searchParams.get('spaceKey');
      const title = url.searchParams.get('title');
      const results = this.pages
        .filter((page) => page.space === space && page.title === title)
        .map((page) => this.#content(page));
      return json(200, { results, size: results.length });
    }
    return json(404, { message: 'Not found' });
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
