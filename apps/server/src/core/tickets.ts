import {
  hostReadId,
  type DomainEvent,
  type HostError,
  type ServerCommand,
  type TicketRead,
} from '@wow/contracts';
import { isDeepStrictEqual } from 'node:util';
import { CommandRejected, type ReadModel } from './orchestrator.js';

// Decides what the host poller read about the tickets of one project's runs (review loop spec
// 33). Pure, like the rest of the orchestrator; the poller in apps/server/src/hosts does the
// asking.

type TicketsSync = Extract<ServerCommand, { type: 'tickets.sync' }>;

// An error that repeats keeps the time it was first seen, so a host that stays down or is not
// set up does not store a new row at every round.
export const sameError = (
  last: HostError | null | undefined,
  next: Omit<HostError, 'at'>,
): last is HostError =>
  last !== null &&
  last !== undefined &&
  last.kind === next.kind &&
  last.message === next.message &&
  last.setting === next.setting;

export function decideTickets(command: TicketsSync, read: ReadModel): DomainEvent[] {
  const { projectId } = command;
  if (!read.project(projectId)) throw new CommandRejected('not_found', `No project ${projectId}`);
  const before = new Map(read.ticketReads(projectId).map((row) => [row.id, row]));
  const reads: TicketRead[] = [];
  for (const outcome of command.reads) {
    // A run removed while the host was being asked is not stored.
    const run = read.run(outcome.runId);
    if (!run || run.projectId !== projectId) continue;
    const id = hostReadId('run', run.id);
    const last = before.get(id);
    const base = {
      id,
      projectId,
      runId: run.id,
      host: 'jira' as const,
      hostName: command.hostName || (last?.hostName ?? ''),
      key: outcome.key,
      source: outcome.source,
    };
    // The last ticket stays beside an error only while it is the same ticket (spec 31).
    const kept = last && last.key === outcome.key ? last : undefined;
    const next: TicketRead = outcome.result.ok
      ? { ...base, ticket: outcome.result.ticket, fetchedAt: command.at, error: null }
      : {
          ...base,
          ticket: kept?.ticket ?? null,
          fetchedAt: kept?.fetchedAt ?? null,
          error: sameError(last?.error, outcome.result.error)
            ? last.error
            : { ...outcome.result.error, at: command.at },
        };
    if (!isDeepStrictEqual(last, next)) reads.push(next);
  }
  if (reads.length === 0) return [];
  return [
    { kind: 'tickets.synced', aggregate: `tickets:${projectId}`, payload: { projectId, reads } },
  ];
}
