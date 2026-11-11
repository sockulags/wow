import {
  changeRequestRef,
  isCardTrigger,
  isEventTrigger,
  isLiveRunState,
  projectCodeHost,
  triggerEventLabel,
  type AppNotification,
  type CalendarItem,
  type CardOccurrence,
  type CardState,
  type CardTrigger,
  type ChangeRequest,
  type DomainEvent,
  type EventTrigger,
  type ReviewComment,
  type RunEvent,
  type ServerCommand,
  type Trigger,
  type TriggerEvent,
  type WorkflowRun,
  type WorkingCopy,
} from '@wow/contracts';
import { missedTriggerOutcome } from '@wow/workflow-engine';
import { startingBetween, type Occurrence } from '../scheduler/occurrences.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolveStored } from '../settings/service.js';
import { CommandRejected, type DecideContext, type ReadModel } from './orchestrator.js';
import {
  isRepeating,
  liveRunOf,
  nextOccurrence,
  scheduleOf,
  takenDays,
  type RepeatingCard,
} from './series.js';
import {
  globalSettingOn,
  notificationsEnabled,
  runInput,
  runPath,
  startRunEvents,
} from './workflows.js';

// Decisions for triggers. A card trigger (spec 8, 12, 13): a local card with a workflow and a
// project has one trigger at its start time; the scheduler fires it into a workflow run, and the
// run then drives the card's state. An event trigger (review loop spec 48 to 53): a project, an
// event and a workflow; a run starts when a read from the host first shows the event on a pull
// request wow follows.

type TriggerCommand = Extract<
  ServerCommand,
  {
    type:
      | 'trigger.fire'
      | 'trigger.applyMissed'
      | 'card.runNow'
      | 'trigger.create'
      | 'trigger.setEnabled'
      | 'trigger.delete';
  }
>;

export const isTriggerCommand = (command: ServerCommand): command is TriggerCommand =>
  command.type.startsWith('trigger.') || command.type === 'card.runNow';

// One trigger per card, so moving the card moves the same row.
export const triggerIdFor = (cardId: string): string => `${cardId}:trigger`;

// What a card trigger's row holds in the columns only event triggers use.
const noEventFields = { projectId: null, event: null, enabled: null, createdAt: null };

const triggerSet = (trigger: Trigger): DomainEvent => ({
  kind: 'trigger.set',
  aggregate: trigger.id,
  payload: trigger,
});

const cardState = (
  card: CalendarItem,
  state: CardState,
  runId: string | null,
  context: DecideContext,
): DomainEvent[] =>
  card.state === state && card.runId === runId
    ? []
    : [
        {
          kind: 'card.stateChanged',
          aggregate: card.id,
          payload: { cardId: card.id, state, runId, updatedAt: context.now },
        },
      ];

const notification = (read: ReadModel, context: DecideContext, entry: AppNotification) =>
  notificationsEnabled(read, context)
    ? [{ kind: 'notification.sent', aggregate: entry.id, payload: entry } satisfies DomainEvent]
    : [];

// Brings a card's trigger in line with the card after it was created, moved or given another
// workflow or project. A card that already started a run keeps its fired trigger. A start time
// that has already passed gives a missed trigger with "Run now" rather than an immediate run.
export function cardTriggerEvents(card: CalendarItem, read: ReadModel, context: DecideContext) {
  if (card.source !== 'local') return [];
  if (isRepeating(card)) return seriesTriggerEvents(card, read, context);
  const existing = read.trigger(triggerIdFor(card.id));
  if (card.runId !== null) {
    // A card that stopped repeating may still hold a trigger for a later occurrence. It goes
    // back to the fired trigger of the run it carries, as it was before the card repeated.
    if (existing?.state !== 'scheduled') return [];
    const ran =
      existing.runId === null
        ? undefined
        : read.cardOccurrences(card.id).find((occurrence) => occurrence.runId === existing.runId);
    return [
      triggerSet(
        existing.runId === null
          ? { ...existing, state: 'cancelled', offerRunNow: false }
          : { ...existing, state: 'fired', runAt: ran?.start ?? card.start, offerRunNow: false },
      ),
    ];
  }
  const events: DomainEvent[] = [];
  let next: Trigger | undefined;
  let state: CardState = 'scheduled';
  if (card.workflowId !== null && card.projectId !== null) {
    const due = Date.parse(card.start) <= Date.parse(context.now);
    next = {
      ...noEventFields,
      id: triggerIdFor(card.id),
      kind: 'card',
      calendarItemId: card.id,
      workflowId: card.workflowId,
      runAt: card.start,
      zone: card.zone,
      state: due ? 'missed' : 'scheduled',
      runId: null,
      offerRunNow: due,
    };
    state = due ? 'missed' : 'scheduled';
  } else if (existing && (existing.state === 'scheduled' || existing.state === 'missed')) {
    next = { ...existing, state: 'cancelled', offerRunNow: false };
  }
  if (next && !isDeepStrictEqual(next, existing)) events.push(triggerSet(next));
  events.push(...cardState(card, state, null, context));
  return events;
}

// A repeating card's one trigger waits for the next occurrence that was neither skipped nor
// reached (recurring cards spec 6, 10). Occurrences already past when the card is made or
// changed are not run: the card is for what comes. After the last occurrence nothing waits.
function seriesTriggerEvents(
  card: RepeatingCard,
  read: ReadModel,
  context: DecideContext,
  alsoTaken: ReadonlySet<string> = new Set(),
  runId?: string,
  handled = false,
): DomainEvent[] {
  const existing = read.trigger(triggerIdFor(card.id));
  const lastRunId = runId ?? existing?.runId ?? null;
  let next: Trigger | undefined;
  const upcoming =
    card.workflowId !== null && card.projectId !== null
      ? nextOccurrence(card, read, Date.parse(context.now), alsoTaken)
      : undefined;
  if (upcoming && card.workflowId !== null) {
    next = {
      ...noEventFields,
      id: triggerIdFor(card.id),
      kind: 'card',
      calendarItemId: card.id,
      workflowId: card.workflowId,
      runAt: upcoming.start,
      zone: card.zone,
      state: 'scheduled',
      runId: lastRunId,
      offerRunNow: false,
    };
  } else if (existing && (existing.state === 'scheduled' || existing.state === 'missed')) {
    next = {
      ...existing,
      runId: lastRunId,
      state: lastRunId === null ? 'cancelled' : 'fired',
      offerRunNow: false,
    };
  } else if (existing && runId !== undefined) {
    next = { ...existing, runId };
  }
  const events: DomainEvent[] = [];
  if (next && !isDeepStrictEqual(next, existing)) events.push(triggerSet(next));
  // A card that has run shows how its newest run went; one that has not waits for its first,
  // and once every remaining occurrence was skipped it is finished as a last occurrence leaves it.
  // An occurrence this decision handled (missed, failed, started) has set the state already.
  if (handled) return events;
  if (card.runId === null && runId === undefined && upcoming) {
    events.push(...cardState(card, 'scheduled', null, context));
  } else if (
    card.runId === null &&
    runId === undefined &&
    card.state === 'scheduled' &&
    card.workflowId !== null &&
    card.projectId !== null
  ) {
    events.push(...cardState(card, 'done', null, context));
  }
  return events;
}

// What deleting a card does to its run and trigger. A live run needs the user's answer first.
export function cardDeleteEvents(
  card: CalendarItem,
  stopRun: boolean | undefined,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const events: DomainEvent[] = [];
  const run = liveRunOf(card, read);
  if (run) {
    if (stopRun === undefined) {
      throw new CommandRejected(
        'conflict',
        `The workflow run of "${card.title}" is ${run.state === 'waiting' ? 'waiting for you' : 'running'}; say whether to stop it`,
        { runId: run.id },
      );
    }
    if (stopRun) events.push(...runInput('card.delete', run.id, { type: 'stop' }, read, context));
  }
  const trigger = read.trigger(triggerIdFor(card.id));
  if (trigger && (trigger.state === 'scheduled' || trigger.state === 'missed')) {
    events.push(triggerSet({ ...trigger, state: 'cancelled', offerRunNow: false }));
  }
  return events;
}

function requireTrigger(read: ReadModel, id: string, runAt: string): CardTrigger | undefined {
  const trigger = read.trigger(id);
  // Fired, missed or cancelled meanwhile, or the card moved after the scheduler looked.
  if (!trigger || !isCardTrigger(trigger)) return undefined;
  if (trigger.state !== 'scheduled' || trigger.runAt !== runAt) return undefined;
  return trigger;
}

// Starts the card's run for a due trigger. A run that cannot start (its workflow or a provider
// instance is gone) fails the card instead of retrying on every tick.
function fire(
  cause: string,
  trigger: CardTrigger,
  runId: string,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const card = read.calendarItem(trigger.calendarItemId);
  if (!card || card.source !== 'local' || card.workflowId === null || card.projectId === null) {
    return [triggerSet({ ...trigger, state: 'cancelled', offerRunNow: false })];
  }
  let started: DomainEvent[];
  try {
    started = startRunEvents(
      cause,
      {
        runId,
        workflowId: card.workflowId,
        projectId: card.projectId,
        calendarItemId: card.id,
        backlogItemId: card.backlogItemId,
      },
      read,
      context,
    );
  } catch (error) {
    if (!(error instanceof CommandRejected)) throw error;
    const id = `${trigger.id}:${trigger.runAt}:failed`;
    return [
      triggerSet({ ...trigger, state: 'fired', runId: null, offerRunNow: false }),
      ...cardState(card, 'failed', null, context),
      ...notification(read, context, {
        id,
        at: context.now,
        kind: 'failed',
        title: 'Trigger failed',
        body: `${card.title}: ${error.message}`,
        path: '/calendar',
        runId: null,
        calendarItemId: card.id,
      }),
    ];
  }
  const workflow = read.workflow(card.workflowId);
  return [
    triggerSet({ ...trigger, state: 'fired', runId, offerRunNow: false }),
    ...started,
    ...notification(read, context, {
      id: `${runId}:started`,
      at: context.now,
      kind: 'started',
      title: 'Workflow run started',
      body: [workflow?.name, card.title].filter(Boolean).join(' · '),
      path: runPath(runId),
      runId,
      calendarItemId: card.id,
    }),
  ];
}

const occurrenceRecorded = (
  card: CalendarItem,
  occurrence: Occurrence,
  outcome: CardOccurrence['outcome'],
  context: DecideContext,
  extra: Partial<Pick<CardOccurrence, 'runId' | 'reason' | 'offerRunNow'>> = {},
): DomainEvent => ({
  kind: 'card.occurrenceRecorded',
  aggregate: card.id,
  payload: {
    cardId: card.id,
    occurrence: {
      ...occurrence,
      outcome,
      runId: extra.runId ?? null,
      reason: extra.reason ?? null,
      offerRunNow: extra.offerRunNow ?? false,
      at: context.now,
    },
  },
});

// What a repeating card's trigger does when it comes due (recurring cards spec 5 to 8). The
// occurrences between the trigger's time and now that were neither skipped nor reached are
// due; when there are several (the app was closed, paused or asleep), only the latest is
// handled as `mode` says and the older ones are recorded as missed. A latest occurrence whose
// card still has a run going starts nothing. Then the trigger waits for the next occurrence.
function fireSeries(
  cause: string,
  trigger: CardTrigger,
  card: RepeatingCard,
  runId: string,
  mode: 'run' | 'mark' | 'skip',
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const taken = takenDays(card, read);
  const due = startingBetween(
    scheduleOf(card),
    Date.parse(trigger.runAt) - 1,
    Date.parse(context.now),
    (occurrence) => !taken.has(occurrence.date),
  );
  const latest = due.at(-1);
  // Only the newest missed occurrence offers "Run now" (spec 8): an older offer is withdrawn
  // once a later occurrence is reached.
  const withdrawn: DomainEvent[] = latest
    ? read
        .cardOccurrences(card.id)
        .filter((record) => record.offerRunNow)
        .map((record) => ({
          kind: 'card.occurrenceRecorded',
          aggregate: card.id,
          payload: { cardId: card.id, occurrence: { ...record, offerRunNow: false } },
        }))
    : [];
  const events: DomainEvent[] = [
    ...withdrawn,
    ...due
      .slice(0, -1)
      .map((occurrence) => occurrenceRecorded(card, occurrence, 'missed', context)),
  ];
  const reached = new Set(due.map((occurrence) => occurrence.date));
  let started: string | undefined;
  if (latest && mode !== 'run') {
    events.push(
      occurrenceRecorded(card, latest, 'missed', context, { offerRunNow: mode === 'mark' }),
      ...cardState(card, 'missed', card.runId, context),
    );
  } else if (latest) {
    const busy = liveRunOf(card, read);
    if (busy) {
      const reason = `The run of an earlier occurrence (${busy.occurrence?.date ?? busy.id}) was still ${busy.state === 'waiting' ? 'waiting for you' : 'running'}, so this one started nothing.`;
      events.push(
        occurrenceRecorded(card, latest, 'skipped', context, { reason }),
        ...notification(read, context, {
          id: `${card.id}:${latest.date}:skipped`,
          at: context.now,
          kind: 'skipped',
          title: 'Occurrence skipped',
          body: `${card.title} · ${latest.date}: ${reason}`,
          path: `/calendar?item=${encodeURIComponent(card.id)}`,
          runId: busy.id,
          calendarItemId: card.id,
        }),
      );
    } else {
      const fired = startSeriesRun(cause, card, latest, runId, read, context);
      events.push(...fired.events);
      started = fired.runId;
    }
  }
  return [
    ...events,
    ...seriesTriggerEvents(card, read, context, reached, started, latest !== undefined),
  ];
}

function startSeriesRun(
  cause: string,
  card: RepeatingCard,
  occurrence: Occurrence,
  runId: string,
  read: ReadModel,
  context: DecideContext,
): { events: DomainEvent[]; runId?: string } {
  if (card.workflowId === null || card.projectId === null) return { events: [] };
  let started: DomainEvent[];
  try {
    started = startRunEvents(
      cause,
      {
        runId,
        workflowId: card.workflowId,
        projectId: card.projectId,
        calendarItemId: card.id,
        backlogItemId: card.backlogItemId,
        occurrence: { date: occurrence.date, start: occurrence.start },
      },
      read,
      context,
    );
  } catch (error) {
    if (!(error instanceof CommandRejected)) throw error;
    return {
      events: [
        occurrenceRecorded(card, occurrence, 'failed', context, { reason: error.message }),
        ...cardState(card, 'failed', card.runId, context),
        ...notification(read, context, {
          id: `${triggerIdFor(card.id)}:${occurrence.start}:failed`,
          at: context.now,
          kind: 'failed',
          title: 'Trigger failed',
          body: `${card.title} · ${occurrence.date}: ${error.message}`,
          path: '/calendar',
          runId: null,
          calendarItemId: card.id,
        }),
      ],
    };
  }
  const workflow = read.workflow(card.workflowId);
  return {
    runId,
    events: [
      occurrenceRecorded(card, occurrence, 'fired', context, { runId }),
      ...started,
      ...notification(read, context, {
        id: `${runId}:started`,
        at: context.now,
        kind: 'started',
        title: 'Workflow run started',
        body: [workflow?.name, card.title, occurrence.date].filter(Boolean).join(' · '),
        path: runPath(runId),
        runId,
        calendarItemId: card.id,
      }),
    ],
  };
}

export function decideTrigger(
  command: TriggerCommand,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  switch (command.type) {
    case 'trigger.fire': {
      const trigger = requireTrigger(read, command.triggerId, command.runAt);
      if (!trigger) return [];
      const card = read.calendarItem(trigger.calendarItemId);
      if (card && isRepeating(card)) {
        return fireSeries(command.type, trigger, card, command.runId, 'run', read, context);
      }
      return fire(command.type, trigger, command.runId, read, context);
    }
    case 'trigger.applyMissed': {
      const trigger = requireTrigger(read, command.triggerId, command.runAt);
      if (!trigger) return [];
      const repeating = read.calendarItem(trigger.calendarItemId);
      if (repeating && isRepeating(repeating)) {
        return fireSeries(
          command.type,
          trigger,
          repeating,
          command.runId,
          command.policy,
          read,
          context,
        );
      }
      const outcome = missedTriggerOutcome(command.policy);
      if (outcome.startRun) return fire(command.type, trigger, command.runId, read, context);
      const card = read.calendarItem(trigger.calendarItemId);
      return [
        triggerSet({ ...trigger, state: outcome.triggerState, offerRunNow: outcome.offerRunNow }),
        ...(card ? cardState(card, 'missed', card.runId, context) : []),
      ];
    }
    case 'card.runNow': {
      const card = read.calendarItem(command.cardId);
      if (!card) throw new CommandRejected('not_found', `No card ${command.cardId}`);
      if (card.source !== 'local') {
        throw new CommandRejected('rejected', 'Outlook items are read-only');
      }
      if (card.workflowId === null) {
        throw new CommandRejected('rejected', `"${card.title}" has no workflow`);
      }
      if (card.projectId === null) {
        throw new CommandRejected('rejected', `"${card.title}" has no project`);
      }
      if (liveRunOf(card, read)) {
        throw new CommandRejected('conflict', `"${card.title}" already has a run in progress`);
      }
      // On a repeating card, Run now answers the missed occurrence that offers it, and the
      // trigger keeps waiting for the next one.
      const offered = isRepeating(card)
        ? read.cardOccurrences(card.id).findLast((occurrence) => occurrence.offerRunNow)
        : undefined;
      const events = startRunEvents(
        command.type,
        {
          runId: command.runId,
          workflowId: card.workflowId,
          projectId: card.projectId,
          calendarItemId: card.id,
          backlogItemId: card.backlogItemId,
          occurrence: offered && { date: offered.date, start: offered.start },
        },
        read,
        context,
      );
      if (isRepeating(card)) {
        if (offered) {
          events.unshift(
            occurrenceRecorded(card, offered, 'fired', context, { runId: command.runId }),
          );
        }
        return events;
      }
      const trigger = read.trigger(triggerIdFor(card.id));
      if (trigger && (trigger.state === 'scheduled' || trigger.state === 'missed')) {
        events.unshift(
          triggerSet({ ...trigger, state: 'fired', runId: command.runId, offerRunNow: false }),
        );
      }
      return events;
    }
    case 'trigger.create': {
      // A card's trigger is `<cardId>:trigger`; an event trigger's id must never be one.
      if (command.triggerId.includes(':')) {
        throw new CommandRejected('rejected', 'A trigger id cannot contain a colon');
      }
      if (read.trigger(command.triggerId)) {
        throw new CommandRejected('conflict', `Trigger ${command.triggerId} already exists`);
      }
      const project = read.project(command.projectId);
      if (!project) throw new CommandRejected('not_found', `No project ${command.projectId}`);
      const workflow = read.workflow(command.workflowId);
      if (!workflow) throw new CommandRejected('not_found', `No workflow ${command.workflowId}`);
      const same = read
        .eventTriggers(project.id)
        .some((trigger) => trigger.event === command.event && trigger.workflowId === workflow.id);
      if (same) {
        throw new CommandRejected(
          'conflict',
          `${project.name} already has a trigger that starts ${workflow.name} for "${triggerEventLabel(command.event, projectCodeHost(read.hostReads(project.id), project.id))}"`,
        );
      }
      return [
        triggerSet({
          id: command.triggerId,
          kind: 'event',
          workflowId: workflow.id,
          runId: null,
          calendarItemId: null,
          runAt: null,
          zone: null,
          state: null,
          offerRunNow: false,
          projectId: project.id,
          event: command.event,
          enabled: true,
          createdAt: context.now,
        }),
      ];
    }
    case 'trigger.setEnabled': {
      const trigger = requireEventTrigger(read, command.triggerId);
      if (trigger.enabled === command.enabled) return [];
      return [triggerSet({ ...trigger, enabled: command.enabled })];
    }
    case 'trigger.delete': {
      const trigger = requireEventTrigger(read, command.triggerId);
      return [
        { kind: 'trigger.deleted', aggregate: trigger.id, payload: { triggerId: trigger.id } },
      ];
    }
  }
}

function requireEventTrigger(read: ReadModel, id: string): EventTrigger {
  const trigger = read.trigger(id);
  if (!trigger) throw new CommandRejected('not_found', `No trigger ${id}`);
  if (!isEventTrigger(trigger)) {
    throw new CommandRejected('rejected', `Trigger ${id} belongs to a calendar card`);
  }
  return trigger;
}

// Something that happened on a pull request between two reads of it. `id` is stable across
// polls: the pull request with the head commit for failed checks, so a commit fails at most
// once however often its checks are run again or the branch is pushed back to it, and the
// host's comment id for a comment.
export interface SeenEvent {
  readonly id: string;
  readonly event: TriggerEvent;
  readonly request: ChangeRequest;
  readonly comment: ReviewComment | null;
}

// What the new read of a pull request shows that the stored one did not. A pull request read
// for the first time has nothing to compare with, so what is already true about it is not an
// event (review loop spec 50). Several new comments in one read are one event, for the newest.
export function seenEvents(before: ChangeRequest | undefined, after: ChangeRequest): SeenEvent[] {
  if (!before) return [];
  const seen: SeenEvent[] = [];
  if (after.state === 'merged' && before.state !== 'merged') {
    seen.push({ id: `${after.id}:merged`, event: 'merged', request: after, comment: null });
  }
  if (
    after.checkState === 'failure' &&
    (before.checkState !== 'failure' || before.headSha !== after.headSha)
  ) {
    seen.push({
      id: `${after.id}:checksFailed:${after.headSha}`,
      event: 'checksFailed',
      request: after,
      comment: null,
    });
  }
  const newest = after.comments.find((comment) => comment.id === after.newestCommentId);
  if (
    newest &&
    before.newestCommentId !== newest.id &&
    !before.comments.some((comment) => comment.id === newest.id)
  ) {
    seen.push({
      id: `${after.id}:comment:${newest.id}`,
      event: 'commentAdded',
      request: after,
      comment: newest,
    });
  }
  return seen;
}

// The run an event starts for a trigger. Derived from both, so the same event can never start a
// second run of the trigger.
export const eventRunId = (triggerId: string, eventId: string): string =>
  `event-${createHash('sha256').update(`${triggerId}\n${eventId}`).digest('hex').slice(0, 16)}`;

export const triggersPath = '/workflows/triggers';

const EVENTS_ENABLED_KEY = 'triggers.eventsEnabled';
const SCHEDULER_PAUSED_KEY = 'scheduler.paused';

// A working copy the pull request already has: one of a run that the host last showed on the
// pull request's branch. A run that is still going is working in it; a kept one holds work that
// was not pushed. One that is being looked at after its run ended may be removed any moment, so
// it is not taken.
function pullRequestCopy(
  request: ChangeRequest,
  reads: Iterable<{ id: string; scope: string; changeRequestIds: readonly string[] }>,
  read: ReadModel,
): { run: WorkflowRun; copy: WorkingCopy } | undefined {
  const found: { run: WorkflowRun; copy: WorkingCopy }[] = [];
  for (const row of reads) {
    if (row.scope !== 'run' || !row.changeRequestIds.includes(request.id)) continue;
    const run = read.run(row.id.slice('run:'.length));
    const copy = run?.workingCopy;
    if (!run || !copy) continue;
    const live = isLiveRunState(run.state);
    if ((live && copy.state === 'ready') || (!live && copy.state === 'kept')) {
      found.push({ run, copy });
    }
  }
  return found.toSorted(
    (a, b) =>
      Number(isLiveRunState(b.run.state)) - Number(isLiveRunState(a.run.state)) ||
      Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt),
  )[0];
}

// The runs the project's event triggers start for what a read from the host has just shown
// (review loop spec 48 to 53). `before` and `after` are the pull requests as stored and as
// read. While event triggers are off or the scheduler is paused nothing starts, and because the
// stored rows move on all the same, nothing starts for it later either (spec 52).
export function eventTriggerEvents(
  projectId: string,
  before: ReadonlyMap<string, ChangeRequest>,
  after: readonly ChangeRequest[],
  reads: Iterable<{ id: string; scope: string; changeRequestIds: readonly string[] }>,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const seen = after.flatMap((request) => seenEvents(before.get(request.id), request));
  if (seen.length === 0) return [];
  if (
    !globalSettingOn(EVENTS_ENABLED_KEY, read, context) ||
    globalSettingOn(SCHEDULER_PAUSED_KEY, read, context)
  ) {
    return [];
  }
  const triggers = read.eventTriggers(projectId).filter((trigger) => trigger.enabled);
  const scopes = [...reads];
  const events: DomainEvent[] = [];
  for (const trigger of triggers) {
    // The newest run the trigger started in this round is the one its row names.
    let lastRunId: string | undefined;
    for (const happened of seen) {
      if (happened.event !== trigger.event) continue;
      if (read.triggerEventSeen(trigger.id, happened.id)) continue;
      if (commentStartsNothing(trigger, happened, read, context)) {
        events.push({
          kind: 'trigger.eventSeen',
          aggregate: trigger.id,
          payload: { triggerId: trigger.id, eventId: happened.id, runId: null, at: context.now },
        });
        continue;
      }
      if (forkStartsNothing(trigger, happened, read, context)) {
        events.push(...forkSkipped(trigger, happened, read, context));
        continue;
      }
      const fired = fireEvent(trigger, happened, scopes, read, context);
      events.push(...fired.events);
      lastRunId = fired.runId ?? lastRunId;
    }
    if (lastRunId !== undefined) events.push(triggerSet({ ...trigger, runId: lastRunId }));
  }
  return events;
}

const IGNORED_AUTHORS_KEY = 'triggers.ignoredCommentAuthors';
const FORKS_KEY = 'triggers.forkPullRequests';

// A fork's files would steer an agent on this computer, so its events start nothing unless the
// user allowed it for the project.
function forkStartsNothing(
  trigger: EventTrigger,
  happened: SeenEvent,
  read: ReadModel,
  context: DecideContext,
): boolean {
  if (happened.request.fromFork !== true) return false;
  const definition = context.registry[FORKS_KEY];
  if (!definition) return true;
  const { value } = resolveStored(
    FORKS_KEY,
    definition,
    { projectId: trigger.projectId },
    (scope) => read.setting(FORKS_KEY, scope),
  );
  return value !== true;
}

// A run that answers a review with a comment of its own must not start the next run, and so on
// without end. wow cannot tell which account an agent writes as, so two things stop the loop: a
// comment that arrives while the trigger's own run for that pull request is still going starts
// nothing, and neither does one by an account the user listed.
function commentStartsNothing(
  trigger: EventTrigger,
  happened: SeenEvent,
  read: ReadModel,
  context: DecideContext,
): boolean {
  if (!happened.comment) return false;
  const definition = context.registry[IGNORED_AUTHORS_KEY];
  const ignored = definition
    ? resolveStored(IGNORED_AUTHORS_KEY, definition, {}, (scope) =>
        read.setting(IGNORED_AUTHORS_KEY, scope),
      ).value
    : [];
  const author = happened.comment.author.toLowerCase();
  if (
    Array.isArray(ignored) &&
    ignored.some((name) => typeof name === 'string' && name.toLowerCase() === author)
  ) {
    return true;
  }
  const last = trigger.runId === null ? undefined : read.run(trigger.runId);
  return (
    last !== undefined &&
    isLiveRunState(last.state) &&
    last.event?.changeRequestId === happened.request.id
  );
}

function forkSkipped(
  trigger: EventTrigger,
  happened: SeenEvent,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const { request } = happened;
  const label = context.registry[FORKS_KEY]?.label ?? FORKS_KEY;
  return [
    {
      kind: 'trigger.eventSeen',
      aggregate: trigger.id,
      payload: { triggerId: trigger.id, eventId: happened.id, runId: null, at: context.now },
    },
    ...notification(read, context, {
      id: `${trigger.id}:${happened.id}:fork`,
      at: context.now,
      kind: 'failed',
      title: 'Trigger started nothing',
      body: `${triggerEventLabel(trigger.event, request.host)} · ${changeRequestRef(request)}: it comes from a fork, so nothing started. A run would work on the fork's files, and they would steer an agent on this computer. "${label}" (${FORKS_KEY}) allows it.`,
      path: triggersPath,
      runId: null,
      calendarItemId: null,
    }),
  ];
}

function fireEvent(
  trigger: EventTrigger,
  happened: SeenEvent,
  reads: Iterable<{ id: string; scope: string; changeRequestIds: readonly string[] }>,
  read: ReadModel,
  context: DecideContext,
): { events: DomainEvent[]; runId: string | null } {
  const { request, comment } = happened;
  const runId = eventRunId(trigger.id, happened.id);
  const seen = (startedRunId: string | null): DomainEvent => ({
    kind: 'trigger.eventSeen',
    aggregate: trigger.id,
    payload: { triggerId: trigger.id, eventId: happened.id, runId: startedRunId, at: context.now },
  });
  const what = `${triggerEventLabel(trigger.event, request.host)} · ${changeRequestRef(request)}`;
  const event: RunEvent = {
    triggerId: trigger.id,
    event: trigger.event,
    changeRequestId: request.id,
    number: request.number,
    url: request.url,
    branch: request.headBranch,
    ...(request.headSha === '' ? {} : { headSha: request.headSha }),
    headRef:
      request.host === 'gitlab'
        ? `refs/merge-requests/${request.number}/head`
        : `refs/pull/${request.number}/head`,
    ...(request.fromFork === undefined ? {} : { fromFork: request.fromFork }),
    // The comment's text stays out: only where it is and who wrote it (spec 51).
    commentUrl: comment?.url ?? null,
    commentAuthor: comment?.author ?? null,
  };
  let started: DomainEvent[];
  try {
    started = startRunEvents(
      'trigger.event',
      {
        runId,
        workflowId: trigger.workflowId,
        projectId: trigger.projectId,
        event,
        existingCopy: pullRequestCopy(request, reads, read),
      },
      read,
      context,
    );
  } catch (error) {
    if (!(error instanceof CommandRejected)) throw error;
    const id = `${trigger.id}:${happened.id}:failed`;
    return {
      runId: null,
      events: [
        seen(null),
        ...notification(read, context, {
          id,
          at: context.now,
          kind: 'failed',
          title: 'Trigger failed',
          body: `${what}: ${error.message}`,
          path: triggersPath,
          runId: null,
          calendarItemId: null,
        }),
      ],
    };
  }
  const workflow = read.workflow(trigger.workflowId);
  return {
    runId,
    events: [
      seen(runId),
      ...started,
      ...notification(read, context, {
        id: `${runId}:started`,
        at: context.now,
        kind: 'started',
        title: 'Workflow run started',
        body: [workflow?.name, what].filter(Boolean).join(' · '),
        path: runPath(runId),
        runId,
        calendarItemId: null,
      }),
    ],
  };
}
