import {
  type AppNotification,
  type CardState,
  type DomainEvent,
  type RunEffect,
  type ServerCommand,
  type Thread,
  type Workflow,
  type WorkflowChanges,
  type WorkflowRun,
  type WorkflowStep,
} from '@wow/contracts';
import {
  advance,
  pendingGate,
  RunRejected,
  startRun,
  type EngineContext,
  type RunInput,
  type Transition,
} from '@wow/workflow-engine';
import { invocationsFor } from '@wow/skills';
import { isDeepStrictEqual } from 'node:util';
import { resolveStored } from '../settings/service.js';
import { backlogFollowsRun } from './backlog.js';
import { CommandRejected, type DecideContext, type ReadModel } from './orchestrator.js';

// Decisions for workflow definitions and runs. Run transitions come from the pure workflow
// engine; this file only looks things up, turns engine output into events and engine refusals
// into rejected commands.

type WorkflowCommand = Extract<
  ServerCommand,
  { type: `workflow.${string}` } | { type: `workflowRun.${string}` }
>;

export const isWorkflowCommand = (command: ServerCommand): command is WorkflowCommand =>
  command.type.startsWith('workflow.') || command.type.startsWith('workflowRun.');

export function decideWorkflow(
  command: WorkflowCommand,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  switch (command.type) {
    case 'workflow.create': {
      if (read.workflow(command.workflowId)) {
        throw new CommandRejected('conflict', `Workflow ${command.workflowId} already exists`);
      }
      return [
        {
          kind: 'workflow.created',
          aggregate: command.workflowId,
          payload: {
            id: command.workflowId,
            name: command.name,
            templateKind: command.templateKind ?? null,
            steps: command.steps,
            createdAt: context.now,
            updatedAt: context.now,
          },
        },
      ];
    }
    case 'workflow.update': {
      const workflow = requireWorkflow(read, command.workflowId);
      const changes: Omit<WorkflowChanges, 'updatedAt'> = {};
      if (command.name !== undefined && command.name !== workflow.name) changes.name = command.name;
      if (command.templateKind !== undefined && command.templateKind !== workflow.templateKind) {
        changes.templateKind = command.templateKind;
      }
      if (command.steps !== undefined && !isDeepStrictEqual(command.steps, workflow.steps)) {
        // A live run follows its workflow's steps by position, so they cannot change under it.
        if (read.hasLiveRun(workflow.id)) {
          throw new CommandRejected(
            'conflict',
            `Workflow ${workflow.name} has a run in progress; stop it before changing the steps`,
          );
        }
        changes.steps = command.steps;
      }
      if (Object.keys(changes).length === 0) return [];
      return [
        {
          kind: 'workflow.updated',
          aggregate: workflow.id,
          payload: { workflowId: workflow.id, changes: { ...changes, updatedAt: context.now } },
        },
      ];
    }
    case 'workflow.delete': {
      const workflow = requireWorkflow(read, command.workflowId);
      if (read.hasLiveRun(workflow.id)) {
        throw new CommandRejected(
          'conflict',
          `Workflow ${workflow.name} has a run in progress; stop it first`,
        );
      }
      return [
        { kind: 'workflow.deleted', aggregate: workflow.id, payload: { workflowId: workflow.id } },
      ];
    }
    case 'workflowRun.start':
      return startRunEvents(command.type, command, read, context);
    case 'workflowRun.continue':
      return runInput(command.type, command.runId, { type: 'continue' }, read, context);
    case 'workflowRun.stop':
      return runInput(command.type, command.runId, { type: 'stop' }, read, context);
    case 'workflowRun.stepCompleted':
      return runInput(
        command.type,
        command.runId,
        {
          type: 'stepCompleted',
          stepId: command.stepId,
          finalMessage: command.finalMessage,
          artifactsFound: command.artifactsFound,
        },
        read,
        context,
      );
    case 'workflowRun.stepFailed':
      return runInput(
        command.type,
        command.runId,
        { type: 'stepFailed', stepId: command.stepId, error: command.error },
        read,
        context,
      );
    case 'workflowRun.artifactsFound':
      return runInput(
        command.type,
        command.runId,
        { type: 'artifactsFound', found: command.found },
        read,
        context,
      );
  }
}

export interface RunStart {
  readonly runId: string;
  readonly workflowId: string;
  readonly projectId: string;
  readonly calendarItemId?: string | null | undefined;
  readonly backlogItemId?: string | null | undefined;
}

// A new run of the workflow: a client's Run now, a card's Run now or a firing trigger.
export function startRunEvents(
  cause: string,
  start: RunStart,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  if (read.run(start.runId)) {
    throw new CommandRejected('conflict', `Run ${start.runId} already exists`);
  }
  const workflow = requireWorkflow(read, start.workflowId);
  if (!read.project(start.projectId)) {
    throw new CommandRejected('not_found', `No project ${start.projectId}`);
  }
  for (const step of workflow.steps) {
    if (!read.providerInstance(step.providerInstanceId)) {
      throw new CommandRejected(
        'rejected',
        `Step ${step.skillName} uses provider instance ${step.providerInstanceId}, which does not exist`,
      );
    }
  }
  const backlogBody = backlogBodyOf(read, start.backlogItemId ?? null);
  const engineContext = runContext(read, context, start.projectId, backlogBody);
  const transition = engineCall(() =>
    startRun(
      workflow,
      {
        runId: start.runId,
        projectId: start.projectId,
        calendarItemId: start.calendarItemId ?? null,
        backlogItemId: start.backlogItemId ?? null,
      },
      engineContext,
    ),
  );
  return transitionEvents(cause, workflow, undefined, transition, read, context);
}

export function runInput(
  cause: string,
  runId: string,
  input: RunInput,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const run = read.run(runId);
  if (!run) throw new CommandRejected('not_found', `No run ${runId}`);
  const workflow = requireWorkflow(read, run.workflowId);
  const engineContext = runContext(
    read,
    context,
    run.projectId,
    backlogBodyOf(read, run.backlogItemId),
  );
  const transition = engineCall(() => advance(workflow, run, input, engineContext));
  return transitionEvents(cause, workflow, run, transition, read, context);
}

function transitionEvents(
  cause: string,
  workflow: Workflow,
  before: WorkflowRun | undefined,
  transition: Transition,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const { run, effects } = transition;
  if (before && effects.length === 0 && isDeepStrictEqual(before, run)) return [];
  const events: DomainEvent[] = [];
  const later: RunEffect[] = [];
  for (const effect of effects) {
    if (effect.type === 'setThreadState') {
      if (!read.thread(effect.threadId)) continue;
      events.push({
        kind: 'thread.stateChanged',
        aggregate: effect.threadId,
        payload: { threadId: effect.threadId, state: effect.state, updatedAt: context.now },
      });
      continue;
    }
    if (effect.type === 'startStep') {
      const step = workflow.steps.find((entry) => entry.id === effect.stepId) as WorkflowStep;
      events.push({
        kind: 'thread.created',
        aggregate: effect.threadId,
        payload: stepThread(workflow, run, step, effect.threadId, read, context),
      });
    }
    later.push(effect);
  }
  events.push({
    kind: 'workflowRun.changed',
    aggregate: run.id,
    payload: { cause, run, effects: later },
  });
  events.push(...cardFollowsRun(before, run, read, context));
  events.push(...runNotifications(workflow, run, effects, read, context));
  events.push(...backlogFollowsRun(run, read));
  return events;
}

// Every run state has a card state of the same name; `waiting` is what the card shows as "needs
// you".
const cardStateOfRun = (state: WorkflowRun['state']): CardState => state;

// A card shows the state of the run it started (spec 8, 9). A card run again later follows the
// newer run, so an older run's late changes leave it alone.
function cardFollowsRun(
  before: WorkflowRun | undefined,
  run: WorkflowRun,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  if (run.calendarItemId === null) return [];
  const card = read.calendarItem(run.calendarItemId);
  if (!card || card.source !== 'local') return [];
  if (before !== undefined && card.runId !== run.id) return [];
  const state = cardStateOfRun(run.state);
  if (card.state === state && card.runId === run.id) return [];
  return [
    {
      kind: 'card.stateChanged',
      aggregate: card.id,
      payload: { cardId: card.id, state, runId: run.id, updatedAt: context.now },
    },
  ];
}

const NOTIFICATIONS_KEY = 'scheduler.notifications';

export function notificationsEnabled(read: ReadModel, context: DecideContext): boolean {
  const definition = context.registry[NOTIFICATIONS_KEY];
  if (!definition) return false;
  const { value } = resolveStored(NOTIFICATIONS_KEY, definition, {}, (scope) =>
    read.setting(NOTIFICATIONS_KEY, scope),
  );
  return value === true;
}

export const runPath = (runId: string) => `/workflows/runs/${runId}`;

// A run waiting at a gate or failing tells the user through the notification channel (spec 9).
function runNotifications(
  workflow: Workflow,
  run: WorkflowRun,
  effects: readonly RunEffect[],
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const notices = effects.filter(
    (effect): effect is Extract<RunEffect, { type: 'notify' }> =>
      effect.type === 'notify' && effect.reason !== 'done',
  );
  if (notices.length === 0 || !notificationsEnabled(read, context)) return [];
  const card = run.calendarItemId === null ? undefined : read.calendarItem(run.calendarItemId);
  return notices.map((notice): DomainEvent => {
    const step = workflow.steps.find((entry) => entry.id === notice.stepId);
    const body = [workflow.name, step?.skillName, card?.title].filter(Boolean).join(' · ');
    const waiting = notice.reason === 'waiting';
    const gate = pendingGate(run);
    const id = waiting
      ? `${run.id}:waiting:${notice.stepId ?? ''}:${gate?.position ?? ''}`
      : `${run.id}:failed`;
    const notification: AppNotification = {
      id,
      at: context.now,
      kind: waiting ? 'waiting' : 'failed',
      title: waiting ? 'Waiting for you' : 'Workflow run failed',
      body,
      path: runPath(run.id),
      runId: run.id,
      calendarItemId: run.calendarItemId,
    };
    return { kind: 'notification.sent', aggregate: id, payload: notification };
  });
}

// The thread a step runs in, created idle; the runner sends the step's prompt as its first
// message. Model, effort and permission mode come from the step, then the provider instance
// defaults; the runner fails the step instead of starting a turn while one is still empty.
function stepThread(
  workflow: Workflow,
  run: WorkflowRun,
  step: WorkflowStep,
  threadId: string,
  read: ReadModel,
  context: DecideContext,
): Thread {
  const project = read.project(run.projectId);
  const instance = read.providerInstance(step.providerInstanceId);
  return {
    id: threadId,
    projectId: run.projectId,
    cwd: project?.cwd ?? '.',
    branch: null,
    providerInstanceId: step.providerInstanceId,
    providerSessionId: null,
    title: `${workflow.name}: ${step.skillName}`,
    model: step.model ?? instance?.defaultModel ?? project?.defaultModel ?? '',
    effort: step.effort ?? instance?.defaultEffort ?? '',
    permissionMode: step.permissionMode ?? instance?.defaultPermissionMode ?? '',
    state: 'idle',
    pinned: false,
    runId: run.id,
    stepId: step.id,
    createdAt: context.now,
    updatedAt: context.now,
  };
}

function runContext(
  read: ReadModel,
  context: DecideContext,
  projectId: string,
  backlogBody: string | null,
): EngineContext {
  return {
    now: context.now,
    handoverTemplate: resolvedHandoverTemplate(read, context, projectId),
    invocationFor: (step) => invocationFor(read, step),
    backlogBody,
  };
}

const HANDOVER_KEY = 'workflows.handoverTemplate';

function resolvedHandoverTemplate(read: ReadModel, context: DecideContext, projectId: string) {
  const definition = context.registry[HANDOVER_KEY];
  if (!definition) throw new Error(`${HANDOVER_KEY} is missing from the settings registry`);
  const { value } = resolveStored(HANDOVER_KEY, definition, { projectId }, (scope) =>
    read.setting(HANDOVER_KEY, scope),
  );
  return typeof value === 'string' ? value : String(definition.default);
}

// The step's skill as its provider invokes it. A step names a skill by its name, or a Claude
// plugin skill by plugin:name. Skills are matched by name; with several of that name the
// plugin's own wins. Unknown skills get the plain forms, so a workflow still runs on a machine
// where the skill lives somewhere wow does not scan.
function invocationFor(read: ReadModel, step: WorkflowStep): string {
  const instance = read.providerInstance(step.providerInstanceId);
  if (!instance) {
    throw new CommandRejected('not_found', `No provider instance ${step.providerInstanceId}`);
  }
  const separator = step.skillName.indexOf(':');
  const plugin = separator > 0 ? step.skillName.slice(0, separator) : undefined;
  const name = plugin === undefined ? step.skillName : step.skillName.slice(separator + 1);
  const expected = invocationsFor(name, plugin);
  const named = read.skills().filter((skill) => skill.name === name);
  const skill =
    named.find((entry) => isDeepStrictEqual(entry.invocations, expected)) ??
    (plugin === undefined ? named[0] : undefined);
  return (skill?.invocations ?? expected)[instance.kind];
}

function backlogBodyOf(read: ReadModel, backlogItemId: string | null): string | null {
  if (backlogItemId === null) return null;
  const item = read.backlogItem(backlogItemId);
  if (!item) throw new CommandRejected('not_found', `No backlog item ${backlogItemId}`);
  return item.body;
}

function requireWorkflow(read: ReadModel, workflowId: string): Workflow {
  const workflow = read.workflow(workflowId);
  if (!workflow) throw new CommandRejected('not_found', `No workflow ${workflowId}`);
  return workflow;
}

function engineCall(call: () => Transition): Transition {
  try {
    return call();
  } catch (error) {
    if (error instanceof RunRejected) throw new CommandRejected('rejected', error.message);
    throw error;
  }
}
