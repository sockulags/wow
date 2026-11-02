import {
  providerChatOptions,
  type ProviderInstance,
  type ProviderModel,
  type Skill,
  type StepRunState,
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
    steps: workflow.steps.map(({ expectedArtifacts, ...step }) => ({
      ...step,
      artifactsText: expectedArtifacts.join('\n'),
    })),
  };
}

export function stepsOf(draft: WorkflowDraft): WorkflowStep[] {
  return draft.steps.map(({ artifactsText, extraPrompt, ...step }) => {
    const prompt = extraPrompt?.trim() ?? '';
    return {
      ...step,
      ...(prompt === '' ? {} : { extraPrompt: prompt }),
      expectedArtifacts: parseGlobs(artifactsText),
    };
  });
}

// Behavior 25: a template is a list of skills with gates. It carries no provider instance, so
// every step starts on the one the user picked (or the first instance).
export function draftFromTemplate(
  template: WorkflowTemplate,
  providerInstanceId: string,
  name: string,
): WorkflowDraft {
  return {
    name: name.trim() === '' ? template.name : name,
    templateKind: template.kind,
    steps: template.steps.map((step) => ({
      ...newStep(providerInstanceId, step.skillName),
      gateBefore: step.gateBefore,
      gateAfter: step.gateAfter,
      artifactsText: step.expectedArtifacts.join('\n'),
    })),
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
  const model = instance.defaultModel ?? models[0]?.id ?? '';
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
}

// Behavior 24 validation. A skill missing from the scanned list is only a warning: the server
// invokes unknown skills by their plain name, so a workflow still runs where the skill lives
// in a folder wow does not scan.
export function validateDraft(
  draft: WorkflowDraft,
  instances: readonly ProviderInstance[],
  skills: readonly Skill[],
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
    if (!step.model) problems.push({ stepId, message: `${label} needs a model.` });
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
}

// The same reading as the engine's pendingGate: the current step has ended when the gate is
// after it, and has not started when the gate is before it.
export function gateOf(run: WorkflowRun): Gate | undefined {
  if (run.state !== 'waiting') return undefined;
  const step = run.steps[run.currentStep];
  if (!step) return undefined;
  return { stepIndex: run.currentStep, position: step.endedAt ? 'after' : 'before' };
}

export function gateMessage(gate: Gate, workflow: Workflow | undefined): string {
  const skill = (index: number) => workflow?.steps[index]?.skillName ?? `step ${index + 1}`;
  if (gate.position === 'before') {
    return `Waiting for you before ${skill(gate.stepIndex)} starts.`;
  }
  const next = gate.stepIndex + 1;
  const total = workflow?.steps.length ?? next;
  return next < total
    ? `${skill(gate.stepIndex)} finished. Continue starts ${skill(next)}.`
    : `${skill(gate.stepIndex)} finished. Continue ends the run.`;
}

export const isLive = (run: WorkflowRun): boolean =>
  run.state === 'running' || run.state === 'waiting';

// Live runs first, then the most recent.
export const sortRuns = (runs: readonly WorkflowRun[]): WorkflowRun[] =>
  runs.toSorted(
    (a, b) => Number(isLive(b)) - Number(isLive(a)) || b.startedAt.localeCompare(a.startedAt),
  );

// A file:// link to an artifact found in the project folder. Paths come relative with forward
// slashes; the folder may be a Windows path.
export function artifactUrl(cwd: string, relative: string): string {
  const base = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
  const absolute = `${base}/${relative.replace(/^\/+/, '')}`;
  const withRoot = absolute.startsWith('/') ? absolute : `/${absolute}`;
  return `file://${withRoot
    .split('/')
    .map(encodeURIComponent)
    .join('/')
    .replace(/^\/([A-Za-z])%3A/, '/$1:')}`;
}

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

export function artifactPath(cwd: string, relative: string): string {
  const windows = /^[A-Za-z]:\\/.test(cwd) || cwd.includes('\\');
  const separator = windows ? '\\' : '/';
  const base = cwd.replace(/[\\/]+$/, '');
  return `${base}${separator}${relative.split('/').join(separator)}`;
}
