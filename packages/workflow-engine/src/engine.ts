import {
  automaticSkills,
  intentUnitLine,
  promptShown,
  promptWithSkills,
  ruleConditionText,
  type BuiltInSkillValues,
  type PromptSkillPart,
  type SentSkill,
  type SkillRef,
  type FileHash,
  type GatePartResult,
  type MissedTriggerPolicy,
  type PathNext,
  type PathVisit,
  type RuleCondition,
  type RunEffect,
  type RunEvent,
  type RunUnit,
  type StepFacts,
  type StepGate,
  type StepRule,
  type StepRun,
  type TriggerState,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
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
  renderGoBack,
  renderHandover,
  renderSendBack,
  renderUnitPrompt,
  stepPrompt,
} from './handover.js';
import {
  failedRule,
  hasRules,
  lastVisit,
  limitSentence,
  readVerdict,
  ruleThatHolds,
  type RuleSettings,
} from './rules.js';

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
//
// A step may carry rules (workflow branches spec 1 to 13). Once the step has ended and its gate,
// if any, has passed, the first rule that holds decides the next step: an earlier one (it runs
// again in its own thread), a later one (the steps between are skipped for this pass) or the end
// of the run. Without a rule that holds the run goes to the next step in the list. `run.path`
// records every start of a step and why the run went where it went next.

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
  | {
      readonly type: 'stepFailed';
      readonly stepId: string;
      readonly error: string;
      // The user stopped the step's turn: no rule is followed.
      readonly stopped?: boolean | undefined;
    }
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

export interface EngineContext extends GateSettings, RuleSettings {
  readonly now: string;
  // The `workflows.handoverTemplate` setting for the run's project.
  readonly handoverTemplate: string;
  // The `workflows.sendBackTemplate` setting for the run's project.
  readonly sendBackTemplate: string;
  // The `workflows.unitPromptTemplate` setting for the run's project; used by a unit's run only.
  readonly unitPromptTemplate: string;
  // The step's skill as its provider invokes it: `/name` for Claude, `$name` for Codex. Used for
  // runs stored before wow skills, and when `skillFor` is absent.
  readonly invocationFor: (step: WorkflowStep) => string;
  // A skill the step names, for the step's provider: a wow skill's text filled in for this send,
  // or a folder skill's invocation. Undefined when it no longer exists (wow skills spec 15).
  readonly skillFor?: (
    step: WorkflowStep,
    ref: SkillRef,
    values: BuiltInSkillValues,
  ) => ResolvedSkill | undefined;
  // The `workflows.attachBuiltInSkills` setting for the run's project (spec 12).
  readonly attachBuiltInSkills?: boolean;
  readonly backlogBody?: string | null | undefined;
}

export type ResolvedSkill =
  | { readonly kind: 'text'; readonly name: string; readonly source: string; readonly text: string }
  | {
      readonly kind: 'invoke';
      readonly name: string;
      readonly source: string;
      readonly invocation: string;
    };

// A step's first prompt: what is sent, what the thread shows and the skills it was made with.
// `missing` names a skill the step needs that no longer exists; then nothing is sent.
export interface StepPrompt {
  readonly prompt: string;
  readonly shown?: string;
  readonly skills?: SentSkill[];
  readonly missing?: string;
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

// Where a waiting run is stopped: after a step that ended, or before one that is about to start.
// A step that ran in an earlier pass keeps its last result while the run waits before it, so
// the path tells the two apart: the run waits after a step when that step's visit is the last
// one and nothing has decided where the run goes next. A run from before paths were kept has
// only run each step once, and there an ended step can only be waited after.
export function pendingGate(run: WorkflowRun): PendingGate | undefined {
  if (run.state !== 'waiting') return undefined;
  const step = run.steps[run.currentStep];
  if (!step) return undefined;
  if (step.waits) return { stepIndex: run.currentStep, position: step.waits };
  const last = lastVisit(run.path);
  const after = run.path
    ? last !== undefined && last.stepId === step.stepId && last.ended !== null && last.next === null
    : Boolean(step.endedAt) && step.gate?.state !== 'waitingAtLimit';
  return { stepIndex: run.currentStep, position: after ? 'after' : 'before' };
}

interface Came {
  readonly index: number;
  readonly next: PathNext;
}

// The step the run came from when it waits before a step, and what sent it there. By the list
// that is the step before; a rule can come from anywhere.
function cameFrom(run: WorkflowRun, stepIndex: number): Came | undefined {
  const target = run.steps[stepIndex];
  const last = lastVisit(run.path);
  if (last?.next && last.next.to.type === 'step' && last.next.to.stepId === target?.stepId) {
    const index = run.steps.findIndex((entry) => entry.stepId === last.stepId);
    if (index >= 0) return { index, next: last.next };
  }
  if (stepIndex === 0 || !target) return undefined;
  return {
    index: stepIndex - 1,
    next: { to: { type: 'step', stepId: target.stepId }, by: 'list' },
  };
}

// The step a gate asks the user to judge: the one that just ended for a gate after it, the one
// the run came from for a gate before a step. Undefined before the first step, where nothing ran.
export function reviewedStepIndex(run: WorkflowRun): number | undefined {
  const gate = pendingGate(run);
  if (!gate) return undefined;
  return gate.position === 'after' ? gate.stepIndex : cameFrom(run, gate.stepIndex)?.index;
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
    path: [],
    wowSkills: true,
    ...(input.unit ? { unit: input.unit } : {}),
    ...(input.event ? { event: input.event } : {}),
  };
  if (first.gateBefore) return waitBefore(run, 0, []);
  return begin(workflow, run, { from: undefined, to: 0, by: 'list' }, context, []);
}

// Only the step the run waits at says where it waits; every other step forgets it.
function settleWaits({ run, effects }: Transition): Transition {
  if (
    !run.steps.some(
      (entry, at) => entry.waits && (run.state !== 'waiting' || at !== run.currentStep),
    )
  ) {
    return { run, effects };
  }
  const steps = run.steps.map((entry, at): StepRun => {
    if (!entry.waits || (run.state === 'waiting' && at === run.currentStep)) return entry;
    const { waits: _left, ...rest } = entry;
    return rest;
  });
  return { run: { ...run, steps }, effects };
}

export function advance(
  workflow: Workflow,
  run: WorkflowRun,
  input: RunInput,
  context: EngineContext,
): Transition {
  return settleWaits(transit(workflow, run, input, context));
}

function transit(
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
      return failStep(workflow, run, input, context);
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
  before: WorkflowRun,
  input: Extract<RunInput, { type: 'stepCompleted' }>,
  context: EngineContext,
): Transition {
  const index = runningStepIndex(before, input.stepId);
  const run = endVisit(before, 'done', context.now);
  const current = run.steps[index] as StepRun;
  const step = workflow.steps[index] as WorkflowStep;
  const missing =
    input.artifactsMissing ?? (input.artifactsFound.length === 0 ? step.expectedArtifacts : []);
  // The facts are read now and kept: the rules are followed once the gate has passed, which
  // may be much later.
  const facts: StepFacts | undefined = hasRules(step)
    ? {
        verdict: readVerdict(input.finalMessage, context),
        artifacts:
          step.expectedArtifacts.length > 0 &&
          !step.expectedArtifacts.some((glob) => missing.includes(glob))
            ? 'found'
            : 'missing',
        ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
      }
    : undefined;
  const finished: StepRun = {
    ...current,
    endedAt: context.now,
    finalMessage: input.finalMessage,
    artifactsFound: [...input.artifactsFound],
    state: step.gateAfter ? 'waiting' : 'done',
    ...(input.fileHashes ? { fileHashes: [...input.fileHashes] } : {}),
  };
  const began = input.fileHashes ? hashesBefore(before) : undefined;
  if (began) finished.fileHashesBefore = [...began];
  // A step that runs again is judged again from nothing.
  delete finished.gate;
  delete finished.error;
  delete finished.facts;
  if (facts) finished.facts = facts;

  if (!step.gateAfter) return route(workflow, run, index, finished, context, false);
  const condition = gateCondition(step, context);
  if (!condition) return waitForUser(run, index, finished);

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
    const waiting: StepRun = { ...finished, waits: 'after', gate: gate('waitingForChecks', parts) };
    return {
      run: { ...run, steps: replaceStep(run.steps, index, waiting), state: 'waiting' },
      effects: [],
    };
  }
  return route(
    workflow,
    run,
    index,
    { ...finished, state: 'done', gate: gate('passedByItself', parts) },
    context,
    false,
  );
}

// What the changed files were when the running visit began: as the visit that ended done
// before it left them, or as the run began. A step keeps only its latest hashes, which are
// still that visit's now, while this one ends. Undefined without a path to tell the order.
function hashesBefore(run: WorkflowRun): readonly FileHash[] | undefined {
  if (!run.path) return undefined;
  const previous = run.path.slice(0, -1).findLast((visit) => visit.ended === 'done');
  if (!previous) return run.baseFiles ?? undefined;
  return run.steps.find((entry) => entry.stepId === previous.stepId)?.fileHashes;
}

// The run waits for the user after the step, as at any gate after a step.
function waitForUser(run: WorkflowRun, index: number, stepRun: StepRun): Transition {
  const waiting: StepRun = { ...stepRun, waits: 'after' };
  return {
    run: { ...run, steps: replaceStep(run.steps, index, waiting), state: 'waiting' },
    effects: [
      ...threadState(waiting.threadId, 'needs_you'),
      { type: 'notify', runId: run.id, stepId: waiting.stepId, reason: 'waiting' },
    ],
  };
}

const stepIndexOf = (workflow: Workflow, stepId: string): number =>
  workflow.steps.findIndex((entry) => entry.id === stepId);

// A rule whose step is gone cannot be followed. Saving refuses such a rule, so this only keeps
// a run from getting stuck on a workflow stored some other way.
const followable = (workflow: Workflow, step: WorkflowStep): StepRule[] =>
  (step.rules ?? []).filter(
    ({ goTo }) => goTo.type === 'end' || stepIndexOf(workflow, goTo.stepId) >= 0,
  );

const targetName = (workflow: Workflow, rule: StepRule): string =>
  rule.goTo.type === 'end'
    ? 'End'
    : (workflow.steps[stepIndexOf(workflow, rule.goTo.stepId)]?.skillName ?? rule.goTo.stepId);

// What follows a step that is done with no gate after it left to answer (workflow branches
// spec 1): where its first rule that holds says, else the next step in the list, else the end
// of the run. `byUser`: the user just approved the gate after the step, which also passes the
// next step's gate before when the run goes on by the list.
function route(
  workflow: Workflow,
  run: WorkflowRun,
  index: number,
  done: StepRun,
  context: EngineContext,
  byUser: boolean,
): Transition {
  const step = workflow.steps[index] as WorkflowStep;
  const held = done.facts ? ruleThatHolds(followable(workflow, step), done.facts) : 'none';
  if (held === 'needsChecks') {
    // A rule asks about the pull request's checks and nothing has read them: the run waits for
    // them as a gate does (spec 3), and `gateChecks` inputs decide it.
    const waiting: StepRun = {
      ...done,
      state: 'waiting',
      waits: 'after',
      gate: {
        state: 'waitingForChecks',
        parts: [checksNotReadYet()],
        forRules: true,
        since: context.now,
        ...(done.facts?.headSha === undefined ? {} : { headSha: done.facts.headSha }),
        at: context.now,
      },
    };
    return {
      run: { ...run, steps: replaceStep(run.steps, index, waiting), state: 'waiting' },
      effects: byUser ? threadState(done.threadId, 'done') : [],
    };
  }
  const settled = { ...run, steps: replaceStep(run.steps, index, done) };
  if (held === 'none') {
    const to = index + 1;
    const last = to >= workflow.steps.length;
    const reason = hasRules(step)
      ? `no rule held → ${last ? 'End' : 'next step'}`
      : last
        ? 'last step'
        : 'next step';
    if (last) return finish(settled, { to: { type: 'end' }, by: 'list' }, reason, context, []);
    return moveTo(workflow, settled, { from: index, to, by: 'list' }, reason, context, [], byUser);
  }
  const reason = `${ruleConditionText(held.when)} → ${targetName(workflow, held)}`;
  if (held.goTo.type === 'end') {
    return finish(settled, { to: held.goTo, by: 'rule', when: held.when }, reason, context, []);
  }
  const to = stepIndexOf(workflow, held.goTo.stepId);
  return moveTo(
    workflow,
    settled,
    { from: index, to, by: 'rule', when: held.when },
    reason,
    context,
    [],
    false,
  );
}

interface Move {
  // Undefined only for the first step of a run, which nothing comes before.
  readonly from: number | undefined;
  readonly to: number;
  readonly by: PathNext['by'];
  readonly when?: RuleCondition | undefined;
}

const nextOf = (workflow: Workflow, move: Move): PathNext => ({
  to: { type: 'step', stepId: (workflow.steps[move.to] as WorkflowStep).id },
  by: move.by,
  ...(move.when ? { when: move.when } : {}),
});

// How often the step has started in this run.
const startsOf = (step: StepRun | undefined): number => (step?.threadId ? (step.attempt ?? 1) : 0);

// The thread of the step the run came from shows where the run stands, except a failed step's
// thread, which keeps saying that it failed.
const fromThread = (
  from: StepRun | undefined,
  state: Extract<RunEffect, { type: 'setThreadState' }>['state'],
): RunEffect[] => (from && from.state !== 'failed' ? threadState(from.threadId, state) : []);

// The run goes from one step to another: the steps a rule jumps over are skipped for this pass,
// a step at its limit waits for the user (spec 9), a gate before the step waits as on its first
// visit (spec 10), and otherwise the step starts.
function moveTo(
  workflow: Workflow,
  run: WorkflowRun,
  move: Move & { readonly from: number },
  reason: string,
  context: EngineContext,
  effects: RunEffect[],
  passGateBefore: boolean,
): Transition {
  const decided = decideVisit(run, nextOf(workflow, move), reason);
  const steps = decided.steps.map((entry, at): StepRun =>
    move.by === 'rule' && at > move.from && at < move.to ? { ...entry, state: 'skipped' } : entry,
  );
  const next = { ...decided, steps };
  const target = workflow.steps[move.to] as WorkflowStep;
  const from = steps[move.from];
  const starts = startsOf(steps[move.to]);
  if (starts >= (workflow.maxStepVisits ?? context.maxStepVisits)) {
    const detail = limitSentence(target.skillName, starts);
    const waiting: StepRun = {
      ...(steps[move.to] as StepRun),
      state: 'waiting',
      waits: 'before',
      gate: { state: 'waitingAtLimit', parts: [], detail, since: context.now, at: context.now },
    };
    return {
      run: {
        ...changeVisit(next, (visit) => ({ ...visit, limit: detail })),
        steps: replaceStep(steps, move.to, waiting),
        currentStep: move.to,
        state: 'waiting',
      },
      effects: [
        ...effects,
        ...fromThread(from, 'needs_you'),
        { type: 'notify', runId: run.id, stepId: target.id, reason: 'waiting' },
      ],
    };
  }
  if (target.gateBefore && !passGateBefore) {
    // The thread of the step the run came from is where the user sees that the run needs them.
    return waitBefore(next, move.to, [...effects, ...fromThread(from, 'needs_you')]);
  }
  return begin(workflow, next, move, context, [...effects, ...fromThread(from, 'done')]);
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
  // What a rule on checks can go by: only a read that showed every check successful or one
  // failing decides it. A wait that ran out or a host that is not set up leaves it undecided.
  const fact: NonNullable<StepFacts['checks']> =
    checks.state === 'held'
      ? 'successful'
      : input.reading?.state === 'failure'
        ? 'failed'
        : 'undecided';
  const read: StepRun = current.facts
    ? { ...current, facts: { ...current.facts, checks: fact } }
    : current;
  if (gate.forRules) {
    if (fact === 'undecided') {
      // Spec 3: after the wait the run waits for the user and says so.
      return waitForUser(run, index, {
        ...current,
        gate: { ...gate, state: 'waitingForUser', parts, at: context.now },
      });
    }
    // The wait was for the rules only; what it found is in the facts and on the path.
    const { gate: _waited, ...decided } = read;
    return route(workflow, run, index, { ...decided, state: 'done' }, context, false);
  }
  if (checks.state === 'failed') {
    return waitForUser(run, index, {
      ...read,
      gate: { ...gate, state: 'waitingForUser', parts, at: context.now },
    });
  }
  return route(
    workflow,
    run,
    index,
    {
      ...read,
      state: 'done',
      gate: { ...gate, state: 'passedByItself', parts, at: context.now },
    },
    context,
    false,
  );
}

function failStep(
  workflow: Workflow,
  before: WorkflowRun,
  input: Extract<RunInput, { type: 'stepFailed' }>,
  context: EngineContext,
): Transition {
  const index = runningStepIndex(before, input.stepId);
  const run = endVisit(before, 'failed', context.now);
  const current = run.steps[index] as StepRun;
  const step = workflow.steps[index] as WorkflowStep;
  const failed: StepRun = { ...current, state: 'failed', endedAt: context.now, error: input.error };
  delete failed.gate;
  delete failed.facts;
  const steps = replaceStep(run.steps, index, failed);
  const marked = threadState(current.threadId, 'failed');
  // Spec 5: a failed step follows its rule for that; a step the user stopped never does.
  const rule = input.stopped ? undefined : failedRule(followable(workflow, step));
  if (!rule) {
    return {
      run: {
        ...decideVisit({ ...run, steps }, null, 'step failed'),
        state: 'failed',
        endedAt: context.now,
      },
      effects: [
        ...marked,
        { type: 'notify', runId: run.id, stepId: input.stepId, reason: 'failed' },
      ],
    };
  }
  const reason = `${ruleConditionText(rule.when)} → ${targetName(workflow, rule)}`;
  if (rule.goTo.type === 'end') {
    return finish(
      { ...run, steps },
      { to: rule.goTo, by: 'rule', when: rule.when },
      reason,
      context,
      marked,
    );
  }
  const to = stepIndexOf(workflow, rule.goTo.stepId);
  return moveTo(
    workflow,
    { ...run, steps },
    { from: index, to, by: 'rule', when: rule.when },
    reason,
    context,
    marked,
    false,
  );
}

// The run fails at the step it is on, whether that step waits at its gate or was about to get
// its prompt. Setup is over before any turn starts, so there is nothing to interrupt.
function failSetup(before: WorkflowRun, error: string, context: EngineContext): Transition {
  if (before.state !== 'running' && before.state !== 'waiting') {
    throw new RunRejected(`Run ${before.id} is already ${before.state}`);
  }
  const run = endVisit(before, 'failed', context.now);
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
    // Approving while the checks are still undecided (or after the wait for them ran out) is
    // the user's answer to them: no rule on checks holds, and they are not waited for again.
    const checksLeft =
      current.facts !== undefined &&
      current.facts.checks === undefined &&
      (current.gate?.state === 'waitingForChecks' || current.gate?.forRules === true);
    const done: StepRun = {
      ...current,
      state: 'done',
      // A gate with a condition records that the user passed it.
      ...(current.gate
        ? { gate: { ...current.gate, state: 'passedByUser' as const, at: context.now } }
        : {}),
      ...(current.facts && checksLeft
        ? { facts: { ...current.facts, checks: 'undecided' as const } }
        : {}),
    };
    return route(workflow, run, gate.stepIndex, done, context, true);
  }

  // Before a step: its own gate before, or the limit (Approve lets it run once more).
  const came = cameFrom(run, gate.stepIndex);
  return begin(
    workflow,
    run,
    { from: came?.index, to: gate.stepIndex, by: came?.next.by ?? 'list', when: came?.next.when },
    context,
    fromThread(came ? run.steps[came.index] : undefined, 'done'),
  );
}

// A step the run waited before does not start after all: one that ran in an earlier pass goes
// back to how that pass left it.
function backToRest(entry: StepRun): StepRun {
  if (!entry.threadId) return { ...entry, state: 'not_started' };
  const rested: StepRun = { ...entry, state: entry.error === undefined ? 'done' : 'failed' };
  if (rested.gate?.state === 'waitingAtLimit') delete rested.gate;
  return rested;
}

const NOTE_PLACEHOLDER = /\{\{note\}\}/;

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
  delete rerun.facts;
  delete rerun.error;
  const steps = run.steps.map((entry, at): StepRun => {
    if (at === index) return rerun;
    // A step that waited before its gate goes back to rest while the one before reruns.
    if (at === gate.stepIndex) return backToRest(entry);
    return entry;
  });
  const rendered = renderSendBack(context.sendBackTemplate, {
    note: text,
    skill: step.skillName,
    attempt: String(attempt),
  });
  // A template emptied in the settings, or one that does not name the note, still sends what the
  // reviewer wrote.
  const prompt =
    rendered === ''
      ? text
      : NOTE_PLACEHOLDER.test(context.sendBackTemplate)
        ? rendered
        : `${rendered}\n\n${text}`;
  const sent = decideVisit(
    run,
    { to: { type: 'step', stepId: step.id }, by: 'user' },
    'you sent it back',
  );
  return {
    run: {
      ...startVisit(sent, step.id, attempt, context.now),
      steps,
      currentStep: index,
      state: 'running',
    },
    effects: [{ type: 'sendBack', runId: run.id, stepId: step.id, threadId, attempt, prompt }],
  };
}

function stopRun(run: WorkflowRun, context: EngineContext): Transition {
  if (run.state !== 'running' && run.state !== 'waiting') {
    throw new RunRejected(`Run ${run.id} is already ${run.state}`);
  }
  const effects: RunEffect[] = [];
  const gate = pendingGate(run);
  // The threads are kept (behavior 13); a running turn is interrupted and its step marked failed.
  const steps = run.steps.map((step): StepRun => {
    if (step.state === 'running') {
      // A held step has no turn yet: the one running in its thread is the user's own.
      if (step.threadId && step.heldPrompt === undefined) {
        effects.push({ type: 'interrupt', threadId: step.threadId });
      }
      effects.push(...threadState(step.threadId, 'failed'));
      const { heldPrompt: _never, ...stopped } = step;
      return { ...stopped, state: 'failed', endedAt: context.now, error: 'Stopped' };
    }
    if (step.state === 'waiting') {
      if (gate?.position === 'after') {
        effects.push(...threadState(step.threadId, 'done'));
        // A gate nobody passed leaves no record of how it was passed.
        const { gate: _unanswered, ...ended } = step;
        return { ...ended, state: 'done' };
      }
      return backToRest(step);
    }
    return step;
  });
  if (gate?.position === 'before') {
    const came = cameFrom(run, gate.stepIndex);
    effects.push(...fromThread(came ? run.steps[came.index] : undefined, 'done'));
  }
  const stopped = changeVisit(run, (visit) => ({
    ...visit,
    ...(visit.ended === null ? { ended: 'stopped' as const, endedAt: context.now } : {}),
    reason: visit.reason ?? 'you stopped the run',
  }));
  return { run: { ...stopped, steps, state: 'stopped', endedAt: context.now }, effects };
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

// The step starts. The first time it gets its own thread and the step prompt. A step that has
// run before in this run runs again in the thread it has (spec 7, 8), as its next attempt: with
// `workflows.goBackTemplate` when a rule sent the run back to it, else with the step prompt.
function begin(
  workflow: Workflow,
  run: WorkflowRun,
  move: Move,
  context: EngineContext,
  effects: RunEffect[],
): Transition {
  const index = move.to;
  const step = workflow.steps[index] as WorkflowStep;
  const existing = run.steps[index] as StepRun;
  const made = () => stepPromptFor(workflow, run, index, context, move.from);
  if (!existing.threadId) {
    const first = made();
    if (first.missing !== undefined) {
      const starting: StepRun = {
        stepId: step.id,
        state: 'running',
        startedAt: context.now,
        artifactsFound: [],
      };
      return missingSkill(workflow, run, index, starting, 1, first.missing, context, effects);
    }
    const threadId = stepThreadId(run.id, step.id);
    const steps = replaceStep(run.steps, index, {
      stepId: step.id,
      state: 'running',
      threadId,
      startedAt: context.now,
      artifactsFound: [],
    });
    return {
      run: {
        ...startVisit(run, step.id, 1, context.now),
        steps,
        currentStep: index,
        state: 'running',
      },
      effects: [
        ...effects,
        {
          type: 'startStep',
          runId: run.id,
          stepId: step.id,
          threadId,
          prompt: first.prompt,
          ...sentWith(first),
        },
      ],
    };
  }
  const attempt = startsOf(existing) + 1;
  // The last result stays on the step until the new turn ends and replaces it.
  const rerun: StepRun = { ...existing, state: 'running', startedAt: context.now, attempt };
  delete rerun.endedAt;
  delete rerun.gate;
  delete rerun.facts;
  delete rerun.error;
  const from = move.from === undefined ? undefined : run.steps[move.from];
  const fromStep = move.from === undefined ? undefined : workflow.steps[move.from];
  const wentBack =
    move.by === 'rule' && move.from !== undefined && move.to <= move.from && from && fromStep
      ? renderGoBack(context.goBackTemplate, {
          fromStep: fromStep.skillName,
          reason: move.when ? ruleConditionText(move.when) : '',
          message: (from.state === 'failed' ? from.error : from.finalMessage) ?? '',
          skill: step.skillName,
          attempt: String(attempt),
        })
      : '';
  // A template emptied in the settings still tells the step what the run came with.
  const again = wentBack === '' ? made() : { prompt: wentBack };
  if (again.missing !== undefined) {
    return missingSkill(workflow, run, index, rerun, attempt, again.missing, context, effects);
  }
  return {
    run: {
      ...startVisit(run, step.id, attempt, context.now),
      steps: replaceStep(run.steps, index, rerun),
      currentStep: index,
      state: 'running',
    },
    effects: [
      ...effects,
      {
        type: 'sendBack',
        runId: run.id,
        stepId: step.id,
        threadId: existing.threadId,
        attempt,
        prompt: again.prompt,
        ...sentWith(again),
      },
    ],
  };
}

const sentWith = (made: StepPrompt) => ({
  ...(made.shown === undefined ? {} : { shown: made.shown }),
  ...(made.skills === undefined ? {} : { skills: made.skills }),
});

// A step whose skill is gone fails before it starts, with the skill's name (wow skills spec 15).
// The user is told; no rule is followed, as for a step the user stopped.
function missingSkill(
  workflow: Workflow,
  run: WorkflowRun,
  index: number,
  starting: StepRun,
  attempt: number,
  name: string,
  context: EngineContext,
  effects: RunEffect[],
): Transition {
  const step = workflow.steps[index] as WorkflowStep;
  const running: WorkflowRun = {
    ...startVisit(run, step.id, attempt, context.now),
    steps: replaceStep(run.steps, index, starting),
    currentStep: index,
    state: 'running',
  };
  const failed = failStep(
    workflow,
    running,
    {
      type: 'stepFailed',
      stepId: step.id,
      error: `The skill ${name} no longer exists, so the step cannot start. Pick another skill for it, or make the skill again.`,
      stopped: true,
    },
    context,
  );
  return { run: failed.run, effects: [...effects, ...failed.effects] };
}

function waitBefore(run: WorkflowRun, index: number, effects: RunEffect[]): Transition {
  const current = run.steps[index] as StepRun;
  const steps = replaceStep(run.steps, index, { ...current, state: 'waiting', waits: 'before' });
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
  next: PathNext,
  reason: string,
  context: EngineContext,
  effects: RunEffect[],
): Transition {
  const from = run.steps[run.currentStep];
  return {
    run: { ...decideVisit(run, next, reason), state: 'done', endedAt: context.now },
    effects: [
      ...effects,
      ...fromThread(from, 'done'),
      { type: 'notify', runId: run.id, stepId: null, reason: 'done' },
    ],
  };
}

// The path is kept for runs that have one. A run from before paths were kept goes on without.
function changeVisit(run: WorkflowRun, change: (visit: PathVisit) => PathVisit): WorkflowRun {
  const last = lastVisit(run.path);
  if (!run.path || !last) return run;
  return { ...run, path: [...run.path.slice(0, -1), change(last)] };
}

function startVisit(run: WorkflowRun, stepId: string, attempt: number, now: string): WorkflowRun {
  if (!run.path) return run;
  const visit: PathVisit = {
    stepId,
    attempt,
    startedAt: now,
    endedAt: null,
    ended: null,
    next: null,
    reason: null,
  };
  return { ...run, path: [...run.path, visit] };
}

const endVisit = (run: WorkflowRun, ended: NonNullable<PathVisit['ended']>, now: string) =>
  changeVisit(run, (visit) => (visit.ended === null ? { ...visit, ended, endedAt: now } : visit));

const decideVisit = (run: WorkflowRun, next: PathNext | null, reason: string): WorkflowRun =>
  changeVisit(run, (visit) => {
    const { limit: _waited, ...rest } = visit;
    return { ...rest, next, reason };
  });

// The prompt of a step that starts in a thread of its own. `fromIndex` is the step the run came
// from: the one before in the list unless a rule sent the run here.
export function renderStepPrompt(
  workflow: Workflow,
  run: WorkflowRun,
  index: number,
  context: EngineContext,
  fromIndex: number | undefined = index - 1,
): string {
  return stepPromptFor(workflow, run, index, context, fromIndex).prompt;
}

// A run from before wow skills keeps the prompts it had: the skill's invocation, the expected
// artifacts in the handover and the Intent-Unit line in the unit text. A newer run sends the
// skills the step names and the built-in skills the workflow depends on (wow skills spec 10 to
// 13), and leaves out each of wow's own sentences that a skill sent says instead.
export function stepPromptFor(
  workflow: Workflow,
  run: WorkflowRun,
  index: number,
  context: EngineContext,
  fromIndex: number | undefined = index - 1,
): StepPrompt {
  const step = workflow.steps[index] as WorkflowStep;
  const previousStep = fromIndex >= 0 ? workflow.steps[fromIndex] : undefined;
  const previousRun = fromIndex >= 0 ? run.steps[fromIndex] : undefined;
  const failed = previousRun?.state === 'failed';
  const earlierArtifacts = run.steps.slice(0, index).flatMap((entry) => entry.artifactsFound);
  const expectedArtifacts = bulletList(step.expectedArtifacts);
  const unitLine = run.unit ? intentUnitLine(run.unit.intentId, run.unit.unitKey) : '';
  const texts = (attached: ReadonlySet<string>) => {
    const handover = renderHandover(context.handoverTemplate, {
      previousStep: previousStep?.skillName ?? '',
      previousMessage: failed ? '' : (previousRun?.finalMessage ?? ''),
      previousError: failed ? (previousRun.error ?? '') : '',
      backlogBody: context.backlogBody ?? '',
      previousArtifacts: bulletList([...new Set(earlierArtifacts)]),
      expectedArtifacts: attached.has('wow-artifacts') ? '' : expectedArtifacts,
      ...eventValues(run.event),
    });
    // Every step of a unit's run is told which unit it works on (review loop spec 40).
    const unit = run.unit
      ? renderUnitPrompt(context.unitPromptTemplate, {
          intentId: run.unit.intentId,
          unitKey: run.unit.unitKey,
          unitTitle: run.unit.title,
          intentUnitLine: attached.has('wow-pull-request') ? '' : unitLine,
        })
      : '';
    return { handover, unit };
  };
  const { skillFor } = context;
  if (!run.wowSkills || !skillFor) {
    const { handover, unit } = texts(new Set());
    return { prompt: stepPrompt(context.invocationFor(step), step.extraPrompt, handover, unit) };
  }
  const values: BuiltInSkillValues = {
    approvedLine: context.verdictApprovedLine,
    changesRequestedLine: context.verdictChangesRequestedLine,
    blockedLine: context.verdictBlockedLine,
    expectedArtifacts,
    intentId: run.unit?.intentId ?? '',
    unitKey: run.unit?.unitKey ?? '',
    unitTitle: run.unit?.title ?? '',
    intentUnitLine: unitLine,
  };
  const named: SkillRef[] = [
    { name: step.skillName, ...(step.skillSource ? { source: step.skillSource } : {}) },
    ...(step.alsoFollow ?? []),
  ];
  const chosen: { skill: ResolvedSkill; reason?: string }[] = [];
  for (const ref of named) {
    const skill = skillFor(step, ref, values);
    if (!skill) return { prompt: '', missing: ref.name };
    chosen.push({ skill });
  }
  const builtIn = (name: string) =>
    chosen.some(({ skill }) => skill.source === 'wow' && skill.name === name);
  if (context.attachBuiltInSkills) {
    for (const auto of automaticSkills(step, run.unit)) {
      if (step.leaveOut?.includes(auto.name) || builtIn(auto.name)) continue;
      // A built-in skill switched off in the settings is attached nowhere (spec 3).
      const skill = skillFor(step, { name: auto.name, source: 'wow' }, values);
      if (skill) chosen.push({ skill, reason: auto.reason });
    }
  }
  const attached = new Set(
    chosen.filter(({ skill }) => skill.source === 'wow').map(({ skill }) => skill.name),
  );
  const { handover, unit } = texts(attached);
  const parts: PromptSkillPart[] = chosen.map(({ skill }) =>
    skill.kind === 'text'
      ? { kind: 'text', name: skill.name, text: skill.text }
      : { kind: 'invoke', invocation: skill.invocation },
  );
  const extra = step.extraPrompt ?? '';
  const join = (head: string) => [head, unit, handover].filter((part) => part !== '').join('\n\n');
  const skills: SentSkill[] = chosen.map(({ skill, reason }) => ({
    name: skill.name,
    source: skill.source,
    ...(skill.kind === 'text' ? { text: skill.text } : { invocation: skill.invocation }),
    ...(reason === undefined ? {} : { reason }),
  }));
  const shown = join(promptShown(parts, extra));
  return {
    prompt: join(promptWithSkills(parts, extra)),
    shown: shown === '' ? skills.map((skill) => skill.name).join(', ') : shown,
    skills,
  };
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
