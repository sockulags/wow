import type {
  MissedTriggerPolicy,
  RunEffect,
  StepRun,
  TriggerState,
  Workflow,
  WorkflowRun,
  WorkflowStep,
} from '@wow/contracts';
import { bulletList, renderHandover, stepPrompt } from './handover.js';

// The workflow run state machine. Pure: every function takes the workflow, the run and an input
// and returns the next run plus the effects the server performs after committing it.
//
// A gate sits between two steps. After a step whose `gateAfter` is set, the step itself waits
// (its turn is over, the user reviews it). Before a step whose `gateBefore` is set, that step
// waits without a thread. One Continue passes the gate between two steps, even when both the
// earlier step's gate after and the later step's gate before are set.

export type RunInput =
  | {
      readonly type: 'stepCompleted';
      readonly stepId: string;
      readonly finalMessage: string;
      readonly artifactsFound: readonly string[];
    }
  | { readonly type: 'stepFailed'; readonly stepId: string; readonly error: string }
  | { readonly type: 'continue' }
  | { readonly type: 'stop' }
  | {
      readonly type: 'artifactsFound';
      readonly found: readonly { readonly stepId: string; readonly paths: readonly string[] }[];
    };

export interface EngineContext {
  readonly now: string;
  // The `workflows.handoverTemplate` setting for the run's project.
  readonly handoverTemplate: string;
  // The step's skill as its provider invokes it: `/name` for Claude, `$name` for Codex.
  readonly invocationFor: (step: WorkflowStep) => string;
  readonly backlogBody?: string | null | undefined;
}

export interface Transition {
  readonly run: WorkflowRun;
  readonly effects: RunEffect[];
}

export interface NewRun {
  readonly runId: string;
  readonly projectId: string;
  readonly calendarItemId?: string | null | undefined;
  readonly backlogItemId?: string | null | undefined;
}

export class RunRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunRejected';
  }
}

// Threads of a run get stable ids, so performing a transition twice cannot start two threads.
export const stepThreadId = (runId: string, stepId: string): string => `${runId}.${stepId}`;

export function initialStepRuns(steps: readonly WorkflowStep[]): StepRun[] {
  return steps.map((step) => ({ stepId: step.id, state: 'not_started', artifactsFound: [] }));
}

export interface PendingGate {
  readonly stepIndex: number;
  readonly position: 'before' | 'after';
}

// Where a waiting run is stopped: after a finished step, or before one that has not started.
export function pendingGate(run: WorkflowRun): PendingGate | undefined {
  if (run.state !== 'waiting') return undefined;
  const step = run.steps[run.currentStep];
  if (!step) return undefined;
  return { stepIndex: run.currentStep, position: step.endedAt ? 'after' : 'before' };
}

export function startRun(workflow: Workflow, input: NewRun, context: EngineContext): Transition {
  const [first] = workflow.steps;
  if (!first) throw new RunRejected(`Workflow ${workflow.name} has no steps`);
  const run: WorkflowRun = {
    id: input.runId,
    workflowId: workflow.id,
    projectId: input.projectId,
    calendarItemId: input.calendarItemId ?? null,
    backlogItemId: input.backlogItemId ?? null,
    state: 'running',
    currentStep: 0,
    steps: initialStepRuns(workflow.steps),
    startedAt: context.now,
    endedAt: null,
  };
  if (first.gateBefore) return waitBefore(run, 0, []);
  return beginStep(workflow, run, 0, context, []);
}

export function advance(
  workflow: Workflow,
  run: WorkflowRun,
  input: RunInput,
  context: EngineContext,
): Transition {
  const runStepIds = run.steps.map((step) => step.stepId).join('\n');
  if (runStepIds !== workflow.steps.map((step) => step.id).join('\n')) {
    throw new RunRejected(`Workflow ${workflow.name} no longer has the steps of run ${run.id}`);
  }
  switch (input.type) {
    case 'artifactsFound':
      return recordArtifacts(run, input.found);
    case 'stepCompleted':
      return completeStep(workflow, run, input, context);
    case 'stepFailed':
      return failStep(run, input.stepId, input.error, context);
    case 'continue':
      return continueRun(workflow, run, context);
    case 'stop':
      return stopRun(run, context);
  }
}

// What happens to a trigger whose time passed while the server was down (behavior 12).
export interface MissedOutcome {
  readonly triggerState: Extract<TriggerState, 'fired' | 'missed'>;
  readonly startRun: boolean;
  // `mark` offers a one-click "Run now" on the card; `skip` does not.
  readonly offerRunNow: boolean;
}

export function missedTriggerOutcome(policy: MissedTriggerPolicy): MissedOutcome {
  switch (policy) {
    case 'run':
      return { triggerState: 'fired', startRun: true, offerRunNow: false };
    case 'mark':
      return { triggerState: 'missed', startRun: false, offerRunNow: true };
    case 'skip':
      return { triggerState: 'missed', startRun: false, offerRunNow: false };
  }
}

function completeStep(
  workflow: Workflow,
  run: WorkflowRun,
  input: Extract<RunInput, { type: 'stepCompleted' }>,
  context: EngineContext,
): Transition {
  const index = runningStepIndex(run, input.stepId);
  const current = run.steps[index] as StepRun;
  const step = workflow.steps[index] as WorkflowStep;
  const threadId = current.threadId;
  const finished: StepRun = {
    ...current,
    endedAt: context.now,
    finalMessage: input.finalMessage,
    artifactsFound: [...input.artifactsFound],
    state: step.gateAfter ? 'waiting' : 'done',
  };
  const steps = replaceStep(run.steps, index, finished);
  const next = workflow.steps[index + 1];

  if (step.gateAfter) {
    return {
      run: { ...run, steps, state: 'waiting' },
      effects: [
        ...threadState(threadId, 'needs_you'),
        { type: 'notify', runId: run.id, stepId: step.id, reason: 'waiting' },
      ],
    };
  }
  if (!next) {
    return finish({ ...run, steps }, 'done', context, threadState(threadId, 'done'));
  }
  if (next.gateBefore) {
    // The previous step's thread is where the user sees that the run needs them.
    return waitBefore({ ...run, steps }, index + 1, threadState(threadId, 'needs_you'));
  }
  return beginStep(workflow, { ...run, steps }, index + 1, context, threadState(threadId, 'done'));
}

function failStep(run: WorkflowRun, stepId: string, error: string, context: EngineContext) {
  const index = runningStepIndex(run, stepId);
  const current = run.steps[index] as StepRun;
  const steps = replaceStep(run.steps, index, {
    ...current,
    state: 'failed',
    endedAt: context.now,
    error,
  });
  return {
    run: { ...run, steps, state: 'failed', endedAt: context.now },
    effects: [
      ...threadState(current.threadId, 'failed'),
      { type: 'notify', runId: run.id, stepId, reason: 'failed' },
    ],
  } satisfies Transition;
}

function continueRun(workflow: Workflow, run: WorkflowRun, context: EngineContext): Transition {
  const gate = pendingGate(run);
  if (!gate) throw new RunRejected(`Run ${run.id} is ${run.state}, not waiting for you`);
  const current = run.steps[gate.stepIndex] as StepRun;

  if (gate.position === 'after') {
    const steps = replaceStep(run.steps, gate.stepIndex, { ...current, state: 'done' });
    const released = threadState(current.threadId, 'done');
    const nextIndex = gate.stepIndex + 1;
    if (nextIndex >= workflow.steps.length) {
      return finish({ ...run, steps }, 'done', context, released);
    }
    return beginStep(workflow, { ...run, steps }, nextIndex, context, released);
  }

  const previous = run.steps[gate.stepIndex - 1];
  return beginStep(workflow, run, gate.stepIndex, context, threadState(previous?.threadId, 'done'));
}

function stopRun(run: WorkflowRun, context: EngineContext): Transition {
  if (run.state !== 'running' && run.state !== 'waiting') {
    throw new RunRejected(`Run ${run.id} is already ${run.state}`);
  }
  const effects: RunEffect[] = [];
  // The threads are kept (behavior 13); a running turn is interrupted and its step marked failed.
  const steps = run.steps.map((step): StepRun => {
    if (step.state === 'running') {
      if (step.threadId) effects.push({ type: 'interrupt', threadId: step.threadId });
      effects.push(...threadState(step.threadId, 'failed'));
      return { ...step, state: 'failed', endedAt: context.now, error: 'Stopped' };
    }
    if (step.state === 'waiting') {
      if (step.endedAt) {
        effects.push(...threadState(step.threadId, 'done'));
        return { ...step, state: 'done' };
      }
      return { ...step, state: 'not_started' };
    }
    return step;
  });
  const gate = pendingGate(run);
  if (gate?.position === 'before') {
    effects.push(...threadState(run.steps[gate.stepIndex - 1]?.threadId, 'done'));
  }
  return { run: { ...run, steps, state: 'stopped', endedAt: context.now }, effects };
}

function recordArtifacts(
  run: WorkflowRun,
  found: Extract<RunInput, { type: 'artifactsFound' }>['found'],
): Transition {
  const byStep = new Map(found.map((entry) => [entry.stepId, entry.paths]));
  for (const stepId of byStep.keys()) {
    if (!run.steps.some((step) => step.stepId === stepId)) {
      throw new RunRejected(`Run ${run.id} has no step ${stepId}`);
    }
  }
  const steps = run.steps.map((step) => {
    const paths = byStep.get(step.stepId);
    return paths ? { ...step, artifactsFound: [...paths] } : step;
  });
  return { run: { ...run, steps }, effects: [] };
}

function beginStep(
  workflow: Workflow,
  run: WorkflowRun,
  index: number,
  context: EngineContext,
  effects: RunEffect[],
): Transition {
  const step = workflow.steps[index] as WorkflowStep;
  const threadId = stepThreadId(run.id, step.id);
  const prompt = renderStepPrompt(workflow, run, index, context);
  const steps = replaceStep(run.steps, index, {
    stepId: step.id,
    state: 'running',
    threadId,
    startedAt: context.now,
    artifactsFound: [],
  });
  return {
    run: { ...run, steps, currentStep: index, state: 'running' },
    effects: [...effects, { type: 'startStep', runId: run.id, stepId: step.id, threadId, prompt }],
  };
}

function waitBefore(run: WorkflowRun, index: number, effects: RunEffect[]): Transition {
  const current = run.steps[index] as StepRun;
  const steps = replaceStep(run.steps, index, { ...current, state: 'waiting' });
  return {
    run: { ...run, steps, currentStep: index, state: 'waiting' },
    effects: [
      ...effects,
      { type: 'notify', runId: run.id, stepId: current.stepId, reason: 'waiting' },
    ],
  };
}

function finish(
  run: WorkflowRun,
  state: 'done',
  context: EngineContext,
  effects: RunEffect[],
): Transition {
  return {
    run: { ...run, state, endedAt: context.now },
    effects: [...effects, { type: 'notify', runId: run.id, stepId: null, reason: state }],
  };
}

export function renderStepPrompt(
  workflow: Workflow,
  run: WorkflowRun,
  index: number,
  context: EngineContext,
): string {
  const step = workflow.steps[index] as WorkflowStep;
  const previousStep = index > 0 ? workflow.steps[index - 1] : undefined;
  const previousRun = index > 0 ? run.steps[index - 1] : undefined;
  const earlierArtifacts = run.steps.slice(0, index).flatMap((entry) => entry.artifactsFound);
  const handover = renderHandover(context.handoverTemplate, {
    previousStep: previousStep?.skillName ?? '',
    previousMessage: previousRun?.finalMessage ?? '',
    backlogBody: context.backlogBody ?? '',
    previousArtifacts: bulletList([...new Set(earlierArtifacts)]),
    expectedArtifacts: bulletList(step.expectedArtifacts),
  });
  return stepPrompt(context.invocationFor(step), step.extraPrompt, handover);
}

function runningStepIndex(run: WorkflowRun, stepId: string): number {
  const step = run.steps[run.currentStep];
  if (run.state !== 'running' || step?.stepId !== stepId || step.state !== 'running') {
    throw new RunRejected(`Step ${stepId} of run ${run.id} is not running`);
  }
  return run.currentStep;
}

const replaceStep = (steps: readonly StepRun[], index: number, step: StepRun): StepRun[] =>
  steps.map((entry, at) => (at === index ? step : entry));

const threadState = (
  threadId: string | undefined,
  state: Extract<RunEffect, { type: 'setThreadState' }>['state'],
): RunEffect[] => (threadId ? [{ type: 'setThreadState', threadId, state }] : []);
