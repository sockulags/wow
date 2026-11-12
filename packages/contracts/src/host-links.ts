import { z } from 'zod';
import {
  ChangeRequest,
  HostError,
  HostKind,
  HostReadScope,
  Issue,
  Page,
  Ticket,
  hostReadId,
} from './hosts.js';

// Links and references to the user's own hosts in chat messages (agent workbench spec 19 to
// 26). A link is recognised only against a site wow has settings and a token for: the server
// answers those sites as `HostLinkRules`, and the web app and the server both read a link with
// the functions here, so what shows as a chip is what the server will read. Pure: nothing here
// asks a host.

const Id = z.string().min(1);
const Timestamp = z.iso.datetime({ offset: true });

export const HostItemKind = z.enum(['changeRequest', 'issue', 'ticket', 'page']);
export type HostItemKind = z.infer<typeof HostItemKind>;

// One item a link or a bare reference names. GitHub numbers its issues and pull requests
// together, so a bare `#14` on GitHub is an `issue` until the read says which one it is.
export const HostItemRef = z.object({
  host: HostKind,
  kind: HostItemKind,
  // The site's web address, without a trailing slash, as `HostLinkSite.base` has it.
  site: z.string().min(1),
  // The repository path on a code host (`acme/tea`, `group/sub/app`); empty otherwise.
  path: z.string(),
  // The number, the Jira key, or how the link names a page (`id:<id>`, `title:<space>/<title>`).
  id: z.string().min(1),
  // The item on the host, for "Open on host" and Shift+Enter.
  url: z.string().min(1),
});
export type HostItemRef = z.infer<typeof HostItemRef>;

// A site wow may read links from: it has its settings and a token.
export const HostLinkSite = z.object({
  host: HostKind,
  // The web address links start with: https://github.com, a GitLab, Jira or Confluence site.
  base: z.string().min(1),
  // As the user knows it, such as github.com.
  name: z.string(),
});
export type HostLinkSite = z.infer<typeof HostLinkSite>;

// What a thread's links are recognised against (spec 20, 24): the sites, and for bare
// references the repository and Jira project key of the thread's project, when it has them.
export const HostLinkRules = z.object({
  sites: z.array(HostLinkSite),
  repository: z
    .object({ host: z.enum(['github', 'gitlab']), base: z.string().min(1), path: z.string() })
    .nullable(),
  jiraKey: z.string().nullable(),
});
export type HostLinkRules = z.infer<typeof HostLinkRules>;

export const noHostLinkRules: HostLinkRules = { sites: [], repository: null, jiraKey: null };

// What a read found, by what the item turned out to be.
export const HostItemData = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('changeRequest'),
    changeRequest: ChangeRequest.omit({ id: true, projectId: true }),
  }),
  z.object({ kind: z.literal('issue'), issue: Issue }),
  z.object({ kind: z.literal('ticket'), ticket: Ticket }),
  z.object({ kind: z.literal('page'), page: Page }),
]);
export type HostItemData = z.infer<typeof HostItemData>;

// What was last read about one item a thread links to (spec 22): stored, so a reload or a
// restart shows it with its time. A failed read keeps the last data and its time (spec 23).
export const HostItemRead = z.object({
  // `thread:<threadId>:<hostItemKey>`.
  id: Id,
  scope: HostReadScope.extract(['thread']),
  threadId: Id,
  item: HostItemRef,
  hostName: z.string(),
  data: HostItemData.nullable(),
  fetchedAt: Timestamp.nullable(),
  error: HostError.nullable(),
});
export type HostItemRead = z.infer<typeof HostItemRead>;

export const hostItemKey = (item: HostItemRef): string =>
  [item.host, item.site, item.path, item.kind, item.id].join('|');

export const hostItemReadId = (threadId: string, item: HostItemRef): string =>
  `${hostReadId('thread', threadId)}:${hostItemKey(item)}`;

// `hosts.lookup`: the thread's rules, and with `ref` (a web address or a bare reference) the item
// it names. `read`: `open` reads the item when it was never read in this thread and answers the
// stored read otherwise; `refresh` reads it again. Without `read` nothing is asked of the host.
export const HostLookupParams = z.object({
  threadId: Id,
  ref: z.string().min(1).max(2000).optional(),
  read: z.enum(['open', 'refresh']).optional(),
});
export type HostLookupParams = z.infer<typeof HostLookupParams>;

export const HostLookupResult = z.object({
  rules: HostLinkRules,
  // Null when the ref names nothing on a site wow may read: it stays a plain link.
  item: HostItemRef.nullable(),
  read: HostItemRead.nullable(),
});
export type HostLookupResult = z.infer<typeof HostLookupResult>;

const number = /^[1-9]\d{0,9}$/;
const jiraKey = /^[A-Z][A-Z0-9_]*-[1-9]\d{0,9}$/;
const contentId = /^[1-9]\d*$/;

const trimmed = (base: string): string => base.trim().replace(/\/+$/, '');

// The web address GitHub serves for an API address: api.github.com and api.<name>.ghe.com have
// their own host, Enterprise Server serves its API under /api/v3.
export function gitHubWebBase(apiUrl: string): string {
  const base = trimmed(apiUrl);
  if (!URL.canParse(base)) return base;
  const url = new URL(base);
  if (url.host === 'api.github.com' || /^api\.[a-z0-9-]+\.ghe\.com$/.test(url.host)) {
    return `${url.protocol}//${url.host.slice('api.'.length)}`;
  }
  return base.replace(/\/api(?:\/v3)?$/, '');
}

// The parts of a link's path below a site, or undefined when it is not on that site.
function below(link: URL, base: string): string[] | undefined {
  if (!URL.canParse(base)) return undefined;
  const site = new URL(base);
  if (link.protocol !== site.protocol || link.host !== site.host) return undefined;
  const prefix = site.pathname.replace(/\/+$/, '');
  if (prefix !== '' && !link.pathname.startsWith(`${prefix}/`)) return undefined;
  return link.pathname
    .slice(prefix.length)
    .split('/')
    .filter((part) => part !== '');
}

const decoded = (part: string): string | undefined => {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return undefined;
  }
};

function onSite(link: URL, site: HostLinkSite): HostItemRef | undefined {
  const parts = below(link, site.base);
  if (!parts) return undefined;
  const base = trimmed(site.base);
  const of = (kind: HostItemKind, path: string, id: string, url: string): HostItemRef => ({
    host: site.host,
    kind,
    site: base,
    path,
    id,
    url,
  });
  if (site.host === 'github') {
    const [owner, repo, what, n] = parts;
    if (!owner || !repo || !n || !number.test(n)) return undefined;
    const path = `${owner}/${repo}`;
    if (what === 'pull' || what === 'pulls') {
      return of('changeRequest', path, n, `${base}/${path}/pull/${n}`);
    }
    if (what === 'issues') return of('issue', path, n, `${base}/${path}/issues/${n}`);
    return undefined;
  }
  if (site.host === 'gitlab') {
    const dash = parts.indexOf('-');
    if (dash < 2) return undefined;
    const path = parts.slice(0, dash).join('/');
    const what = parts[dash + 1];
    const n = parts[dash + 2] ?? '';
    if (!number.test(n)) return undefined;
    if (what === 'merge_requests') {
      return of('changeRequest', path, n, `${base}/${path}/-/merge_requests/${n}`);
    }
    if (what === 'issues') return of('issue', path, n, `${base}/${path}/-/issues/${n}`);
    return undefined;
  }
  if (site.host === 'jira') {
    const [what, key] = parts;
    if (what !== 'browse' || parts.length !== 2 || !key || !jiraKey.test(key)) return undefined;
    return of('ticket', '', key, `${base}/browse/${key}`);
  }
  // Confluence: `/pages/viewpage.action?pageId=<id>`, `/spaces/<space>/pages/<id>/…` (Cloud) or
  // `/display/<space>/<title>` (Server and Data Center).
  if (parts[0] === 'pages' && parts[1] === 'viewpage.action' && parts.length === 2) {
    const id = link.searchParams.get('pageId') ?? '';
    return contentId.test(id) ? of('page', '', `id:${id}`, link.href) : undefined;
  }
  if (parts[0] === 'spaces' && parts[2] === 'pages' && contentId.test(parts[3] ?? '')) {
    return of('page', '', `id:${parts[3] ?? ''}`, link.href);
  }
  if (parts[0] === 'display' && parts.length === 3) {
    const space = decoded(parts[1] ?? '');
    const title = decoded(parts[2] ?? '');
    if (space && title && title.trim() !== '')
      return of('page', '', `title:${space}/${title}`, link.href);
  }
  return undefined;
}

// The item a web address names on one of the sites, or undefined: a link to anywhere else, or to
// something wow cannot read (a commit, a board, a space), stays a plain link (spec 23).
export function recogniseHostLink(link: string, rules: HostLinkRules): HostItemRef | undefined {
  const text = link.trim();
  if (!URL.canParse(text)) return undefined;
  const url = new URL(text);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  // A user name and password in the address are never part of what is read.
  if (url.username !== '' || url.password !== '') return undefined;
  for (const site of rules.sites) {
    const found = onSite(url, site);
    if (found) return found;
  }
  return undefined;
}

// One bare reference in a text, where it is.
export interface HostRefMatch {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly item: HostItemRef;
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The bare references a text holds (spec 24): `DEMO-42` for the project's Jira key, `#14` for its
// repository (and `!7` on GitLab), in order. Nothing without a project's key or repository, and
// nothing inside a word, an address or a path (`v1#2`, `a/#3`, `&#39;`).
export function bareHostRefs(text: string, rules: HostLinkRules): HostRefMatch[] {
  const patterns: string[] = [];
  const jiraSite = rules.sites.find((site) => site.host === 'jira');
  const key = rules.jiraKey?.trim() ?? '';
  if (jiraSite && /^[A-Z][A-Z0-9_]*$/.test(key)) patterns.push(`${escaped(key)}-[1-9]\\d{0,9}`);
  const repository = rules.repository;
  if (repository)
    patterns.push(repository.host === 'gitlab' ? '[#!][1-9]\\d{0,9}' : '#[1-9]\\d{0,9}');
  if (patterns.length === 0) return [];
  const search = new RegExp(`(?<![\\w&/#!.:-])(?:${patterns.join('|')})(?![\\w-])`, 'g');
  const found: HostRefMatch[] = [];
  for (const match of text.matchAll(search)) {
    const written = match[0];
    const start = match.index;
    const item = bareItem(written, rules);
    if (item) found.push({ start, end: start + written.length, text: written, item });
  }
  return found;
}

function bareItem(written: string, rules: HostLinkRules): HostItemRef | undefined {
  const { repository } = rules;
  if ((written.startsWith('#') || written.startsWith('!')) && repository) {
    const n = written.slice(1);
    const base = trimmed(repository.base);
    if (repository.host === 'github') {
      return {
        host: 'github',
        kind: 'issue',
        site: base,
        path: repository.path,
        id: n,
        url: `${base}/${repository.path}/issues/${n}`,
      };
    }
    const merge = written.startsWith('!');
    return {
      host: 'gitlab',
      kind: merge ? 'changeRequest' : 'issue',
      site: base,
      path: repository.path,
      id: n,
      url: `${base}/${repository.path}/-/${merge ? 'merge_requests' : 'issues'}/${n}`,
    };
  }
  const site = rules.sites.find((candidate) => candidate.host === 'jira');
  if (!site || !jiraKey.test(written)) return undefined;
  const base = trimmed(site.base);
  return {
    host: 'jira',
    kind: 'ticket',
    site: base,
    path: '',
    id: written,
    url: `${base}/browse/${written}`,
  };
}

// What "Open issue, PR or ticket…" and `hosts.lookup` take: a web address, or one bare reference
// and nothing else.
export function recogniseHostRef(text: string, rules: HostLinkRules): HostItemRef | undefined {
  const value = text.trim();
  if (/^https?:\/\//i.test(value)) return recogniseHostLink(value, rules);
  const [only] = bareHostRefs(value, rules);
  return only && only.start === 0 && only.end === value.length ? only.item : undefined;
}

export const sameHostItem = (a: HostItemRef, b: HostItemRef): boolean =>
  hostItemKey(a) === hostItemKey(b);
