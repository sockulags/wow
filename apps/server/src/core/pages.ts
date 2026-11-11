import {
  hostReadId,
  type DomainEvent,
  type PageLink,
  type PageRead,
  type ServerCommand,
} from '@wow/contracts';
import { isDeepStrictEqual } from 'node:util';
import { CommandRejected, type ReadModel } from './orchestrator.js';
import { sameError } from './tickets.js';

// Decides what the host poller read about the pages the texts of one project's runs link to
// (review loop spec 35). Pure, like the rest of the orchestrator; the poller in
// apps/server/src/hosts does the asking.

type PagesSync = Extract<ServerCommand, { type: 'pages.sync' }>;

export function decidePages(command: PagesSync, read: ReadModel): DomainEvent[] {
  const { projectId } = command;
  if (!read.project(projectId)) throw new CommandRejected('not_found', `No project ${projectId}`);
  const before = new Map(read.pageReads(projectId).map((row) => [row.id, row]));
  const reads: PageRead[] = [];
  for (const outcome of command.reads) {
    // A run removed while the host was being asked is not stored.
    const run = read.run(outcome.runId);
    if (!run || run.projectId !== projectId) continue;
    const id = hostReadId('run', run.id);
    const last = before.get(id);
    const lastPages = new Map((last?.pages ?? []).map((page) => [page.ref, page]));
    const pages: PageLink[] = outcome.links.map(({ ref, link, source, result }) => {
      const kept = lastPages.get(ref);
      if (result.ok)
        return { ref, link, source, page: result.page, fetchedAt: command.at, error: null };
      // The last page of the same link stays beside the error, with its time (spec 31).
      return {
        ref,
        link,
        source,
        page: kept?.page ?? null,
        fetchedAt: kept?.fetchedAt ?? null,
        error: sameError(kept?.error, result.error)
          ? kept.error
          : { ...result.error, at: command.at },
      };
    });
    const error = outcome.error;
    const next: PageRead = {
      id,
      projectId,
      runId: run.id,
      host: 'confluence',
      hostName: command.hostName || (last?.hostName ?? ''),
      pages,
      fetchedAt: error === null ? command.at : (last?.fetchedAt ?? null),
      error:
        error === null
          ? null
          : sameError(last?.error, error)
            ? last.error
            : { ...error, at: command.at },
    };
    if (!isDeepStrictEqual(last, next)) reads.push(next);
  }
  if (reads.length === 0) return [];
  return [{ kind: 'pages.synced', aggregate: `pages:${projectId}`, payload: { projectId, reads } }];
}
