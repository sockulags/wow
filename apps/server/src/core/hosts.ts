import { fileStatus, unitStatuses } from '@wow/agent-os';
import {
  hostReadId,
  type ChangeRequest,
  type DomainEvent,
  type HostError,
  type HostRead,
  type PlanIntent,
  type PlanUnit,
  type ServerCommand,
} from '@wow/contracts';
import { isDeepStrictEqual } from 'node:util';
import { CommandRejected, type ReadModel } from './orchestrator.js';

// Decides what the host poller's reads and the Follow switch change: the stored reads and change
// requests, and from them the unit statuses of followed plans (review loop spec 23, 24 and 31).
// Pure, like the rest of the orchestrator; the poller in apps/server/src/hosts does the asking.

type HostCommand = Extract<ServerCommand, { type: 'plan.follow' | 'hosts.sync' }>;

export const isHostCommand = (command: ServerCommand): command is HostCommand =>
  command.type === 'plan.follow' || command.type === 'hosts.sync';

// Shown on every unit that is not blocked while nothing was read from a host (spec 24).
export const notFollowedReason = 'This plan is not followed, so only its files are read';
export const notReadYetReason = 'Its pull requests have not been read from the host yet';

// The units as the files alone describe them, with one reason for the ones that are not blocked.
const fromFiles = (units: readonly PlanUnit[], reason: string): PlanUnit[] =>
  units.map((unit) => {
    const status = fileStatus(unit);
    return {
      ...unit,
      status,
      statusReason: status === 'blocked' ? (unit.blocked ?? '') : reason,
      changeRequestId: null,
    };
  });

// Whether the plan is read from the host: while the user follows it, and while a plan run is
// live on it (review loop spec, Decisions).
export const planIsOpen = (intent: PlanIntent, read: ReadModel): boolean =>
  intent.followed || read.livePlanRun(intent.id) !== undefined;

// An intent with the status of each unit decided: from the pull requests last read for it when
// it is open and a read has worked, otherwise from its files with the reason nothing more
// is known. A read that fails later keeps the statuses of the last one that worked.
export function withUnitStatus(
  intent: PlanIntent,
  read: HostRead | undefined,
  changeRequests: readonly ChangeRequest[],
  open: boolean = intent.followed,
): PlanIntent {
  if (!open) return { ...intent, units: fromFiles(intent.units, notFollowedReason) };
  if (!read || read.fetchedAt === null) {
    return {
      ...intent,
      units: fromFiles(intent.units, read?.error?.message ?? notReadYetReason),
    };
  }
  const own = new Set(read.changeRequestIds);
  const statuses = unitStatuses({
    intentId: intent.intentId,
    source: intent.source,
    spec: intent.spec,
    plan: intent.plan,
    units: intent.units,
    // Newest first, so the newest pull request is the one a unit links to.
    pullRequests: changeRequests
      .filter((request) => own.has(request.id))
      .toSorted((a, b) => b.number - a.number)
      .map((request) => ({
        id: request.id,
        label: `#${request.number}`,
        state: request.state,
        units: request.units,
      })),
  });
  return {
    ...intent,
    units: intent.units.map((unit, index) => {
      const derived = statuses[index];
      return derived
        ? {
            ...unit,
            status: derived.status,
            statusReason: derived.reason,
            changeRequestId: derived.pullRequestId,
          }
        : unit;
    }),
  };
}

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

export interface HostState {
  readonly reads: ReadonlyMap<string, HostRead>;
  readonly changeRequests: ReadonlyMap<string, ChangeRequest>;
}

export const hostState = (read: ReadModel, projectId: string): HostState => ({
  reads: new Map(read.hostReads(projectId).map((row) => [row.id, row])),
  changeRequests: new Map(read.changeRequests(projectId).map((row) => [row.id, row])),
});

// The events that take a project's host rows from `before` to `after`. A change request no read
// names any more goes, so the table holds only what wow follows.
export function hostEvents(projectId: string, before: HostState, after: HostState): DomainEvent[] {
  const named = new Set([...after.reads.values()].flatMap((row) => row.changeRequestIds));
  const kept = [...after.changeRequests.values()].filter((row) => named.has(row.id));
  const reads = [...after.reads.values()].filter(
    (row) => !isDeepStrictEqual(before.reads.get(row.id), row),
  );
  const changeRequests = kept.filter(
    (row) => !isDeepStrictEqual(before.changeRequests.get(row.id), row),
  );
  const removedReads = [...before.reads.keys()].filter((id) => !after.reads.has(id));
  const removedChangeRequests = [...before.changeRequests.keys()].filter(
    (id) => !kept.some((row) => row.id === id),
  );
  if (
    reads.length + changeRequests.length + removedReads.length + removedChangeRequests.length ===
    0
  ) {
    return [];
  }
  return [
    {
      kind: 'hosts.synced',
      aggregate: `hosts:${projectId}`,
      payload: { projectId, reads, removedReads, changeRequests, removedChangeRequests },
    },
  ];
}

// `plans.synced` for the intents whose rows differ from what is stored once their units carry
// the status the host rows give them.
function planEvents(
  stored: readonly PlanIntent[],
  intents: readonly PlanIntent[],
  after: HostState,
  open: (intent: PlanIntent) => boolean,
): DomainEvent[] {
  const current = new Map(stored.map((intent) => [intent.id, intent]));
  const requests = [...after.changeRequests.values()];
  const upserted = intents
    .map((intent) =>
      withUnitStatus(
        intent,
        after.reads.get(hostReadId('plan', intent.id)),
        requests,
        open(intent),
      ),
    )
    .filter((intent) => !isDeepStrictEqual(current.get(intent.id), intent));
  return upserted.length > 0
    ? [{ kind: 'plans.synced', aggregate: 'plans', payload: { upserted, removed: [] } }]
    : [];
}

export function decideHosts(command: HostCommand, read: ReadModel): DomainEvent[] {
  switch (command.type) {
    case 'plan.follow': {
      const stored = read.planIntents();
      const intent = stored.find((candidate) => candidate.id === command.planId);
      if (!intent) throw new CommandRejected('not_found', `No plan ${command.planId}`);
      if (intent.followed === command.followed) return [];
      const before = hostState(read, intent.projectId);
      const reads = new Map(before.reads);
      const next = { ...intent, followed: command.followed };
      // What was read for a plan is forgotten with the follow, so following again starts fresh.
      // A plan run that is live keeps the plan open until it ends.
      if (!planIsOpen(next, read)) reads.delete(hostReadId('plan', intent.id));
      const after = { reads, changeRequests: before.changeRequests };
      return [
        ...hostEvents(intent.projectId, before, after),
        ...planEvents(stored, [next], after, (plan) => planIsOpen(plan, read)),
      ];
    }
    case 'hosts.sync': {
      const { projectId } = command;
      if (!read.project(projectId))
        throw new CommandRejected('not_found', `No project ${projectId}`);
      const stored = read.planIntents().filter((intent) => intent.projectId === projectId);
      const followed = new Set(
        stored
          .filter((intent) => planIsOpen(intent, read))
          .map((intent) => hostReadId('plan', intent.id)),
      );
      const before = hostState(read, projectId);
      const reads = new Map(before.reads);
      for (const outcome of command.reads) {
        // A plan unfollowed or a run removed while the host was being asked is not stored again.
        const wanted =
          outcome.scope === 'plan'
            ? followed.has(outcome.id)
            : outcome.id.startsWith('run:') && read.run(outcome.id.slice('run:'.length));
        if (!wanted) continue;
        const last = before.reads.get(outcome.id);
        const base = {
          id: outcome.id,
          projectId,
          scope: outcome.scope,
          host: command.host,
          hostName: command.hostName || (last?.hostName ?? ''),
          branch: outcome.branch,
        };
        reads.set(
          outcome.id,
          outcome.result.ok
            ? {
                ...base,
                changeRequestIds: outcome.result.changeRequestIds,
                fetchedAt: command.at,
                error: null,
              }
            : {
                ...base,
                // The last data stays, with its time, beside the error (spec 31).
                branch: last?.branch ?? outcome.branch,
                changeRequestIds: last?.changeRequestIds ?? [],
                fetchedAt: last?.fetchedAt ?? null,
                error: sameError(last?.error, outcome.result.error)
                  ? last.error
                  : { ...outcome.result.error, at: command.at },
              },
        );
      }
      const changeRequests = new Map(before.changeRequests);
      for (const request of command.changeRequests) {
        if (request.projectId === projectId) changeRequests.set(request.id, request);
      }
      const after = { reads, changeRequests };
      return [
        ...hostEvents(projectId, before, after),
        ...planEvents(stored, stored, after, (plan) => planIsOpen(plan, read)),
      ];
    }
  }
}

// A plan run ended on a plan the user does not follow: the plan is no longer open, so what was
// read for it is forgotten and its units show what the files say, as after an unfollow.
export function closePlanEvents(planId: string, read: ReadModel): DomainEvent[] {
  const stored = read.planIntents();
  const intent = stored.find((candidate) => candidate.id === planId);
  if (!intent || intent.followed) return [];
  const before = hostState(read, intent.projectId);
  const reads = new Map(before.reads);
  reads.delete(hostReadId('plan', intent.id));
  const after = { reads, changeRequests: before.changeRequests };
  return [
    ...hostEvents(intent.projectId, before, after),
    ...planEvents(stored, [intent], after, () => false),
  ];
}

// `plans.sync`: the plans service read the files again. Each intent keeps its Follow switch and
// gets its unit statuses; what was read for a plan that is gone goes with it.
export function decidePlansSync(incoming: readonly PlanIntent[], read: ReadModel): DomainEvent[] {
  const stored = read.planIntents();
  const current = new Map(stored.map((intent) => [intent.id, intent]));
  const next = new Set(incoming.map((intent) => intent.id));
  if (next.size !== incoming.length) {
    throw new CommandRejected('rejected', 'Plan intent ids must be unique');
  }
  const states = new Map<string, HostState>();
  const stateOf = (projectId: string) => {
    const known = states.get(projectId) ?? hostState(read, projectId);
    states.set(projectId, known);
    return known;
  };
  const upserted = incoming
    .map((intent) => {
      const state = stateOf(intent.projectId);
      const kept = { ...intent, followed: current.get(intent.id)?.followed ?? false };
      return withUnitStatus(
        kept,
        state.reads.get(hostReadId('plan', intent.id)),
        [...state.changeRequests.values()],
        planIsOpen(kept, read),
      );
    })
    .filter((intent) => !isDeepStrictEqual(current.get(intent.id), intent));
  const removed = stored.filter((intent) => !next.has(intent.id));
  const events: DomainEvent[] = [];
  for (const projectId of new Set(removed.map((intent) => intent.projectId))) {
    const before = stateOf(projectId);
    const reads = new Map(before.reads);
    for (const intent of removed) reads.delete(hostReadId('plan', intent.id));
    events.push(...hostEvents(projectId, before, { reads, changeRequests: before.changeRequests }));
  }
  if (upserted.length > 0 || removed.length > 0) {
    events.push({
      kind: 'plans.synced',
      aggregate: 'plans',
      payload: { upserted, removed: removed.map((intent) => intent.id) },
    });
  }
  return events;
}
