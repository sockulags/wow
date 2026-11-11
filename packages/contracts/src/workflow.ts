import { z } from 'zod';
import { ThreadState } from './provider.js';

// One part of a gate's condition (review loop spec 54): the step's final message ends with the
// approved verdict line, the run's pull request has every check successful, or a file was found
// for every expected artifact.
export const GatePart = z.enum(['verdict', 'checks', 'artifacts']);
export type GatePart = z.infer<typeof GatePart>;

export const gatePartLabels: Readonly<Record<GatePart, string>> = {
  verdict: 'Approved verdict',
  checks: 'Checks successful',
  artifacts: 'Expected artifacts found',
};

// The parts a gate needs to pass by itself, each named once.
export const GateCondition = z
  .array(GatePart)
  .min(1)
  .refine((parts) => new Set(parts).size === parts.length, {
    message: 'Name each part of the condition once',
  });
export type GateCondition = z.infer<typeof GateCondition>;

// Skills that plan or specify: the gate after them always waits for the user (review loop
// spec 57). `workflows.alwaysStopSkills` adds to these and cannot take one away.
export const alwaysStopSkillDefaults: readonly string[] = [
  'capture-intent',
  'plan-work',
  'design-work',
  'shape-work',
];

// A step names a plugin's skill as `plugin:name`; the list names skills either way.
const bareSkillName = (name: string): string => name.slice(name.lastIndexOf(':') + 1).trim();

export function alwaysStops(skillName: string, listed: readonly string[]): boolean {
  const bare = bareSkillName(skillName);
  return [...alwaysStopSkillDefaults, ...listed].some((name) => bareSkillName(name) === bare);
}

// What a rule can ask about a step that ended (workflow branches spec 2 to 5). wow reads each of
// them itself; no model decides.
export const Verdict = z.enum(['approved', 'changesRequested', 'blocked', 'none']);
export type Verdict = z.infer<typeof Verdict>;

export const ChecksFact = z.enum(['successful', 'failed']);
export type ChecksFact = z.infer<typeof ChecksFact>;

export const ArtifactsFact = z.enum(['found', 'missing']);
export type ArtifactsFact = z.infer<typeof ArtifactsFact>;

export const RuleCondition = z.discriminatedUnion('fact', [
  z.object({ fact: z.literal('verdict'), is: Verdict }),
  z.object({ fact: z.literal('checks'), is: ChecksFact }),
  z.object({ fact: z.literal('artifacts'), is: ArtifactsFact }),
  // The step's turn failed. A step the user stopped never counts.
  z.object({ fact: z.literal('stepFailed') }),
]);
export type RuleCondition = z.infer<typeof RuleCondition>;

export const RuleTarget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('step'), stepId: z.string().min(1) }),
  // The run finishes as done.
  z.object({ type: z.literal('end') }),
]);
export type RuleTarget = z.infer<typeof RuleTarget>;

// "When <fact> is <value>, go to <step or End>". After a step's gate has passed, the first of
// its rules whose condition holds decides the next step; when none holds the run goes to the
// next step in the list.
export const StepRule = z.object({ when: RuleCondition, goTo: RuleTarget });
export type StepRule = z.infer<typeof StepRule>;

const verdictWords: Readonly<Record<Verdict, string>> = {
  approved: 'verdict approved',
  changesRequested: 'verdict changes requested',
  blocked: 'verdict blocked',
  none: 'no verdict',
};

// A condition in a few words, as the path of a run and a go-back message name it.
export function ruleConditionText(when: RuleCondition): string {
  switch (when.fact) {
    case 'verdict':
      return verdictWords[when.is];
    case 'checks':
      return `checks ${when.is}`;
    case 'artifacts':
      return `artifacts ${when.is}`;
    case 'stepFailed':
      return 'step failed';
  }
}

export const WorkflowStep = z.object({
  id: z.string().min(1),
  skillName: z.string().min(1),
  providerInstanceId: z.string().min(1),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  permissionMode: z.string().min(1).optional(),
  gateBefore: z.boolean(),
  gateAfter: z.boolean(),
  // When set, the gate after the step passes by itself once every part holds. Absent: the gate
  // waits for the user as it always did.
  gateAfterCondition: GateCondition.optional(),
  extraPrompt: z.string().optional(),
  expectedArtifacts: z.array(z.string().min(1)),
  // Where the run goes after this step, in the order they are tried. Absent or empty: the next
  // step in the list, as always.
  rules: z.array(StepRule).optional(),
});
export type WorkflowStep = z.infer<typeof WorkflowStep>;

export interface RuleProblem {
  readonly stepId: string;
  // The rule's place in the step's list, from 0.
  readonly rule: number;
  readonly reason: string;
}

// What is wrong with the rules of a list of steps (workflow branches spec 16): a rule that goes
// to a step the list does not have, a rule on artifacts for a step that expects none, and a
// second rule with a condition the step already has. The server refuses such a workflow and the
// builder marks the rule.
export function ruleProblems(steps: readonly WorkflowStep[]): RuleProblem[] {
  const ids = new Set(steps.map((step) => step.id));
  const problems: RuleProblem[] = [];
  for (const step of steps) {
    const seen = new Set<string>();
    (step.rules ?? []).forEach(({ when, goTo }, rule) => {
      const text = ruleConditionText(when);
      const problem = (reason: string) => problems.push({ stepId: step.id, rule, reason });
      if (goTo.type === 'step' && !ids.has(goTo.stepId)) {
        problem(`The rule "${text}" goes to a step that no longer exists`);
      }
      if (when.fact === 'artifacts' && step.expectedArtifacts.length === 0) {
        problem(`The rule "${text}" needs expected artifacts, and this step names none`);
      }
      if (seen.has(text)) problem(`The step already has a rule for "${text}"`);
      seen.add(text);
    });
  }
  return problems;
}

// Spec behavior 26: not started, running, waiting, done or failed. `skipped`: a rule went past
// the step in this pass (workflow branches spec 11); a later pass can still run it.
export const StepRunState = z.enum([
  'not_started',
  'running',
  'waiting',
  'done',
  'failed',
  'skipped',
]);
export type StepRunState = z.infer<typeof StepRunState>;

// What one file looked like at a moment of a run: the SHA-256 of its content in the working
// folder, or null when the file is not there. Only files that differ from the run's base are
// listed, so a path that is missing from a list was the same as in the base.
export const FileHash = z.object({ path: z.string().min(1), hash: z.string().min(1).nullable() });
export type FileHash = z.infer<typeof FileHash>;

// What became of one part when the gate was looked at. `pending` is the checks part while the
// pull request's checks have not finished, or a part that was not looked at because another one
// had already failed.
export const GatePartResult = z.object({
  part: GatePart,
  state: z.enum(['held', 'failed', 'pending']),
  // One sentence for the user: what was found.
  detail: z.string(),
});
export type GatePartResult = z.infer<typeof GatePartResult>;

// A gate with a condition, as it stands (review loop spec 54 to 58). `waitingForChecks`: the
// other parts hold and the pull request's checks are not finished. `waitingForUser`: a part did
// not hold, or the checks took too long. `passedByItself`: every part held and the run went on.
// `passedByUser`: the user approved it. `waitingAtLimit` is not about the step's result: the step
// has started as often as the limit allows and waits for the user before it starts again
// (workflow branches spec 9).
export const StepGate = z.object({
  state: z.enum([
    'waitingForChecks',
    'waitingForUser',
    'passedByItself',
    'passedByUser',
    'waitingAtLimit',
  ]),
  parts: z.array(GatePartResult),
  // One sentence for the user; set at the limit ("deliver-work has run 3 times: the limit").
  detail: z.string().optional(),
  // The checks are waited for because a rule of the step asks about them, after the gate itself
  // has passed (or without one).
  forRules: z.boolean().optional(),
  // When the step ended: checks count only when read after this, and the wait for them is
  // measured from it.
  since: z.iso.datetime(),
  // The commit the run's folder was on when the step ended. Checks count only when they are for
  // this commit; null or absent when the folder has none, and then any read after `since` counts.
  headSha: z.string().nullable().optional(),
  // When the gate got its current state.
  at: z.iso.datetime(),
});
export type StepGate = z.infer<typeof StepGate>;

// The facts of a step with rules, read when it ended and kept until its rules are followed,
// which can be much later when a gate waits for the user in between.
export const StepFacts = z.object({
  verdict: Verdict,
  artifacts: ArtifactsFact,
  // Absent until the checks were read. `undecided`: the wait ran out or the user ended it, so no
  // rule on checks holds.
  checks: z.enum(['successful', 'failed', 'undecided']).optional(),
  // The commit the run's folder was on when the step ended; only checks of it count.
  headSha: z.string().optional(),
});
export type StepFacts = z.infer<typeof StepFacts>;

export const StepRun = z.object({
  stepId: z.string().min(1),
  state: StepRunState,
  threadId: z.string().min(1).optional(),
  startedAt: z.iso.datetime().optional(),
  endedAt: z.iso.datetime().optional(),
  artifactsFound: z.array(z.string()),
  // The step's final assistant message, kept for the next step's handover.
  finalMessage: z.string().optional(),
  error: z.string().optional(),
  // The changed files when the step ended, so the Changes tab can tell what this step changed
  // (review loop spec 11). Absent for a run without a base.
  fileHashes: z.array(FileHash).optional(),
  // How many times the step has run: absent for the first time, 2 after one send back (review
  // loop spec 16).
  attempt: z.number().int().min(2).optional(),
  // How the gate after the step stands or was passed. Only a gate with a condition has one. A
  // step also has one while it waits for checks a rule asks about, and while it waits at the
  // limit.
  gate: StepGate.optional(),
  // Only a step with rules has them.
  facts: StepFacts.optional(),
  // The message the step runs again with, while a rule or the list sent the run back to it and
  // its thread is still answering a message the user typed there. It is sent when that turn
  // ends; until then the step is running without a turn of its own.
  heldPrompt: z.string().optional(),
  // Where the run waits at this step while it does: after the step ended, or before the step
  // starts (its gate before, or the limit). Set by the engine, so a step that ran before and
  // keeps its end time is not read as waited after. Absent on runs stored without it.
  waits: z.enum(['before', 'after']).optional(),
});
export type StepRun = z.infer<typeof StepRun>;

// Where a run went after a visit and who decided: one of the step's rules, the order of the
// list, or the user sending the step back.
export const PathNext = z.object({
  to: RuleTarget,
  by: z.enum(['rule', 'list', 'user']),
  when: RuleCondition.optional(),
});
export type PathNext = z.infer<typeof PathNext>;

// One start of a step in a run (workflow branches spec 18). `StepRun` stays one row per step;
// the path has one entry per time a step ran, in the order it happened.
export const PathVisit = z.object({
  stepId: z.string().min(1),
  attempt: z.number().int().min(1),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  // How the visit ended; null while the step runs.
  ended: z.enum(['done', 'failed', 'stopped']).nullable(),
  // Where the run went next, null until that is decided and for a run that ended without a
  // next move (failed, stopped).
  next: PathNext.nullable(),
  // Why, in a few words: "verdict changes requested → deliver-work", "no rule held → next step".
  reason: z.string().nullable(),
  // Set when the next step had reached the limit and the run waited for the user there.
  limit: z.string().optional(),
});
export type PathVisit = z.infer<typeof PathVisit>;

// 'waiting' is "waiting for you" at a gate (behavior 9); 'stopped' is the user pressing Stop.
export const WorkflowRunState = z.enum(['running', 'waiting', 'done', 'failed', 'stopped']);
export type WorkflowRunState = z.infer<typeof WorkflowRunState>;

export const isLiveRunState = (state: WorkflowRunState): boolean =>
  state === 'running' || state === 'waiting';

// A run's own working copy (review loop spec 36 to 38): `pending` while the server makes it,
// `ready` while the run works in it, `failed` when it could not be made, and after the run ended
// `removed`, or `kept` because removing it would lose work or did not succeed.
export const WorkingCopyState = z.enum(['pending', 'ready', 'failed', 'kept', 'removed']);
export type WorkingCopyState = z.infer<typeof WorkingCopyState>;

// What a kept working copy holds that is nowhere else.
export const UnpushedWork = z.object({
  // Changed and new files that are not committed (ignored files do not count).
  uncommittedFiles: z.number().int().nonnegative(),
  // Commits no branch on the remote reaches, and the subject of the newest one.
  unpushedCommits: z.number().int().nonnegative(),
  newestSubject: z.string().nullable(),
  // The branch the working copy is on, null while it is on none.
  branch: z.string().nullable(),
});
export type UnpushedWork = z.infer<typeof UnpushedWork>;

export const WorkingCopy = z.object({
  // The folder, decided when the run starts so every step's thread can name it as its `cwd`.
  path: z.string().min(1),
  state: WorkingCopyState,
  // The commit it was made at and the default branch that commit was the tip of. Null until it
  // is ready, and the branch is null when the project has no remote to name one.
  startSha: z.string().min(1).nullable(),
  defaultBranch: z.string().nullable(),
  // Said on the run when the start is not the fetched tip (the fetch failed, or was not asked).
  note: z.string().nullable(),
  // Set when the copy is kept because of what it holds.
  unpushed: UnpushedWork.nullable(),
  // Why it could not be made (`failed`) or could not be removed (`kept`).
  error: z.string().nullable(),
  // The branch the copy is made on, for a run an event started on a pull request (review loop
  // spec 48). Absent or null: on no branch, at the default branch's tip.
  branch: z.string().min(1).nullable().optional(),
});
export type WorkingCopy = z.infer<typeof WorkingCopy>;

// Whether the folder is (or may still be) on disk.
export const workingCopyOnDisk = (copy: WorkingCopy): boolean =>
  copy.state === 'ready' || copy.state === 'kept';

// What the server does once a run transition has committed. The workflow engine decides them;
// the server performs them and reports outcomes back as commands.
export const RunEffect = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('startStep'),
    runId: z.string().min(1),
    stepId: z.string().min(1),
    threadId: z.string().min(1),
    prompt: z.string(),
  }),
  // A step sent back at a gate runs again in its own thread. The orchestrator starts that turn in
  // the same commit as the run change, so nothing is left to perform; the effect records what
  // was sent.
  z.object({
    type: z.literal('sendBack'),
    runId: z.string().min(1),
    stepId: z.string().min(1),
    threadId: z.string().min(1),
    attempt: z.number().int().min(2),
    prompt: z.string(),
  }),
  z.object({ type: z.literal('interrupt'), threadId: z.string().min(1) }),
  z.object({
    type: z.literal('setThreadState'),
    threadId: z.string().min(1),
    state: ThreadState,
  }),
  z.object({
    type: z.literal('notify'),
    runId: z.string().min(1),
    stepId: z.string().min(1).nullable(),
    reason: z.enum(['waiting', 'failed', 'done']),
  }),
]);
export type RunEffect = z.infer<typeof RunEffect>;

// A starting point offered by the builder (behavior 25). Templates carry no provider instance;
// the user picks one per step when building from a template.
// A template's steps have no ids, so a rule in a template names the step it goes to by its skill.
export const TemplateRuleTarget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('skill'), skillName: z.string().min(1) }),
  z.object({ type: z.literal('end') }),
]);
export type TemplateRuleTarget = z.infer<typeof TemplateRuleTarget>;

export const TemplateRule = z.object({ when: RuleCondition, goTo: TemplateRuleTarget });
export type TemplateRule = z.infer<typeof TemplateRule>;

export const WorkflowTemplateStep = z.object({
  skillName: z.string().min(1),
  gateBefore: z.boolean(),
  gateAfter: z.boolean(),
  expectedArtifacts: z.array(z.string().min(1)),
  // Absent in templates stored before rules existed; they stay as they are.
  rules: z.array(TemplateRule).optional(),
});
export type WorkflowTemplateStep = z.infer<typeof WorkflowTemplateStep>;

// The rules of a template's step for a workflow made from it: each skill a rule names becomes
// the step that runs it, the nearest one before the rule's step, else the first one in the list.
// A rule whose skill no step runs is left out.
export function rulesFromTemplate(
  template: readonly WorkflowTemplateStep[],
  stepIds: readonly string[],
  index: number,
): StepRule[] {
  const rules: StepRule[] = [];
  for (const { when, goTo } of template[index]?.rules ?? []) {
    if (goTo.type === 'end') {
      rules.push({ when, goTo });
      continue;
    }
    const runs = (step: WorkflowTemplateStep) => step.skillName === goTo.skillName;
    const before = template.slice(0, index).findLastIndex(runs);
    const stepId = stepIds[before >= 0 ? before : template.findIndex(runs)];
    if (stepId !== undefined) rules.push({ when, goTo: { type: 'step', stepId } });
  }
  return rules;
}

// The other way, for "Save as template": a rule keeps its place when the step it goes to can be
// named by its skill and found again by `rulesFromTemplate`.
export function rulesForTemplate(
  steps: readonly Pick<WorkflowStep, 'id' | 'skillName' | 'rules'>[],
  index: number,
): TemplateRule[] {
  const template = steps.map((step) => ({ skillName: step.skillName }));
  const rules: TemplateRule[] = [];
  for (const { when, goTo } of steps[index]?.rules ?? []) {
    if (goTo.type === 'end') {
      rules.push({ when, goTo });
      continue;
    }
    const target = steps.findIndex((step) => step.id === goTo.stepId);
    const skillName = steps[target]?.skillName;
    if (skillName === undefined) continue;
    const runs = (step: { skillName: string }) => step.skillName === skillName;
    const before = template.slice(0, index).findLastIndex(runs);
    if ((before >= 0 ? before : template.findIndex(runs)) === target) {
      rules.push({ when, goTo: { type: 'skill', skillName } });
    }
  }
  return rules;
}

export const WorkflowTemplate = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  steps: z.array(WorkflowTemplateStep).min(1),
});
export type WorkflowTemplate = z.infer<typeof WorkflowTemplate>;
