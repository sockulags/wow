import {
  isLiveRunState,
  type AppNotification,
  type CalendarItem,
  type CardState,
  type DomainEvent,
  type ServerCommand,
  type Trigger,
} from '@wow/contracts';
import { missedTriggerOutcome } from '@wow/workflow-engine';
import { isDeepStrictEqual } from 'node:util';
import { CommandRejected, type DecideContext, type ReadModel } from './orchestrator.js';
import { notificationsEnabled, runInput, runPath, startRunEvents } from './workflows.js';

// Decisions for card triggers (spec 8, 12, 13). A local card with a workflow and a project has
// one trigger at its start time. The scheduler fires it into a workflow run; the run then drives
// the card's state.

type TriggerCommand = Extract<
  ServerCommand,
  { type: 'trigger.fire' | 'trigger.applyMissed' | 'card.runNow' }
>;

export const isTriggerCommand = (command: ServerCommand): command is TriggerCommand =>
  command.type.startsWith('trigger.') || command.type === 'card.runNow';

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
  if (card.source !== 'local' || card.runId !== null) return [];
  const existing = read.trigger(triggerIdFor(card.id));
  const events: DomainEvent[] = [];
  let next: Trigger | undefined;
  let state: CardState = 'scheduled';
  if (card.workflowId !== null && card.projectId !== null) {
    const due = Date.parse(card.start) <= Date.parse(context.now);
    next = {
      id: triggerIdFor(card.id),
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

// What deleting a card does to its run and trigger. A live run needs the user's answer first.
export function cardDeleteEvents(
  card: CalendarItem,
  stopRun: boolean | undefined,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const events: DomainEvent[] = [];
  const run = card.runId === null ? undefined : read.run(card.runId);
  if (run && isLiveRunState(run.state)) {
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

function requireTrigger(read: ReadModel, id: string, runAt: string): Trigger | undefined {
  const trigger = read.trigger(id);
  // Fired, missed or cancelled meanwhile, or the card moved after the scheduler looked.
  if (!trigger || trigger.state !== 'scheduled' || trigger.runAt !== runAt) return undefined;
  return trigger;
}

// Starts the card's run for a due trigger. A run that cannot start (its workflow or a provider
// instance is gone) fails the card instead of retrying on every tick.
function fire(
  cause: string,
  trigger: Trigger,
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

export function decideTrigger(
  command: TriggerCommand,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  switch (command.type) {
    case 'trigger.fire': {
      const trigger = requireTrigger(read, command.triggerId, command.runAt);
      return trigger ? fire(command.type, trigger, command.runId, read, context) : [];
    }
    case 'trigger.applyMissed': {
      const trigger = requireTrigger(read, command.triggerId, command.runAt);
      if (!trigger) return [];
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
      const current = card.runId === null ? undefined : read.run(card.runId);
      if (current && isLiveRunState(current.state)) {
        throw new CommandRejected('conflict', `"${card.title}" already has a run in progress`);
      }
      const events = startRunEvents(
        command.type,
        {
          runId: command.runId,
          workflowId: card.workflowId,
          projectId: card.projectId,
          calendarItemId: card.id,
          backlogItemId: card.backlogItemId,
        },
        read,
        context,
      );
      const trigger = read.trigger(triggerIdFor(card.id));
      if (trigger && (trigger.state === 'scheduled' || trigger.state === 'missed')) {
        events.unshift(
          triggerSet({ ...trigger, state: 'fired', runId: command.runId, offerRunNow: false }),
        );
      }
      return events;
    }
  }
}
