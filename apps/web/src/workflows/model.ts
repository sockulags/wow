import {
  alwaysStops,
  changeRequestName,
  GatePart,
  gatePartLabels,
  lacksRequiredModel,
  missingModelSentence,
  providerKindLabels,
  providerChatOptions,
  rulesForTemplate,
  rulesFromTemplate,
  runEventHost,
  triggerEventLabel,
  type GatePartResult,
  type ProviderInstance,
  type ProviderModel,
  type RunEvent,
  type Skill,
  type StepRun,
  type StepRunState,
  type Thread,
  type Workflow,
  type WorkflowRun,
  type WorkflowRunState,
  type WorkflowStep,
  type WorkflowTemplate,
} from '@wow/contracts';
import { effortOptions } from '@/chat/model';

// Pure helpers for the workflow builder and run view. The builder edits a draft; everything the
// run view shows derives from rows the server pushed.

// A step while it is edited: the expected artifact globs stay as typed text (one per line) so a
// half-typed line survives until the draft is saved.
export type DraftStep = Omit<WorkflowStep, 'expectedArtifacts'> & {
  readonly artifactsText: string;
};

export interface WorkflowDraft {
  readonly name: string;
  readonly templateKind: string | null;
  readonly steps: readonly DraftStep[];
  // "Own working copy"; absent means off.
  readonly ownWorkingCopy?: boolean;
  // "For units": a plan run may run the workflow once per unit; absent means off.
  readonly forUnits?: boolean;
}

export const newStepId = (): string => `step-${globalThis.crypto.randomUUID().slice(0, 8)}`;

export const emptyDraft: WorkflowDraft = { name: '', templateKind: null, steps: [] };

export function newStep(providerInstanceId: string, skillName = ''): DraftStep {
  return {
    id: newStepId(),
    skillName,
    providerInstanceId,
    gateBefore: false,
    gateAfter: false,
    artifactsText: '',
  };
}

export const parseGlobs = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

export function draftOf(workflow: Workflow): WorkflowDraft {
  return {
    name: workflow.name,
    templateKind: workflow.templateKind,
    ownWorkingCopy: workflow.ownWorkingCopy ?? false,
    forUnits: workflow.forUnits ?? false,
    steps: workflow.steps.map(({ expectedArtifacts, ...step }) => ({
      ...step,
      artifactsText: expectedArtifacts.join('\n'),
    })),
  };
}

// The steps as they are saved. A condition is kept only where the builder offers one: on a
// gate after the step, and not for a skill that always stops (`workflows.alwaysStopSkills`).
export function stepsOf(draft: WorkflowDraft, alwaysStop: readonly string[] = []): WorkflowStep[] {
  return draft.steps.map(({ artifactsText, extraPrompt, gateAfterCondition, rules, ...step }) => {
    const prompt = extraPrompt?.trim() ?? '';
    const condition = conditionOffered(step, alwaysStop) ? (gateAfterCondition ?? []) : [];
    return {
      ...step,
      ...(condition.length > 0 ? { gateAfterCondition: condition } : {}),
      // A step without rules is saved as it was before rules existed.
      ...(rules && rules.length > 0 ? { rules } : {}),
      ...(prompt === '' ? {} : { extraPrompt: prompt }),
      expectedArtifacts: parseGlobs(artifactsText),
    };
  });
}

// Whether the gate after the step may pass by itself (review loop spec 57): it has a gate
// after it and its skill is not one that plans or specifies.
export const conditionOffered = (
  step: Pick<WorkflowStep, 'skillName' | 'gateAfter'>,
  alwaysStop: readonly string[],
): boolean => step.gateAfter && !alwaysStops(step.skillName, alwaysStop);

export const gateParts: readonly GatePart[] = GatePart.options;

// What each checkbox of "Pass by itself when" says.
export const gatePartChoices: Readonly<Record<GatePart, string>> = {
  verdict: 'The final message ends with the approved verdict',
  checks: "Every check of the run's pull request is successful",
  artifacts: 'Every expected artifact was found',
};

// Turns one part of the condition on the gate after a step on or off, keeping the parts in
// their fixed order.
export function toggleGatePart<S extends Pick<WorkflowStep, 'gateAfterCondition'>>(
  step: S,
  part: GatePart,
): S {
  const chosen = new Set(step.gateAfterCondition ?? []);
  if (chosen.has(part)) chosen.delete(part);
  else chosen.add(part);
  const { gateAfterCondition: _before, ...rest } = step;
  const condition = gateParts.filter((candidate) => chosen.has(candidate));
  return (condition.length > 0 ? { ...rest, gateAfterCondition: condition } : rest) as S;
}

// Behavior 25: a template is a list of skills with gates. It carries no provider instance, so
// every step starts on the one the user picked (or the first instance).
export function draftFromTemplate(
  template: WorkflowTemplate,
  providerInstanceId: string,
  name: string,
): WorkflowDraft {
  const steps = template.steps.map((step) => ({
    ...newStep(providerInstanceId, step.skillName),
    gateBefore: step.gateBefore,
    gateAfter: step.gateAfter,
    artifactsText: step.expectedArtifacts.join('\n'),
  }));
  const ids = steps.map((step) => step.id);
  return {
    name: name.trim() === '' ? template.name : name,
    templateKind: template.kind,
    // A template names the step a rule goes to by its skill (workflow branches spec 20).
    steps: steps.map((step, index) => {
      const rules = rulesFromTemplate(template.steps, ids, index);
      return rules.length > 0 ? { ...step, rules } : step;
    }),
  };
}

// Whether the run waits for the user at a position of the chain: 0 is before the first step,
// n after the last, p between step p and step p + 1 (one-based). A gate after one step and a
// gate before the next wait at the same place.
export function waitsAt(draft: Pick<WorkflowDraft, 'steps'>, position: number): boolean {
  const before = draft.steps[position - 1];
  const after = draft.steps[position];
  return (before?.gateAfter ?? false) || (after?.gateBefore ?? false);
}

// Turns the gate at a position on or off. On, it is stored as a gate after the step before it
// (before the first step, as that step's gate before); off clears both.
export function setGate<D extends Pick<WorkflowDraft, 'steps'>>(draft: D, position: number): D {
  const on = !waitsAt(draft, position);
  return {
    ...draft,
    steps: draft.steps.map((step, index) => {
      if (index === position - 1) {
        // A gate taken away takes its condition with it.
        const { gateAfterCondition: _condition, ...rest } = step;
        return on ? { ...step, gateAfter: true } : { ...rest, gateAfter: false };
      }
      if (index === position) return { ...step, gateBefore: on && position === 0 };
      return step;
    }),
  };
}

// "Save as template" (audit E-05): the draft's skills, gates, artifacts and rules under a name. A
// template with that name (or the kind the draft came from, when the name is the same) is
// replaced; otherwise a new kind is made from the name. Provider settings stay with the workflow.
export function saveAsTemplate(
  templates: readonly WorkflowTemplate[],
  draft: Pick<WorkflowDraft, 'steps'>,
  name: string,
): { readonly templates: WorkflowTemplate[]; readonly kind: string } | string {
  const title = name.trim();
  if (title === '') return 'Give the template a name';
  const named = draft.steps
    .filter((step) => step.skillName.trim() !== '')
    .map((step) => ({ ...step, skillName: step.skillName.trim() }));
  const steps = named.map((step, index) => {
    const rules = rulesForTemplate(named, index);
    return {
      skillName: step.skillName,
      gateBefore: step.gateBefore,
      gateAfter: step.gateAfter,
      expectedArtifacts: parseGlobs(step.artifactsText),
      ...(rules.length > 0 ? { rules } : {}),
    };
  });
  if (steps.length === 0) return 'Add a step with a skill first';
  const existing = templates.find(
    (template) => template.name.trim().toLowerCase() === title.toLowerCase(),
  );
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'template';
  let kind = existing?.kind ?? base;
  if (!existing) {
    for (let n = 2; templates.some((template) => template.kind === kind); n += 1) {
      kind = `${base}-${n}`;
    }
  }
  const saved: WorkflowTemplate = { kind, name: title, steps };
  return {
    kind,
    templates: existing
      ? templates.map((template) => (template.kind === kind ? saved : template))
      : [...templates, saved],
  };
}

export function moveStep<T>(steps: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= steps.length || to < 0 || to >= steps.length) {
    return [...steps];
  }
  const next = [...steps];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}

// What a step on this instance starts with when nothing is picked: the instance defaults, else
// the first model the provider lists and the first effort and permission mode offered for it.
export function stepDefaults(
  instance: ProviderInstance,
  models: readonly ProviderModel[],
): { model: string; effort: string; permissionMode: string } {
  // A provider that needs a model gets the instance's default or none: the step then shows the
  // server's refusal until a model is chosen, instead of taking whatever is listed first
  // (questions and models spec 17, 18).
  const model =
    instance.defaultModel ??
    (providerChatOptions[instance.kind].requiresModel ? '' : (models[0]?.id ?? ''));
  const effort =
    instance.defaultEffort ?? effortOptions(instance.kind, models, model, '')[0] ?? 'default';
  const permissionMode =
    instance.defaultPermissionMode ??
    providerChatOptions[instance.kind].permissionModes[0]?.id ??
    'default';
  return { model, effort, permissionMode };
}

export interface DraftProblem {
  // The step the problem belongs to; absent for the workflow itself.
  readonly stepId?: string;
  readonly message: string;
  // Warnings do not block saving.
  readonly warning?: boolean;
  // Shown before the first Save too: it says what the server would refuse.
  readonly always?: boolean;
}

// Behavior 24 validation. A skill missing from the scanned list is only a warning: the server
// invokes unknown skills by their plain name, so a workflow still runs where the skill lives
// in a folder wow does not scan.
export function validateDraft(
  draft: WorkflowDraft,
  instances: readonly ProviderInstance[],
  skills: readonly Skill[],
  // The workflow as stored, whose steps saved without a required model are marked (spec 19).
  stored?: Workflow,
): DraftProblem[] {
  const problems: DraftProblem[] = [];
  if (draft.name.trim() === '') problems.push({ message: 'Give the workflow a name.' });
  if (draft.steps.length === 0) problems.push({ message: 'Add at least one step.' });
  const ids = new Set<string>();
  draft.steps.forEach((step, index) => {
    const stepId = step.id;
    const label = `Step ${index + 1}`;
    if (ids.has(stepId)) problems.push({ stepId, message: `${label} repeats a step id.` });
    ids.add(stepId);
    if (step.skillName.trim() === '') {
      problems.push({ stepId, message: `${label} needs a skill.` });
    } else if (!skillKnown(step.skillName, skills)) {
      problems.push({
        stepId,
        warning: true,
        message: `${label}: ${step.skillName} is not among the scanned skills; it is invoked by name.`,
      });
    }
    if (!instances.some((instance) => instance.id === step.providerInstanceId)) {
      problems.push({ stepId, message: `${label} needs a provider instance.` });
    }
    const instance = instances.find((candidate) => candidate.id === step.providerInstanceId);
    const was = stored?.steps.find((candidate) => candidate.id === stepId);
    if (instance && was && lacksRequiredModel(was, instance.kind) && step.model) {
      problems.push({
        stepId,
        warning: true,
        message: `${label} was saved without a model, which ${providerKindLabels[instance.kind]} needs; Save stores ${step.model}.`,
      });
    }
    if (!step.model && instance && lacksRequiredModel(step, instance.kind)) {
      problems.push({
        stepId,
        always: true,
        message: missingModelSentence(step.skillName.trim() || label, instance),
      });
    } else if (!step.model) problems.push({ stepId, message: `${label} needs a model.` });
    if (!step.effort) problems.push({ stepId, message: `${label} needs an effort.` });
    if (!step.permissionMode) {
      problems.push({ stepId, message: `${label} needs a permission mode.` });
    }
  });
  return problems;
}

export const blocking = (problems: readonly DraftProblem[]): DraftProblem[] =>
  problems.filter((problem) => !problem.warning);

// "plugin:name" names a Claude plugin's skill; the projection stores the bare name and the
// plugin form in its Claude invocation.
export function skillKnown(skillName: string, skills: readonly Skill[]): boolean {
  return skills.some(
    (skill) => skill.name === skillName || skill.invocations.claude === `/${skillName}`,
  );
}

export const stepStateLabels: Readonly<Record<StepRunState, string>> = {
  not_started: 'Not started',
  running: 'Running',
  waiting: 'Waiting',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
};

export const runStateLabels: Readonly<Record<WorkflowRunState, string>> = {
  running: 'Running',
  waiting: 'Waiting for you',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

export const stepStateDotClass: Readonly<Record<StepRunState, string>> = {
  not_started: 'bg-muted-foreground/30',
  running: 'bg-state-working',
  waiting: 'bg-state-needs-you',
  done: 'bg-state-done',
  failed: 'bg-state-failed',
  skipped: 'bg-muted-foreground/30',
};

export const runStateDotClass: Readonly<Record<WorkflowRunState, string>> = {
  running: 'bg-state-working',
  waiting: 'bg-state-needs-you',
  done: 'bg-state-done',
  failed: 'bg-state-failed',
  stopped: 'bg-muted-foreground/50',
};

export interface Gate {
  // The step the run stopped at: after it finished, or before it starts.
  readonly stepIndex: number;
  readonly position: 'before' | 'after';
  // The limit sentence, when the run waits because the step has started as often as the limit
  // allows (workflow branches spec 9).
  readonly limit?: string;
}

// Where the run waits, as the server stored it on the step (`waits`). Runs stored before it
// did are read as the engine's pendingGate reads them: a run that keeps a path waits after its
// current step only when that step's visit is the last one and nothing was decided after it; a
// run from before paths goes by whether the current step has ended and is not at the limit.
export function gateOf(run: WorkflowRun): Gate | undefined {
  if (run.state !== 'waiting') return undefined;
  const step = run.steps[run.currentStep];
  if (!step) return undefined;
  const last = run.path?.at(-1);
  const after = step.waits
    ? step.waits === 'after'
    : run.path
      ? last !== undefined &&
        last.stepId === step.stepId &&
        last.ended !== null &&
        last.next === null
      : Boolean(step.endedAt) && step.gate?.state !== 'waitingAtLimit';
  const limit = step.gate?.state === 'waitingAtLimit' ? (step.gate.detail ?? '') : undefined;
  return {
    stepIndex: run.currentStep,
    position: after ? 'after' : 'before',
    ...(limit === undefined || after ? {} : { limit }),
  };
}

// The step the run came from when it waits before a step: the one whose rule (or the user)
// sent it there, else the step before in the list.
function cameFrom(run: WorkflowRun, stepIndex: number): number | undefined {
  const target = run.steps[stepIndex];
  const last = run.path?.at(-1);
  if (last?.next && last.next.to.type === 'step' && last.next.to.stepId === target?.stepId) {
    const index = run.steps.findIndex((entry) => entry.stepId === last.stepId);
    if (index >= 0) return index;
  }
  return stepIndex === 0 ? undefined : stepIndex - 1;
}

// The position of the step a gate asks the user to review: the step that just ended for a gate
// after it, the one the run came from for a gate before a step.
export function reviewedStepIndex(run: WorkflowRun): number | undefined {
  const gate = gateOf(run);
  if (!gate) return undefined;
  return gate.position === 'after' ? gate.stepIndex : cameFrom(run, gate.stepIndex);
}

export function gateMessage(gate: Gate, workflow: Workflow | undefined): string {
  const skill = (index: number) => workflow?.steps[index]?.skillName ?? `step ${index + 1}`;
  if (gate.limit !== undefined) {
    const sentence =
      gate.limit === '' ? `${skill(gate.stepIndex)} has reached the limit` : gate.limit;
    return `${sentence}. Run once more starts it again; Stop ends the run.`;
  }
  if (gate.position === 'before') {
    return `Waiting for you before ${skill(gate.stepIndex)} starts.`;
  }
  // Where the run goes is only known once the gate has passed (workflow branches spec 1).
  if ((workflow?.steps[gate.stepIndex]?.rules?.length ?? 0) > 0) {
    return `${skill(gate.stepIndex)} finished. Approve lets its rules choose the next step.`;
  }
  const next = gate.stepIndex + 1;
  const total = workflow?.steps.length ?? next;
  return next < total
    ? `${skill(gate.stepIndex)} finished. Approve starts ${skill(next)}.`
    : `${skill(gate.stepIndex)} finished. Approve ends the run.`;
}

// A gate with a condition, as the gate bar says it (review loop spec 55, 56): whether the run
// waits for the pull request's checks or for the user, and what each part found.
export interface GateStanding {
  readonly waitsFor: 'checks' | 'user';
  readonly parts: readonly GatePartResult[];
  // The parts that did not hold, by their labels.
  readonly failed: readonly string[];
}

export function gateStanding(run: WorkflowRun): GateStanding | undefined {
  const gate = gateOf(run);
  const record = gate?.position === 'after' ? run.steps[gate.stepIndex]?.gate : undefined;
  if (record?.state !== 'waitingForChecks' && record?.state !== 'waitingForUser') return undefined;
  return {
    waitsFor: record.state === 'waitingForChecks' ? 'checks' : 'user',
    parts: record.parts,
    failed: record.parts
      .filter((part) => part.state === 'failed')
      .map((part) => gatePartLabels[part.part]),
  };
}

// "Waiting for checks" while a gate waits for the host; "Waiting for an answer" while the running
// step's thread waits for the user (a question or an approval; the run itself stays running);
// otherwise the run state's own words.
export function runStateLabel(run: WorkflowRun, threads: readonly Thread[] = []): string {
  if (gateStanding(run)?.waitsFor === 'checks') return 'Waiting for checks';
  const threadId = run.state === 'running' ? run.steps[run.currentStep]?.threadId : undefined;
  if (threadId !== undefined && threads.some((t) => t.id === threadId && t.state === 'needs_you'))
    return 'Waiting for an answer';
  return runStateLabels[run.state];
}

// "Passed by itself: Approved verdict, Checks successful" for a step whose gate did.
export function passedByItself(stepRun: StepRun): string | undefined {
  if (stepRun.gate?.state !== 'passedByItself') return undefined;
  return `Passed by itself: ${stepRun.gate.parts.map((part) => gatePartLabels[part.part]).join(', ')}`;
}

export const isLive = (run: WorkflowRun): boolean =>
  run.state === 'running' || run.state === 'waiting';

// Live runs first, then the most recent.
export const sortRuns = (runs: readonly WorkflowRun[]): WorkflowRun[] =>
  runs.toSorted(
    (a, b) => Number(isLive(b)) - Number(isLive(a)) || b.startedAt.localeCompare(a.startedAt),
  );

// Merges an edit into a step. Moving a step to another provider instance drops its model,
// effort and permission mode, because those belong to the instance it left.
export function applyStepChanges(step: DraftStep, changes: Partial<DraftStep>): DraftStep {
  const next: DraftStep = { ...step, ...changes };
  if (
    changes.providerInstanceId !== undefined &&
    changes.providerInstanceId !== step.providerInstanceId
  ) {
    delete next.model;
    delete next.effort;
    delete next.permissionMode;
  }
  return next;
}

// Structural equality for JSON values, ignoring object key order.
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => sameJson(value, b[index]))
    );
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const left = Object.entries(a).filter(([, value]) => value !== undefined);
  const right = new Map(Object.entries(b).filter(([, value]) => value !== undefined));
  return (
    left.length === right.size &&
    left.every(([key, value]) => right.has(key) && sameJson(value, right.get(key)))
  );
}

// The step whose output a gate asks the user to review.
export function reviewedStep(run: WorkflowRun): StepRun | undefined {
  const index = reviewedStepIndex(run);
  return index === undefined ? undefined : run.steps[index];
}

// "Attempt 2" for a step that ran again, sent back by the user or by a rule; nothing for a
// first run.
export const attemptLabel = (stepRun: StepRun | undefined): string | undefined =>
  stepRun?.attempt === undefined ? undefined : `Attempt ${stepRun.attempt}`;

// The run a thread can answer: one waiting at a gate right after the thread's step (spec 9:
// Approve, Send back and Stop in the thread as well as the run view).
export function gateRunForThread(
  thread: { readonly id: string; readonly runId: string | null },
  runs: readonly WorkflowRun[],
): WorkflowRun | undefined {
  if (thread.runId === null) return undefined;
  const run = runs.find((candidate) => candidate.id === thread.runId);
  return run && reviewedStep(run)?.threadId === thread.id ? run : undefined;
}

// What a step row says. A step that finished and now waits at its gate is done; the gate marker
// after it says that the run waits for you. A step the run waits before, to run it again, is
// waiting although its last attempt has ended. `waitsBefore` is for runs stored before the
// server said which side the run waits on.
export function stepDisplayState(stepRun: StepRun, waitsBefore = false): StepRunState {
  if (stepRun.state !== 'waiting') return stepRun.state;
  const after = stepRun.waits ? stepRun.waits === 'after' : stepRun.endedAt && !waitsBefore;
  return after ? 'done' : 'waiting';
}

// How long a step took; undefined while it has not ended.
export function stepDurationMs(stepRun: StepRun): number | undefined {
  if (!stepRun.startedAt || !stepRun.endedAt) return undefined;
  return new Date(stepRun.endedAt).getTime() - new Date(stepRun.startedAt).getTime();
}

export function artifactPath(cwd: string, relative: string): string {
  const windows = /^[A-Za-z]:\\/.test(cwd) || cwd.includes('\\');
  const separator = windows ? '\\' : '/';
  const base = cwd.replace(/[\\/]+$/, '');
  return `${base}${separator}${relative.split('/').join(separator)}`;
}

// What started an event's run, in the host's words: "pull request merged on pull request #21",
// "merge request merged on merge request !12".
export function eventSummary(event: RunEvent): string {
  const host = runEventHost(event);
  const name = changeRequestName({ host, number: event.number });
  return `${triggerEventLabel(event.event, host).toLowerCase()} on ${name.charAt(0).toLowerCase()}${name.slice(1)}`;
}
