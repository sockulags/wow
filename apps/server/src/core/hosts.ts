import {
  hostItemReadId,
  type DomainEvent,
  type HostError,
  type HostItemRead,
  type ServerCommand,
} from '@wow/contracts';
import { isDeepStrictEqual } from 'node:util';
import { CommandRejected, type ReadModel } from './orchestrator.js';

// Decides what the host lookup read about an item a chat thread links to. Pure, like the rest of
// the orchestrator; apps/server/src/hosts/lookup.ts does the asking.

// An error that repeats keeps the time it was first seen, so a host that stays down or is not
// set up does not store a new row at every round.
const sameError = (
  last: HostError | null | undefined,
  next: Omit<HostError, 'at'>,
): last is HostError =>
  last !== null &&
  last !== undefined &&
  last.kind === next.kind &&
  last.message === next.message &&
  last.setting === next.setting;

type HostItemReadCommand = Extract<ServerCommand, { type: 'hosts.itemRead' }>;

// Stores what the host lookup read about one item a chat thread links to (agent workbench spec
// 22, 23): the item and its time, or the reason beside the last data and its time. A read that
// changes nothing stores nothing.
export function decideHostItemRead(command: HostItemReadCommand, read: ReadModel): DomainEvent[] {
  const thread = read.thread(command.threadId);
  if (!thread) throw new CommandRejected('not_found', `No thread ${command.threadId}`);
  const id = hostItemReadId(thread.id, command.item);
  const last = read.hostItemRead(id);
  const base = {
    id,
    scope: 'thread' as const,
    threadId: thread.id,
    item: command.item,
    hostName: command.hostName || (last?.hostName ?? ''),
  };
  const next: HostItemRead = command.result.ok
    ? { ...base, data: command.result.data, fetchedAt: command.at, error: null }
    : {
        ...base,
        data: last?.data ?? null,
        fetchedAt: last?.fetchedAt ?? null,
        error: sameError(last?.error, command.result.error)
          ? last.error
          : { ...command.result.error, at: command.at },
      };
  if (isDeepStrictEqual(last, next)) return [];
  return [{ kind: 'hosts.itemRead', aggregate: id, payload: { read: next } }];
}
