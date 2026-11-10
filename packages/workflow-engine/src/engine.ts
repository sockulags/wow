import type {
  FileHash,
  GatePartResult,
  MissedTriggerPolicy,
  RunEffect,
  RunEvent,
  RunUnit,
  StepGate,
  StepRun,
  TriggerState,
  Workflow,
  WorkflowRun,
  WorkflowStep,
} from '@wow/contracts';
import {
  artifactsPart,
  checksNotLookedAt,
  checksNotReadYet,
  checksPart,
  checksTimedOut,
  gateCondition,
  verdictPart,
  waitIsOver,
  type ChecksReading,
  type GateSettings,
} from './gate.js';
import {
  bulletList,
  eventValues,
  renderHandover,
  renderSendBack,
  renderUnitPrompt,
  stepPrompt,
} from './handover.js';

// The workflow run state machine. Pure: every function takes the workflow, the run and an input
// and returns the next run plus the effects the server performs after committing it.
//
// A gate sits between two steps. After a step whose `gateAfter` is set, the step itself waits
// (its turn is over, the user reviews it). Before a step whose `gateBefore` is set, that step
// waits without a thread. One Continue passes the gate between two steps, even when both the
// earlier step's gate after and the later step's gate before are set. Send back is the other
// answer: the step the gate asks about runs again in its own thread, and when that turn ends the
// run waits at the same gate again.
//
// A gate after a step may carry a condition (review loop spec 54 to 58). When the step ends and
// every chosen part holds, the gate passes by itself and the run goes on; when a part does not
// hold the run waits for the user as at any gate; while only the pull request's checks are
// undecided the run waits for them, and `gateChecks` inputs decide it later. The step's `gate`
// records which of these it is and what each part found.

export type RunInput =
  | {
      readonly type: 'stepCompleted';
      readonly stepId: string;
      readonly finalMessage: string;
      readonly artifactsFound: readonly string[];
      // The step's expected artifact globs that matched no file. Absent: every glob is taken as
      // missing when nothing was found, and as found otherwise.
      readonly artifactsMissing?: readonly string[] | undefined;
      // The changed files as the step left them; absent for a run without a base.
      readonly fileHashes?: readonly FileHash[] | undefined;
      // The commit the run's folder is on, when the step's gate asks for checks.
      readonly headSha?: string | undefined;
    }
  | {
      readonly type: 'baseRecorded';
      readonly baseSha: string;
      readonly files: readonly FileHash[];
    }
  | { readonly type: 'stepFailed'; readonly stepId: string; readonly error: string }
  // The folder the run was to work in could not be made, so no step may begin.
  | { readonly type: 'setupFailed'; readonly error: string }
  // A look at a gate that waits for checks: what the host shows now, or null when nothing was
  // read since the step ended (then only the time waited can decide).
  | {
      readonly type: 'gateChecks';
      readonly stepId: string;
      readonly reading: ChecksReading | null;
    }
  | { readonly type: 'continue' }
  | { readonly type: 'sendBack'; readonly note: string }
  | { readonly type: 'stop' }
  | {
      readonly type: 'artifactsFound';
      readonly found: readonly { readonly stepId: string; readonly paths: readonly string[] }[];
    };

export interface EngineContext extends GateSettings {
  readonly now: string;
  // The `workflows.handoverTemplate` setting for the run's project.
  readonly handoverTemplate: string;
  // The `workflows.sendBackTemplate` setting for the run's project.
  readonly sendBackTemplate: string;
  // The `workflows.unitPromptTemplate` setting for the run's project; used by a unit's run only.
  readonly unitPromptTemplate: string;
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
  // The unit the run delivers, when a plan run starts it.
  readonly unit?: RunUnit | null | undefined;
  // What started the run, when an event trigger did.
  readonly event?: RunEvent | null | undefined;
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

// The step a gate asks the user to judge: the one that just ended for a gate after it, the one
// before for a gate before the next step. Undefined before the first step, where nothing ran.
export function reviewedStepIndex(run: WorkflowRun): number | undefined {
  const gate = pendingGate(run);
  if (!gate) return undefined;
  const index = gate.position === 'after' ? gate.stepIndex : gate.stepIndex - 1;
  return index >= 0 ? index : undefined;
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
    baseSha: null,
    baseFiles: null,
    ...(input.unit ? { unit: input.unit } : {}),
    ...(input.event ? { event: input.event } : {}),
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
    case 'baseRecorded':
      return recordBase(run, input);
    case 'stepCompleted':
      return completeStep(workflow, run, input, context);
    case 'stepFailed':
      return failStep(run, input.stepId, input.error, context);
    case 'setupFailed':
      return failSetup(run, input.error, context);
    case 'gateChecks':
      return decideChecks(workflow, run, input, context);
    case 'continue':
      return continueRun(workflow, run, context);
    case 'sendBack':
      return sendBack(workflow, run, input.note, context);
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
  const finished: StepRun = {
    ...current,
    endedAt: context.now,
    finalMessage: input.finalMessage,
    artifactsFound: [...input.artifactsFound],
    state: step.gateAfter ? 'waiting' : 'done',
    ...(input.fileHashes ? { fileHashes: [...input.fileHashes] } : {}),
  };
  // A step sent back is judged again from nothing.
  delete finished.gate;

  if (!step.gateAfter) return afterStep(workflow, run, index, finished, context);
  const condition = gateCondition(step, context);
  if (!condition) return waitForUser(run, index, finished);

  const missing =
    input.artifactsMissing ?? (input.artifactsFound.length === 0 ? step.expectedArtifacts : []);
  const parts = condition.map((part): GatePartResult => {
    switch (part) {
      case 'verdict':
        return verdictPart(input.finalMessage, context.verdictApprovedLine);
      case 'artifacts':
        return artifactsPart(step.expectedArtifacts, missing);
      case 'checks':
        return checksNotReadYet();
    }
  });
  const gate = (state: StepGate['state'], results: GatePartResult[]): StepGate => ({
    state,
    parts: results,
    since: context.now,
    ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
    at: context.now,
  });
  if (parts.some((part) => part.state === 'failed')) {
    // Checks are not waited for when the gate cannot pass anyway.
    const told = parts.map((part) => (part.part === 'checks' ? checksNotLookedAt() : part));
    return waitForUser(run, index, { ...finished, gate: gate('waitingForUser', told) });
  }
  if (parts.some((part) => part.state === 'pending')) {
    // Nobody is asked yet: the run waits for the host, and the user is told when it is their
    // turn after all.
    const waiting: StepRun = { ...finished, gate: gate('waitingForChecks', parts) };
    return {
      run: { ...run, steps: replaceStep(run.steps, index, waiting), state: 'waiting' },
      effects: [],
    };
  }
  return afterStep(
    workflow,
    run,
    index,
    { ...finished, state: 'done', gate: gate('passedByItself', parts) },
    context,
  );
}

// The run waits for the user after the step, as at any gate after a step.
function waitForUser(run: WorkflowRun, index: number, waiting: StepRun): Transition {
  return {
    run: { ...run, steps: replaceStep(run.steps, index, waiting), state: 'waiting' },
    effects: [
      ...threadState(waiting.threadId, 'needs_you'),
      { type: 'notify', runId: run.id, stepId: waiting.stepId, reason: 'waiting' },
    ],
  };
}

// What follows a step that is done with no gate after it left to answer: the end of the run,
// the next step's own gate before it, or the next step.
function afterStep(
  workflow: Workflow,
  run: WorkflowRun,
  index: number,
  done: StepRun,
  context: EngineContext,
): Transition {
  const steps = replaceStep(run.steps, index, done);
  const threadId = done.threadId;
  const next = workflow.steps[index + 1];
  if (!next) {
    return finish({ ...run, steps }, 'done', context, threadState(threadId, 'done'));
  }
  if (next.gateBefore) {
    // The previous step's thread is where the user sees that the run needs them.
    return waitBefore({ ...run, steps }, index + 1, threadState(threadId, 'needs_you'));
  }
  return beginStep(workflow, { ...run, steps }, index + 1, context, threadState(threadId, 'done'));
}

// A gate that waits for its pull request's checks is looked at again: with what the host shows
// now, or because time has passed. Anything else leaves the run as it is, so a late look at a
// gate that was answered meanwhile changes nothing.
function decideChecks(
  workflow: Workflow,
  run: WorkflowRun,
  input: Extract<RunInput, { type: 'gateChecks' }>,
  context: EngineContext,
): Transition {
  const index = run.currentStep;
  const current = run.steps[index];
  const gate = current?.gate;
  if (
    run.state !== 'waiting' ||
    !current ||
    current.stepId !== input.stepId ||
    gate?.state !== 'waitingForChecks'
  ) {
    return { run, effects: [] };
  }
  const last = gate.parts.find((part) => part.part === 'checks') ?? checksNotReadYet();
  const seen = input.reading ? checksPart(input.reading) : last;
  const checks =
    seen.state === 'pending' &&
    waitIsOver(gate.since, context.now, context.gateChecksTimeoutMinutes)
      ? checksTimedOut(seen, context.gateChecksTimeoutMinutes)
      : seen;
  const parts = gate.parts.map((part) => (part.part === 'checks' ? checks : part));
  if (checks.state === 'pending') {
    if (checks.detail === last.detail) return { run, effects: [] };
    const waiting: StepRun = { ...current, gate: { ...gate, parts } };
    return { run: { ...run, steps: replaceStep(run.steps, index, waiting) }, effects: [] };
  }
  if (checks.state === 'failed') {
    return waitForUser(run, index, {
      ...current,
      gate: { ...gate, state: 'waitingForUser', parts, at: context.now },
    });
  }
  return afterStep(
    workflow,
    run,
    index,
    {
      ...current,
      state: 'done',
      gate: { ...gate, state: 'passedByItself', parts, at: context.now },
    },
    context,
  );
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

// The run fails at the step it is on, whether that step waits at its gate or was about to get
// its prompt. Setup is over before any turn starts, so there is nothing to interrupt.
function failSetup(run: WorkflowRun, error: string, context: EngineContext): Transition {
  if (run.state !== 'running' && run.state !== 'waiting') {
    throw new RunRejected(`Run ${run.id} is already ${run.state}`);
  }
  const current = run.steps[run.currentStep] as StepRun;
  const steps = replaceStep(run.steps, run.currentStep, {
    ...current,
    state: 'failed',
    endedAt: context.now,
    error,
  });
  return {
    run: { ...run, steps, state: 'failed', endedAt: context.now },
    effects: [
      ...threadState(current.threadId, 'failed'),
      { type: 'notify', runId: run.id, stepId: current.stepId, reason: 'failed' },
    ],
  };
}

function continueRun(workflow: Workflow, run: WorkflowRun, context: EngineContext): Transition {
  const gate = pendingGate(run);
  if (!gate) throw new RunRejected(`Run ${run.id} is ${run.state}, not waiting for you`);
  const current = run.steps[gate.stepIndex] as StepRun;

  if (gate.position === 'after') {
    const steps = replaceStep(run.steps, gate.stepIndex, {
      ...current,
      state: 'done',
      // A gate with a condition records that the user passed it.
      ...(current.gate
        ? { gate: { ...current.gate, state: 'passedByUser' as const, at: context.now } }
        : {}),
    });
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

function sendBack(
  workflow: Workflow,
  run: WorkflowRun,
  note: string,
  context: EngineContext,
): Transition {
  const gate = pendingGate(run);
  if (!gate) {
    throw new RunRejected(
      `Run ${run.id} is ${run.state}, not waiting for you, so there is nothing to send back`,
    );
  }
  const text = note.trim();
  if (text === '') throw new RunRejected('Write what should change before you send the step back');
  const index = reviewedStepIndex(run);
  const reviewed = index === undefined ? undefined : run.steps[index];
  const threadId = reviewed?.threadId;
  if (index === undefined || !reviewed || !threadId) {
    throw new RunRejected(`Run ${run.id} waits before its first step: no step has run yet`);
  }
  const step = workflow.steps[index] as WorkflowStep;
  const attempt = (reviewed.attempt ?? 1) + 1;
  // The last result stays on the step until the new turn ends and replaces it.
  const rerun: StepRun = { ...reviewed, state: 'running', startedAt: context.now, attempt };
  delete rerun.endedAt;
  delete rerun.gate;
  const steps = run.steps.map((entry, at): StepRun => {
    if (at === index) return rerun;
    // A step that waited before its gate goes back to not started while the one before reruns.
    if (at === gate.stepIndex) return { ...entry, state: 'not_started' };
    return entry;
  });
  const rendered = renderSendBack(context.sendBackTemplate, {
    note: text,
    skill: step.skillName,
    attempt: String(attempt),
  });
  // A template emptied in the settings still sends what the reviewer wrote.
  const prompt = rendered === '' ? text : rendered;
  return {
    run: { ...run, steps, currentStep: index, state: 'running' },
    effects: [{ type: 'sendBack', runId: run.id, stepId: step.id, threadId, attempt, prompt }],
  };
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
        // A gate nobody passed leaves no record of how it was passed.
        const { gate: _unanswered, ...ended } = step;
        return { ...ended, state: 'done' };
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

// The first base stands: a run has one starting point, whatever is reported later.
function recordBase(
  run: WorkflowRun,
  input: Extract<RunInput, { type: 'baseRecorded' }>,
): Transition {
  if (run.baseSha) return { run, effects: [] };
  return { run: { ...run, baseSha: input.baseSha, baseFiles: [...input.files] }, effects: [] };
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
    ...eventValues(run.event),
  });
  // Every step of a unit's run is told which unit it works on (review loop spec 40).
  const unit = run.unit
    ? renderUnitPrompt(context.unitPromptTemplate, {
        intentId: run.unit.intentId,
        unitKey: run.unit.unitKey,
        unitTitle: run.unit.title,
      })
    : '';
  return stepPrompt(context.invocationFor(step), step.extraPrompt, handover, unit);
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
