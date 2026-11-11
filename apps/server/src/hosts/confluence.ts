import { settingsRegistry, type JiraAuthMode, type Page } from '@wow/contracts';
import { jiraAuthorization } from '../trackers/jira.js';
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
  hostLink,
  waitBound,
  webLinksIn,
  type PageAdapter,
  type PageRef,
  type WaitOptions,
} from './adapter.js';

// Confluence Cloud, Server and Data Center as a page host (review loop spec 35). It reads one page
// a link names, with `GET <base>/rest/api/content/<id>?expand=body.view,version,space` or, for a
// `/display/<space>/<title>` link, `GET <base>/rest/api/content?spaceKey=&title=`. Read only: it
// sends GET requests and nothing else, and only for pages a ticket, pull request or intent links
// to. No search, no spaces, no attachments.

export interface ConfluenceSignIn {
  readonly baseUrl: string;
  readonly authMode: JiraAuthMode;
  readonly email: string;
  readonly token: string;
}

export interface ConfluenceHostOptions extends RequestOptions, WaitOptions {
  // `hosts.pageMaxBytes`: a larger body is not kept.
  readonly pageMaxBytes?: number;
}

// A link to a page on the Confluence site, as found in a text.
export interface FoundPageLink {
  // `id:<contentId>` or `title:<spaceKey>/<title>`.
  readonly ref: string;
  readonly link: string;
  readonly page: PageRef;
}

const tokenSetting = 'trackers.confluence.token';
const contentId = /^[1-9]\d*$/;

const pageRefKey = (page: PageRef): string =>
  page.kind === 'id' ? `id:${page.id}` : `title:${page.space}/${page.title}`;

const decoded = (part: string): string | undefined => {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return undefined;
  }
};

// The page an address names, when it is on the site: `/pages/viewpage.action?pageId=<id>`,
// `/spaces/<space>/pages/<id>/…` (Cloud) or `/display/<space>/<title>` (Server and Data Center).
// An address on another site, or one that names no page (a space, a search, an attachment), is
// none.
export function confluencePageOf(link: string, baseUrl: string): PageRef | undefined {
  if (!URL.canParse(link) || !URL.canParse(baseUrl)) return undefined;
  const site = new URL(trimBase(baseUrl));
  const url = new URL(link);
  if (url.protocol !== site.protocol || url.host !== site.host) return undefined;
  const prefix = site.pathname.replace(/\/+$/, '');
  if (prefix !== '' && !url.pathname.startsWith(`${prefix}/`)) return undefined;
  const parts = url.pathname.slice(prefix.length).split('/').filter(Boolean);
  if (parts[0] === 'pages' && parts[1] === 'viewpage.action' && parts.length === 2) {
    const id = url.searchParams.get('pageId') ?? '';
    return contentId.test(id) ? { kind: 'id', id } : undefined;
  }
  if (parts[0] === 'spaces' && parts[2] === 'pages' && contentId.test(parts[3] ?? '')) {
    return { kind: 'id', id: parts[3] ?? '' };
  }
  if (parts[0] === 'display' && parts.length === 3) {
    const space = decoded(parts[1] ?? '');
    const title = decoded(parts[2] ?? '');
    if (space && title && title.trim() !== '') return { kind: 'title', space, title };
  }
  return undefined;
}

// The links in a text that name a page on the site, once each.
export function confluenceLinksIn(text: string, baseUrl: string): FoundPageLink[] {
  const found = new Map<string, FoundPageLink>();
  for (const link of webLinksIn(text)) {
    const page = confluencePageOf(link, baseUrl);
    if (!page) continue;
    const ref = pageRefKey(page);
    if (!found.has(ref)) found.set(ref, { ref, link, page });
  }
  return [...found.values()];
}

// The site has no such page, or does not show it to the token. Only this page is affected, so
// the poller goes on asking about the others.
export class MissingPage extends HostFailure {}

const described = (page: PageRef): string =>
  page.kind === 'id' ? `page ${page.id}` : `page “${page.title}” in space ${page.space}`;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function createConfluenceHost(
  config: ConfluenceSignIn,
  name: string,
  options: ConfluenceHostOptions,
): PageAdapter {
  const base = trimBase(config.baseUrl);
  const headers = { authorization: jiraAuthorization(config) };
  const clock = options.clock ?? (() => new Date());
  const bounded = waitBound(options);
  // A redirect (a sign-in page, another site) is turned down instead of followed with the token.
  const requestOptions: RequestOptions = { ...options, redirect: 'manual' };
  const pageMaxBytes = options.pageMaxBytes ?? settingsRegistry['hosts.pageMaxBytes'].default;
  let requests = 0;
  let waitUntil: Date | undefined;

  const noteRetry = (answer: Headers | undefined): boolean => {
    const seconds = Number(answer?.get('retry-after') ?? Number.NaN);
    if (!Number.isFinite(seconds) || seconds < 0) return false;
    const until = clock().getTime() + seconds * 1000;
    if (Number.isNaN(new Date(until).getTime())) return false;
    waitUntil = new Date(Math.max(bounded(until), waitUntil?.getTime() ?? 0));
    return true;
  };

  // The token works (a bad one gets 401), so the page is most likely gone, moved or restricted:
  // the link is what to look at, not the token setting.
  const missing = (page: PageRef, answered: string): MissingPage =>
    new MissingPage(
      'refused',
      `${name} shows no ${described(page)} to the Confluence token${answered}. The page may have been deleted or moved: check the link, or that the page is not restricted from the token's account.`,
    );

  const failure = (page: PageRef, error: unknown): HostFailure => {
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
        `${name} refused the Confluence token (${said}). Check the Confluence token in Settings → Trackers.`,
        tokenSetting,
      );
    }
    if (error.status === 404) return missing(page, ' (it answered 404)');
    return new HostFailure('failed', error.message);
  };

  const pageOf = (page: PageRef, content: unknown): Page => {
    const id = field(content, 'id');
    const own =
      typeof id === 'string' && contentId.test(id) ? id : page.kind === 'id' ? page.id : '';
    if (own === '' || field(content, 'type') !== 'page') {
      throw new HostFailure(
        'failed',
        `${name} answered ${described(page)} in a form wow cannot read; check the Confluence URL`,
      );
    }
    const version = field(field(content, 'version'), 'number');
    const webui = text(field(field(content, '_links'), 'webui'));
    const body = text(field(field(field(content, 'body'), 'view'), 'value'));
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > pageMaxBytes) {
      throw new MissingPage(
        'failed',
        `${name} answered ${described(page)} with ${bytes} bytes, more than the ${pageMaxBytes} wow keeps; open it on the host, or raise the limit in Settings → Hosts.`,
        'hosts.pageMaxBytes',
      );
    }
    return {
      id: own,
      title: text(field(content, 'title')),
      space: text(field(field(content, 'space'), 'key')),
      version:
        typeof version === 'number' && Number.isSafeInteger(version) && version > 0
          ? version
          : null,
      body,
      // The address is made from the stored site, never taken whole from the answer.
      url:
        hostLink(webui.startsWith('/') ? `${base}${webui}` : '') ??
        hostLink(`${base}/pages/viewpage.action?pageId=${own}`),
    };
  };

  return {
    kind: 'confluence',
    name,
    get requests() {
      return requests;
    },
    get waitUntil() {
      return waitUntil;
    },
    async read(page) {
      if (page.kind === 'id' && !contentId.test(page.id)) {
        throw new HostFailure(
          'failed',
          `${page.id} is not a Confluence page id, so it was not asked for`,
        );
      }
      const expand = 'expand=body.view,version,space';
      const url =
        page.kind === 'id'
          ? `${base}/rest/api/content/${page.id}?${expand}`
          : `${base}/rest/api/content?spaceKey=${encodeURIComponent(page.space)}&title=${encodeURIComponent(page.title)}&${expand}`;
      requests += 1;
      let body: unknown;
      try {
        body = (await getJsonAnswer(name, url, headers, requestOptions)).body;
      } catch (error) {
        throw failure(page, error);
      }
      if (page.kind === 'id') return pageOf(page, body);
      const results = field(body, 'results');
      if (!Array.isArray(results)) {
        throw new HostFailure(
          'failed',
          `${name} answered ${described(page)} in a form wow cannot read; check the Confluence URL`,
        );
      }
      const first: unknown = results[0];
      if (first === undefined) throw missing(page, '');
      return pageOf(page, first);
    },
  };
}
