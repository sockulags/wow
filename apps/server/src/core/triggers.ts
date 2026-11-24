import {
  type AppNotification,
  type CalendarItem,
  type CardOccurrence,
  type CardState,
  type DomainEvent,
  type MissedTriggerPolicy,
  type ServerCommand,
  type Trigger,
  type TriggerState,
} from '@wow/contracts';
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
import { CommandRejected, decide, type DecideContext, type ReadModel } from './orchestrator.js';
import {
  isRepeating,
  nextOccurrence,
  scheduleOf,
  takenDays,
  type RepeatingCard,
} from './series.js';
import { threadPath } from './threads.js';
import { notificationsEnabled } from './workflows.js';

// Decisions for a card's trigger (spec 8, 12, 13): a local card with a workflow has one trigger
// at its next start; the scheduler fires it, and the occurrence starts a main thread that runs
// the workflow or sends the next message to the card's one thread (orchestrator threads spec
// 27). The card then follows that thread (spec 28).

type TriggerCommand = Extract<
  ServerCommand,
  {
    type:
      | 'trigger.fire'
      | 'trigger.applyMissed'
      | 'card.runNow'
      | 'card.followThread';
  }
>;

export const isTriggerCommand = (command: ServerCommand): command is TriggerCommand =>
  command.type === 'trigger.fire' ||
  command.type === 'trigger.applyMissed' ||
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
    // A refusal records the failure in place of what it would have done; a new thread whose first
    // message is refused stays, empty, with the failure on its card.
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

const triggerSet = (trigger: Trigger): DomainEvent => ({
  kind: 'trigger.set',
  aggregate: trigger.id,
  payload: trigger,
});

const cardState = (
  card: CalendarItem,
  state: CardState,
  context: DecideContext,
  threadId: string | null = card.threadId ?? null,
): DomainEvent[] =>
  card.state === state && (card.threadId ?? null) === threadId
    ? []
    : [
        {
          kind: 'card.stateChanged',
          aggregate: card.id,
          payload: { cardId: card.id, state, threadId, updatedAt: context.now },
        },
      ];

// Whether the card has started a thread yet.
const hasStarted = (card: CalendarItem): boolean => (card.threadId ?? null) !== null;

// What the card's trigger row names as its workflow.
const workflowRef = (card: CalendarItem): string => card.workflowName ?? card.workflowId ?? '';

const notification = (read: ReadModel, context: DecideContext, entry: AppNotification) =>
  notificationsEnabled(read, context)
    ? [{ kind: 'notification.sent', aggregate: entry.id, payload: entry } satisfies DomainEvent]
    : [];

// Brings a card's trigger in line with the card after it was created, moved or given another
// workflow or project. A card that already started a thread keeps its fired trigger. A start time
// that has already passed gives a missed trigger with "Run now" rather than an immediate run.
export function cardTriggerEvents(card: CalendarItem, read: ReadModel, context: DecideContext) {
  if (card.source !== 'local') return [];
  if (isRepeating(card)) return seriesTriggerEvents(card, read, context);
  const existing = read.trigger(triggerIdFor(card.id));
  if (hasStarted(card)) {
    // A card that stopped repeating may still hold a trigger for a later occurrence. It goes
    // back to a fired trigger at the occurrence that started its thread.
    if (existing?.state !== 'scheduled') return [];
    const ran = read
      .cardOccurrences(card.id)
      .find((occurrence) => occurrence.threadId === card.threadId);
    return [
      triggerSet({ ...existing, state: 'fired', runAt: ran?.start ?? card.start, offerRunNow: false }),
    ];
  }
  const events: DomainEvent[] = [];
  let next: Trigger | undefined;
  let state: CardState = 'scheduled';
  if (startsWork(card)) {
    const due = Date.parse(card.start) <= Date.parse(context.now);
    next = {
      id: triggerIdFor(card.id),
      calendarItemId: card.id,
      workflowId: workflowRef(card),
      runAt: card.start,
      zone: card.zone,
      state: due ? 'missed' : 'scheduled',
      offerRunNow: due,
    };
    state = due ? 'missed' : 'scheduled';
  } else if (existing && (existing.state === 'scheduled' || existing.state === 'missed')) {
    next = { ...existing, state: 'cancelled', offerRunNow: false };
  }
  if (next && !isDeepStrictEqual(next, existing)) events.push(triggerSet(next));
  events.push(...cardState(card, state, context));
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
  startedThreadId?: string,
  handled = false,
): DomainEvent[] {
  const existing = read.trigger(triggerIdFor(card.id));
  const started = startedThreadId !== undefined || hasStarted(card);
  let next: Trigger | undefined;
  const upcoming = startsWork(card)
    ? nextOccurrence(card, read, Date.parse(context.now), alsoTaken)
    : undefined;
  if (upcoming) {
    next = {
      id: triggerIdFor(card.id),
      calendarItemId: card.id,
      workflowId: workflowRef(card),
      runAt: upcoming.start,
      zone: card.zone,
      state: 'scheduled',
      offerRunNow: false,
    };
  } else if (existing && (existing.state === 'scheduled' || existing.state === 'missed')) {
    next = { ...existing, state: started ? 'fired' : 'cancelled', offerRunNow: false };
  }
  const events: DomainEvent[] = [];
  if (next && !isDeepStrictEqual(next, existing)) events.push(triggerSet(next));
  // A card that has started a thread follows it; one that has not waits for its first,
  // and once every remaining occurrence was skipped it is finished as a last occurrence leaves it.
  // An occurrence this decision handled (missed, failed, started) has set the state already.
  if (handled) return events;
  if (!started && upcoming) {
    events.push(...cardState(card, 'scheduled', context));
  } else if (!started && card.state === 'scheduled' && startsWork(card)) {
    events.push(...cardState(card, 'done', context));
  }
  return events;
}

// What deleting a card does to its trigger. The threads it started stay.
export function cardDeleteEvents(card: CalendarItem, read: ReadModel): DomainEvent[] {
  const trigger = read.trigger(triggerIdFor(card.id));
  return trigger && (trigger.state === 'scheduled' || trigger.state === 'missed')
    ? [triggerSet({ ...trigger, state: 'cancelled', offerRunNow: false })]
    : [];
}

function requireTrigger(read: ReadModel, id: string, runAt: string): Trigger | undefined {
  const trigger = read.trigger(id);
  // Fired, missed or cancelled meanwhile, or the card moved after the scheduler looked.
  if (!trigger) return undefined;
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
      ...cardState(card, 'failed', context, before),
      ...backlogFollowsCard(card, 'failed', read),
      ...notification(read, context, {
        id: `${triggerIdFor(card.id)}:${occurrence?.start ?? card.start}:${newThreadId}:refused`,
        at: context.now,
        kind: 'failed',
        title: 'Trigger failed',
        body: [card.title, occurrence?.date].filter(Boolean).join(' · ') + `: ${reason}`,
        path: '/calendar',
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
  ...cardState(card, 'running', context, threadId),
  ...backlogFollowsCard(card, 'running', read),
  ...notification(read, context, {
    id: `${card.id}:${date ?? card.start}:${threadId}:started`,
    at: context.now,
    kind: 'started',
    title: 'Scheduled thread started',
    body: [cardWorkflowName(card, read), card.title, date].filter(Boolean).join(' · '),
    path: threadPath(threadId),
    calendarItemId: card.id,
  }),
];

// Starts the card's thread for a due trigger. A thread that cannot start (its workflow or every
// provider instance is gone) fails the card instead of retrying on every tick.
function fire(
  trigger: Trigger,
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
      triggerSet({ ...trigger, state: 'fired', offerRunNow: false }),
      ...cardState(card, 'failed', context),
      ...notification(read, context, {
        id: `${trigger.id}:${trigger.runAt}:failed`,
        at: context.now,
        kind: 'failed',
        title: 'Trigger failed',
        body: `${card.title}: ${error.message}`,
        path: '/calendar',
        calendarItemId: card.id,
      }),
    ];
  }
  return [
    triggerSet({ ...trigger, state: 'fired', offerRunNow: false }),
    ...threadStarted(card, threadId, undefined, read, context),
  ];
}

const occurrenceRecorded = (
  card: CalendarItem,
  occurrence: Occurrence,
  outcome: CardOccurrence['outcome'],
  context: DecideContext,
  extra: Partial<Pick<CardOccurrence, 'threadId' | 'reason' | 'offerRunNow'>> = {},
): DomainEvent => ({
  kind: 'card.occurrenceRecorded',
  aggregate: card.id,
  payload: {
    cardId: card.id,
    occurrence: {
      ...occurrence,
      outcome,
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
  trigger: Trigger,
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
      ...cardState(card, 'missed', context),
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
        ...cardState(card, 'failed', context),
        ...notification(read, context, {
          id: `${triggerIdFor(card.id)}:${occurrence.start}:failed`,
          at: context.now,
          kind: 'failed',
          title: 'Trigger failed',
          body: `${card.title} · ${occurrence.date}: ${error.message}`,
          path: '/calendar',
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
        return fireSeries(trigger, card, command.threadId, 'run', read, context, starts);
      }
      return fire(trigger, command.threadId, read, context, starts);
    }
    case 'trigger.applyMissed': {
      const trigger = requireTrigger(read, command.triggerId, command.runAt);
      if (!trigger) return [];
      const repeating = read.calendarItem(trigger.calendarItemId);
      if (repeating && isRepeating(repeating)) {
        return fireSeries(
          trigger,
          repeating,
          command.threadId,
          command.policy,
          read,
          context,
          starts,
        );
      }
      const outcome = missedTriggerOutcome(command.policy);
      if (outcome.startRun) return fire(trigger, command.threadId, read, context, starts);
      const card = read.calendarItem(trigger.calendarItemId);
      return [
        triggerSet({ ...trigger, state: outcome.triggerState, offerRunNow: outcome.offerRunNow }),
        ...(card ? cardState(card, 'missed', context) : []),
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
      if (busyThreadOf(card, read)) {
        throw new CommandRejected('conflict', `"${card.title}" is still working`);
      }
      // On a repeating card, Run now answers the missed occurrence that offers it, and the
      // trigger keeps waiting for the next one.
      const offered = isRepeating(card)
        ? read.cardOccurrences(card.id).findLast((occurrence) => occurrence.offerRunNow)
        : undefined;
      const threadId = startThread(card, offered, command.threadId, read, context, starts);
      const events = threadStarted(card, threadId, offered?.date, read, context);
      if (isRepeating(card)) {
        if (offered) {
          events.unshift(occurrenceRecorded(card, offered, 'fired', context, { threadId }));
        }
        return events;
      }
      const trigger = read.trigger(triggerIdFor(card.id));
      if (trigger && (trigger.state === 'scheduled' || trigger.state === 'missed')) {
        events.unshift(triggerSet({ ...trigger, state: 'fired', offerRunNow: false }));
      }
      return events;
    }
    case 'card.followThread': {
      const card = read.calendarItem(command.cardId);
      return card ? cardFollowsThread(card, read, context) : [];
    }
  }
}

// What happens to a trigger whose time passed while the server was down (behavior 12): run starts
// it, mark offers a one-click "Run now" on the card, skip does neither.
function missedTriggerOutcome(policy: MissedTriggerPolicy): {
  readonly triggerState: Extract<TriggerState, 'fired' | 'missed'>;
  readonly startRun: boolean;
  readonly offerRunNow: boolean;
} {
  switch (policy) {
    case 'run':
      return { triggerState: 'fired', startRun: true, offerRunNow: false };
    case 'mark':
      return { triggerState: 'missed', startRun: false, offerRunNow: true };
    case 'skip':
      return { triggerState: 'missed', startRun: false, offerRunNow: false };
  }
}

// Triggers are cards on the calendar (orchestrator threads spec 27, 34).
export const triggersPath = '/calendar';
