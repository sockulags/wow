import {
  HostItemData,
  hostItemReadId,
  recogniseHostRef,
  type HostError,
  type HostItemRead,
  type HostItemRef,
  type HostLookupParams,
  type HostLookupResult,
} from '@wow/contracts';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Engine } from '../core/engine.js';
import type { Db } from '../db/database.js';
import { hostItemReads, threads } from '../db/schema.js';
import type { Logger } from '../logger.js';
import { RpcFault } from '../rpc/router.js';
import type { SettingsService } from '../settings/service.js';
import type { LinkHosts } from '../trackers/service.js';
import { HostFailure, type FoundChangeRequest, type PageRef } from './adapter.js';
import { createConfluenceHost } from './confluence.js';
import { createGitHubHost } from './github.js';
import { createGitLabHost } from './gitlab.js';
import { createJiraHost } from './jira.js';

// The items a chat thread links to (agent workbench spec 20 to 26): which links the thread may
// read, and one item's read when its tab opens or on Refresh now. Nothing here runs on a timer
// (spec 22): a chat's links are many and mostly looked at once. A token goes only to the site
// the user stored it for, because an item is read only when it is on one of the thread's sites
// (recogniseHostRef against `LinkHosts.rules`), and each read is built with that site's token.
// What a read finds is stored for the thread and shown to the user only; it never goes into a
// prompt (spec 26).

export interface HostLookupDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly settings: SettingsService;
  readonly logger: Logger;
  // 'stored' gives the rules without reading a token; 'read' is for asking a host.
  readonly linkHosts: (projectId: string | null, tokens: 'read' | 'stored') => Promise<LinkHosts>;
  readonly clock?: () => Date;
  readonly fetch?: typeof fetch;
}

type ReadOutcome = { ok: true; data: HostItemData } | { ok: false; error: Omit<HostError, 'at'> };

const failed = (message: string): ReadOutcome => ({
  ok: false,
  error: { kind: 'failed', message, setting: null },
});

export class HostLookup {
  readonly #deps: HostLookupDeps;
  readonly #clock: () => Date;
  // One read per item at a time, so a double press asks the host once.
  readonly #inFlight = new Map<string, Promise<HostItemRead | undefined>>();

  constructor(deps: HostLookupDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? (() => new Date());
  }

  // Settles once no read is on its way; for tests.
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.all(this.#inFlight.values());
  }

  async lookup(params: HostLookupParams): Promise<HostLookupResult> {
    const thread = this.#deps.db
      .select()
      .from(threads)
      .where(eq(threads.id, params.threadId))
      .get();
    if (!thread) throw new RpcFault('not_found', `No thread ${params.threadId}`);
    // The assistant sees no host data (spec 26 and the assistant's boundaries).
    if (thread.kind === 'assistant') {
      throw new RpcFault('rejected', "The assistant's thread reads nothing from a host");
    }
    // Every thread view asks for the rules; the tokens are read only when a host is asked.
    const { rules } = await this.#deps.linkHosts(thread.projectId, 'stored');
    const item = params.ref === undefined ? undefined : recogniseHostRef(params.ref, rules);
    if (!item) return { rules, item: null, read: null };
    const id = hostItemReadId(thread.id, item);
    const stored = this.#stored(id);
    // A stored read without a time is a failed first read: opening asks the host again.
    if (params.read === undefined || (params.read === 'open' && stored?.fetchedAt)) {
      return { rules, item, read: stored ?? null };
    }
    let running = this.#inFlight.get(id);
    if (!running) {
      running = this.#deps
        .linkHosts(thread.projectId, 'read')
        .then((hosts) => this.#read(thread.id, item, hosts))
        .finally(() => this.#inFlight.delete(id));
      this.#inFlight.set(id, running);
    }
    return { rules, item, read: (await running) ?? null };
  }

  #stored(id: string): HostItemRead | undefined {
    return this.#deps.db.select().from(hostItemReads).where(eq(hostItemReads.id, id)).get();
  }

  async #read(
    threadId: string,
    item: HostItemRef,
    hosts: LinkHosts,
  ): Promise<HostItemRead | undefined> {
    const { name, outcome } = await this.#ask(item, hosts);
    const parsed = outcome.ok ? HostItemData.safeParse(outcome.data) : undefined;
    const result: ReadOutcome =
      parsed && !parsed.success
        ? failed(`${name || 'The host'} answered in a form wow cannot read`)
        : outcome;
    this.#deps.engine.dispatch(`host-item:${randomUUID()}`, {
      type: 'hosts.itemRead',
      threadId,
      at: this.#clock().toISOString(),
      item,
      hostName: name,
      result,
    });
    if (!result.ok) {
      this.#deps.logger.info('a linked host item could not be read', {
        host: item.host,
        kind: item.kind,
        reason: result.error.kind,
      });
    }
    return this.#stored(hostItemReadId(threadId, item));
  }

  async #ask(item: HostItemRef, hosts: LinkHosts): Promise<{ name: string; outcome: ReadOutcome }> {
    const { settings } = this.#deps;
    const options = {
      timeoutMs: settings.get('trackers.requestTimeoutMs'),
      listFallbackCount: settings.get('hosts.listFallbackCount'),
      longestWaitMs: settings.get('hosts.longestWaitMinutes') * 60_000,
      pageMaxBytes: settings.get('hosts.pageMaxBytes'),
      clock: this.#clock,
      ...(this.#deps.fetch ? { fetch: this.#deps.fetch } : {}),
    };
    const number = Number(item.id);
    try {
      switch (item.host) {
        case 'github': {
          const host = hosts.github;
          if (!host) return { name: '', outcome: gone('GitHub') };
          const [owner = '', repo = ''] = item.path.split('/');
          const adapter = createGitHubHost(
            { baseUrl: host.baseUrl, token: host.token, owner, repo, labels: [] },
            host.name,
            options,
          );
          if (item.kind === 'issue' && adapter.readIssue) {
            const issue = await adapter.readIssue(number);
            if (issue !== 'changeRequest') {
              return { name: host.name, outcome: { ok: true, data: { kind: 'issue', issue } } };
            }
          }
          const changeRequest = await adapter.read(unread(number, item.url));
          return {
            name: host.name,
            outcome: { ok: true, data: { kind: 'changeRequest', changeRequest } },
          };
        }
        case 'gitlab': {
          const host = hosts.gitlab;
          if (!host) return { name: '', outcome: gone('GitLab') };
          const adapter = createGitLabHost(
            { baseUrl: host.baseUrl, token: host.token, projectPath: item.path },
            host.name,
            options,
          );
          if (item.kind === 'issue' && adapter.readIssue) {
            const issue = await adapter.readIssue(number);
            if (issue !== 'changeRequest') {
              return { name: host.name, outcome: { ok: true, data: { kind: 'issue', issue } } };
            }
          }
          const changeRequest = await adapter.read(unread(number, item.url));
          return {
            name: host.name,
            outcome: { ok: true, data: { kind: 'changeRequest', changeRequest } },
          };
        }
        case 'jira': {
          const host = hosts.jira;
          if (!host) return { name: '', outcome: gone('Jira') };
          const ticket = await createJiraHost(host.signIn, host.name, options).read(item.id);
          return { name: host.name, outcome: { ok: true, data: { kind: 'ticket', ticket } } };
        }
        case 'confluence': {
          const host = hosts.confluence;
          if (!host) return { name: '', outcome: gone('Confluence') };
          const page = await createConfluenceHost(host.signIn, host.name, options).read(
            pageRef(item.id),
          );
          return { name: host.name, outcome: { ok: true, data: { kind: 'page', page } } };
        }
      }
    } catch (error) {
      const name = hosts[item.host]?.name ?? '';
      if (error instanceof HostFailure) {
        return {
          name,
          outcome: {
            ok: false,
            error: { kind: error.kind, message: error.message, setting: error.setting },
          },
        };
      }
      return { name, outcome: failed(error instanceof Error ? error.message : String(error)) };
    }
  }
}

// A change request known only by its number: the adapter reads the rest.
const unread = (number: number, url: string): FoundChangeRequest => ({
  number,
  title: '',
  url,
  state: 'open',
  draft: false,
  mergedAt: null,
  units: [],
});

// The rules only name sites with a token, so a site is missing here only when the settings
// changed between recognising the link and reading it.
const gone = (label: string) => failed(`${label} is not set up for this thread any more`);

function pageRef(id: string): PageRef {
  if (id.startsWith('id:')) return { kind: 'id', id: id.slice('id:'.length) };
  const named = id.slice('title:'.length);
  const slash = named.indexOf('/');
  return { kind: 'title', space: named.slice(0, slash), title: named.slice(slash + 1) };
}
