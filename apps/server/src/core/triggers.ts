import {
  isCardTrigger,
  isEventTrigger,
  triggerEventLabel,
  type AppNotification,
  type CalendarItem,
  type CardOccurrence,
  type CardState,
  type CardTrigger,
  type DomainEvent,
  type EventTrigger,
  type ServerCommand,
  type Trigger,
} from '@wow/contracts';
import { missedTriggerOutcome } from '@wow/workflow-engine';
import { localDay, startingBetween, type Occurrence } from '../scheduler/occurrences.js';
import { isDeepStrictEqual } from 'node:util';
import { backlogFollowsCard } from './backlog.js';
import {
  busyThreadOf,
  cardFollowsThread,
  cardThreadStart,
  cardWorkflowName,
  startsWork,
  type CardThreadStart,
} from './card-threads.js';
import {
  CommandRejected,
  codeHostOf,
  decide,
  type DecideContext,
  type ReadModel,
} from './orchestrator.js';
import {
  isRepeating,
  liveRunOf,
  nextOccurrence,
  scheduleOf,
  takenDays,
  type RepeatingCard,
} from './series.js';
import { threadPath } from './threads.js';
import { notificationsEnabled, runInput } from './workflows.js';

// Decisions for a card's trigger (spec 8, 12, 13): a local card with a workflow has one trigger
// at its next start; the scheduler fires it, and the occurrence starts a main thread that runs
// the workflow or sends the next message to the card's one thread (orchestrator threads spec
// 27). The card then follows that thread (spec 28). Event triggers are gone (spec 29); only rows
// stored before can still be switched off or deleted until the migration has removed them.

type TriggerCommand = Extract<
  ServerCommand,
  {
    type:
      | 'trigger.fire'
      | 'trigger.applyMissed'
      | 'card.runNow'
      | 'card.followThread'
      | 'trigger.create'
      | 'trigger.setEnabled'
      | 'trigger.delete';
  }
>;

export const isTriggerCommand = (command: ServerCommand): command is TriggerCommand =>
  command.type.startsWith('trigger.') ||
  command.type === 'card.runNow' ||
  command.type === 'card.followThread';

// The commands that start a card's thread, decided in steps (`decideTriggerInSteps`): the
// trigger's own events first, then the thread is made and the workflow sent on what they left.
const startsThreads = (command: ServerCommand): boolean =>
  command.type === 'trigger.fire' ||
  command.type === 'trigger.applyMissed' ||
  command.type === 'card.runNow';

export const isSteppedTriggerCommand = startsThreads;

export function* decideTriggerInSteps(
  command: TriggerCommand,
  read: ReadModel,
  context: DecideContext,
): Generator<DomainEvent[], void> {
  const starts: CardThreadStart[] = [];
  yield decideTrigger(command, read, context, starts);
  // The thread is the user's own, as if they had made it and sent the workflow.
  const asUser: DecideContext = { ...context, origin: 'user' };
  for (const start of starts) {
    // Decided before either is applied, so a refusal of the send leaves no thread behind.
    let made: DomainEvent[];
    try {
      made = start.create ? decide(start.create, read, asUser) : [];
    } catch (error) {
      if (!(error instanceof CommandRejected)) throw error;
      yield start.refused(error.message);
      continue;
    }
    if (made.length > 0) yield made;
    try {
      yield decide(start.send, read, asUser);
    } catch (error) {
      if (!(error instanceof CommandRejected)) throw error;
      yield start.refused(error.message);
    }
  }
}

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
  threadId: string | null = card.threadId ?? null,
): DomainEvent[] =>
  card.state === state && card.runId === runId && (card.threadId ?? null) === threadId
    ? []
    : [
        {
          kind: 'card.stateChanged',
          aggregate: card.id,
          payload: { cardId: card.id, state, runId, threadId, updatedAt: context.now },
        },
      ];

// Whether the card has started anything yet: a workflow run before workflows were files, a main
// thread since.
const hasStarted = (card: CalendarItem): boolean =>
  card.runId !== null || (card.threadId ?? null) !== null;

// What the card's trigger row names as its workflow.
const workflowRef = (card: CalendarItem): string => card.workflowName ?? card.workflowId ?? '';

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
  if (hasStarted(card)) {
    // A card that stopped repeating may still hold a trigger for a later occurrence. It goes
    // back to the fired trigger of the run it carries, as it was before the card repeated.
    if (existing?.state !== 'scheduled') return [];
    const ran =
      existing.runId === null
        ? undefined
        : read
            .cardOccurrences(card.id)
            .find(
              (occurrence) =>
                occurrence.runId === existing.runId || occurrence.threadId === existing.runId,
            );
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
  if (startsWork(card)) {
    const due = Date.parse(card.start) <= Date.parse(context.now);
    next = {
      ...noEventFields,
      id: triggerIdFor(card.id),
      kind: 'card',
      calendarItemId: card.id,
      workflowId: workflowRef(card),
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
  const upcoming = startsWork(card)
    ? nextOccurrence(card, read, Date.parse(context.now), alsoTaken)
    : undefined;
  if (upcoming) {
    next = {
      ...noEventFields,
      id: triggerIdFor(card.id),
      kind: 'card',
      calendarItemId: card.id,
      workflowId: workflowRef(card),
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
  if (!hasStarted(card) && runId === undefined && upcoming) {
    events.push(...cardState(card, 'scheduled', null, context));
  } else if (
    !hasStarted(card) &&
    runId === undefined &&
    card.state === 'scheduled' &&
    startsWork(card)
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

// Starts the card's thread for an occurrence (orchestrator threads spec 27): what to make and
// send goes into `starts`, and the card follows the thread from now on. Answers the thread.
function startThread(
  card: CalendarItem,
  occurrence: Occurrence | undefined,
  newThreadId: string,
  read: ReadModel,
  context: DecideContext,
  starts: CardThreadStart[],
): string {
  // A single card's thread is titled with its day too (orchestrator threads spec 27).
  const date = occurrence?.date ?? localDay(card.start, card.zone);
  const plan = cardThreadStart(card, date, newThreadId, read, context);
  const before = card.threadId ?? null;
  starts.push({
    ...plan,
    refused: (reason) => [
      ...(occurrence ? [occurrenceRecorded(card, occurrence, 'failed', context, { reason })] : []),
      ...cardState(card, 'failed', card.runId, context, before),
      ...notification(read, context, {
        id: `${triggerIdFor(card.id)}:${occurrence?.start ?? card.start}:${newThreadId}:refused`,
        at: context.now,
        kind: 'failed',
        title: 'Trigger failed',
        body: [card.title, occurrence?.date].filter(Boolean).join(' · ') + `: ${reason}`,
        path: '/calendar',
        runId: null,
        calendarItemId: card.id,
      }),
    ],
  });
  return plan.send.threadId;
}

const threadStarted = (
  card: CalendarItem,
  threadId: string,
  date: string | undefined,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] => [
  ...cardState(card, 'running', card.runId, context, threadId),
  ...backlogFollowsCard(card, 'running', read),
  ...notification(read, context, {
    id: `${card.id}:${date ?? card.start}:${threadId}:started`,
    at: context.now,
    kind: 'started',
    title: 'Scheduled thread started',
    body: [cardWorkflowName(card, read), card.title, date].filter(Boolean).join(' · '),
    path: threadPath(threadId),
    runId: null,
    calendarItemId: card.id,
  }),
];

// Starts the card's thread for a due trigger. A thread that cannot start (its workflow or every
// provider instance is gone) fails the card instead of retrying on every tick.
function fire(
  trigger: CardTrigger,
  newThreadId: string,
  read: ReadModel,
  context: DecideContext,
  starts: CardThreadStart[],
): DomainEvent[] {
  const card = read.calendarItem(trigger.calendarItemId);
  if (!card || !startsWork(card)) {
    return [triggerSet({ ...trigger, state: 'cancelled', offerRunNow: false })];
  }
  let threadId: string;
  try {
    threadId = startThread(card, undefined, newThreadId, read, context, starts);
  } catch (error) {
    if (!(error instanceof CommandRejected)) throw error;
    return [
      triggerSet({ ...trigger, state: 'fired', runId: null, offerRunNow: false }),
      ...cardState(card, 'failed', card.runId, context),
      ...notification(read, context, {
        id: `${trigger.id}:${trigger.runAt}:failed`,
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
  return [
    triggerSet({ ...trigger, state: 'fired', runId: threadId, offerRunNow: false }),
    ...threadStarted(card, threadId, undefined, read, context),
  ];
}

const occurrenceRecorded = (
  card: CalendarItem,
  occurrence: Occurrence,
  outcome: CardOccurrence['outcome'],
  context: DecideContext,
  extra: Partial<Pick<CardOccurrence, 'runId' | 'threadId' | 'reason' | 'offerRunNow'>> = {},
): DomainEvent => ({
  kind: 'card.occurrenceRecorded',
  aggregate: card.id,
  payload: {
    cardId: card.id,
    occurrence: {
      ...occurrence,
      outcome,
      runId: extra.runId ?? null,
      threadId: extra.threadId ?? null,
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
// `same` thread still works starts nothing (orchestrator threads spec 28). Then the trigger
// waits for the next occurrence.
function fireSeries(
  trigger: CardTrigger,
  card: RepeatingCard,
  newThreadId: string,
  mode: 'run' | 'mark' | 'skip',
  read: ReadModel,
  context: DecideContext,
  starts: CardThreadStart[],
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
    const busy = busyThreadOf(card, read);
    if (busy) {
      const reason = `Its thread "${busy.title || card.title}" was still working on an earlier occurrence, so this one started nothing.`;
      events.push(
        occurrenceRecorded(card, latest, 'skipped', context, { reason, threadId: busy.id }),
        ...notification(read, context, {
          id: `${card.id}:${latest.date}:skipped`,
          at: context.now,
          kind: 'skipped',
          title: 'Occurrence skipped',
          body: `${card.title} · ${latest.date}: ${reason}`,
          path: `/calendar?item=${encodeURIComponent(card.id)}`,
          runId: null,
          calendarItemId: card.id,
        }),
      );
    } else {
      const fired = startSeriesThread(card, latest, newThreadId, read, context, starts);
      events.push(...fired.events);
      started = fired.threadId;
    }
  }
  return [
    ...events,
    ...seriesTriggerEvents(card, read, context, reached, started, latest !== undefined),
  ];
}

function startSeriesThread(
  card: RepeatingCard,
  occurrence: Occurrence,
  newThreadId: string,
  read: ReadModel,
  context: DecideContext,
  starts: CardThreadStart[],
): { events: DomainEvent[]; threadId?: string } {
  let threadId: string;
  try {
    threadId = startThread(card, occurrence, newThreadId, read, context, starts);
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
  return {
    threadId,
    events: [
      occurrenceRecorded(card, occurrence, 'fired', context, { threadId }),
      ...threadStarted(card, threadId, occurrence.date, read, context),
    ],
  };
}

// Decided through `decide()` alone, a fire records the trigger and the card but starts no
// thread: only `decideTriggerInSteps` makes and sends what `starts` collects. Apply its events
// only through that path; the assistant's proposal check decides once and throws them away.
export function decideTrigger(
  command: TriggerCommand,
  read: ReadModel,
  context: DecideContext,
  // What a fired card starts, made and sent by `decideTriggerInSteps` after these events.
  starts: CardThreadStart[] = [],
): DomainEvent[] {
  switch (command.type) {
    case 'trigger.fire': {
      const trigger = requireTrigger(read, command.triggerId, command.runAt);
      if (!trigger) return [];
      const card = read.calendarItem(trigger.calendarItemId);
      if (card && isRepeating(card)) {
        return fireSeries(trigger, card, command.runId, 'run', read, context, starts);
      }
      return fire(trigger, command.runId, read, context, starts);
    }
    case 'trigger.applyMissed': {
      const trigger = requireTrigger(read, command.triggerId, command.runAt);
      if (!trigger) return [];
      const repeating = read.calendarItem(trigger.calendarItemId);
      if (repeating && isRepeating(repeating)) {
        return fireSeries(trigger, repeating, command.runId, command.policy, read, context, starts);
      }
      const outcome = missedTriggerOutcome(command.policy);
      if (outcome.startRun) return fire(trigger, command.runId, read, context, starts);
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
      if (!startsWork(card)) {
        throw new CommandRejected('rejected', `"${card.title}" has no workflow`);
      }
      if (liveRunOf(card, read) || busyThreadOf(card, read)) {
        throw new CommandRejected('conflict', `"${card.title}" is still working`);
      }
      // On a repeating card, Run now answers the missed occurrence that offers it, and the
      // trigger keeps waiting for the next one.
      const offered = isRepeating(card)
        ? read.cardOccurrences(card.id).findLast((occurrence) => occurrence.offerRunNow)
        : undefined;
      const threadId = startThread(card, offered, command.runId, read, context, starts);
      const events = threadStarted(card, threadId, offered?.date, read, context);
      if (isRepeating(card)) {
        if (offered) {
          events.unshift(occurrenceRecorded(card, offered, 'fired', context, { threadId }));
        }
        return events;
      }
      const trigger = read.trigger(triggerIdFor(card.id));
      if (trigger && (trigger.state === 'scheduled' || trigger.state === 'missed')) {
        events.unshift(
          triggerSet({ ...trigger, state: 'fired', runId: threadId, offerRunNow: false }),
        );
      }
      return events;
    }
    case 'card.followThread': {
      const card = read.calendarItem(command.cardId);
      return card ? cardFollowsThread(card, read, context) : [];
    }
    // An event trigger is stored as before but nothing fires it any more (spec 29); the command
    // goes with the Triggers tab and the assistant's trigger tools (orchestrator threads U8).
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
          `${project.name} already has a trigger that starts ${workflow.name} for "${triggerEventLabel(command.event, codeHostOf(read, context, project.id))}"`,
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

export const triggersPath = '/workflows/triggers';
