import { z } from 'zod';
import { ThreadState } from './provider.js';
import { BuiltInSkillName, SentSkill, SkillRef, WowSkillSource } from './skills.js';

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
  // Set when the step runs a wow skill: `yours` keeps an own skill apart from a folder skill of
  // the same name. Absent: a folder skill, or a built-in one by its reserved name.
  skillSource: WowSkillSource.optional(),
  // Skills the step also follows, after the one it runs and before the extra prompt, in this
  // order (wow skills spec 11). Absent: none.
  alsoFollow: z.array(SkillRef).optional(),
  // Built-in skills wow would attach by itself that this step leaves out (spec 12).
  leaveOut: z.array(BuiltInSkillName).optional(),
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

// What one file looked like at a moment of a thread: the SHA-256 of its content in the folder,
// or null when the file is not there. Only files that differ from the thread's base are listed,
// so a path that is missing from a list was the same as in the base.
export const FileHash = z.object({ path: z.string().min(1), hash: z.string().min(1).nullable() });
export type FileHash = z.infer<typeof FileHash>;

// A thread's own working copy (thread work spec 11 to 16): `pending` while the server makes it,
// `ready` while the thread works in it, `failed` when it could not be made, and once the thread
// is done `removed`, or `kept` because removing it would lose work or did not succeed.
export const WorkingCopyState = z.enum(['pending', 'ready', 'failed', 'kept', 'removed']);
export type WorkingCopyState = z.infer<typeof WorkingCopyState>;

// What a kept working copy holds that is nowhere else.
export const UnpushedWork = z.object({
  // Changed and new files that are not committed, ignored ones not counted.
  uncommittedFiles: z.number().int().nonnegative(),
  // Files and folders the repository ignores (a local settings file, build output), each
  // ignored folder counted once. Absent on copies settled before they were counted.
  ignoredFiles: z.number().int().nonnegative().optional(),
  // Commits no branch on the remote reaches, and the subject of the newest one.
  unpushedCommits: z.number().int().nonnegative(),
  newestSubject: z.string().nullable(),
  // The branch the working copy is on, null while it is on none.
  branch: z.string().nullable(),
  // A chat thread's copy only (thread work spec 14, 15): of those commits, the ones made on no
  // branch (HEAD detached), which its branch does not keep and are lost with the folder.
  commitsOnNoBranch: z.number().int().nonnegative().optional(),
  // A chat thread's copy only (spec 15): a digest of what it holds (the status of every changed,
  // new and ignored path, and the commits on no branch), so a removal notices one file swapped
  // for another after the dialog read it, which the counts alone do not show.
  digest: z.string().min(1).optional(),
});
export type UnpushedWork = z.infer<typeof UnpushedWork>;

export const WorkingCopy = z.object({
  // The folder, decided when the thread is made so it can name it as its `cwd`.
  path: z.string().min(1),
  state: WorkingCopyState,
  // The commit it was made at and the default branch that commit was the tip of. Null until it
  // is ready, and the branch is null when the project has no remote to name one.
  startSha: z.string().min(1).nullable(),
  defaultBranch: z.string().nullable(),
  // Said on the thread when the start is not the fetched tip (the fetch failed, or was not asked).
  note: z.string().nullable(),
  // Set when the copy is kept because of what it holds.
  unpushed: UnpushedWork.nullable(),
  // Why it could not be made (`failed`) or could not be removed (`kept`).
  error: z.string().nullable(),
  // The branch the copy is made on. Absent or null: on no branch.
  branch: z.string().min(1).nullable().optional(),
  // A chat thread's: the commit wow asked git to make `branch` at, stored before `git worktree
  // add -b` runs, so wow knows the branch is its own. Git makes the branch before the folder and
  // leaves it when the folder then fails; a branch at this commit that never moved is taken up
  // again by the next try. wow never deletes a branch (thread work spec 15).
  branchStart: z.string().min(1).nullable().optional(),
  // A helper's copy made from another repository than its project's (orchestrator threads spec
  // 5): that repository's folder. Absent: the project's folder.
  repository: z.string().min(1).optional(),
});
export type WorkingCopy = z.infer<typeof WorkingCopy>;

// Where a chat thread's own working copy starts (`chat.workingCopyStart`, thread work spec 11):
// the commit the project folder is on, or the default branch's tip.
export const WorkingCopyStart = z.enum(['head', 'defaultBranch']);
export type WorkingCopyStart = z.infer<typeof WorkingCopyStart>;

// What `/chat/new` says about an own working copy for the chosen project before the thread exists
// (thread work spec 10), read without changing anything. `ok`: the project folder is in a
// repository with a commit; `on` is the project's `chat.ownWorkingCopy`, `template` its
// `chat.workingCopyBranch` (the app fills in the title as it is typed), `from` the branch the
// copy starts from (null on no branch) and `sha` the commit as this computer knows it now;
// `fetch` says the default branch is fetched first. Otherwise there is no switch, and `reason`
// says why.
export const WorkingCopyPlan = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    on: z.boolean(),
    template: z.string(),
    start: WorkingCopyStart,
    from: z.string().nullable(),
    sha: z.string().min(1),
    fetch: z.boolean(),
  }),
  z.object({ status: z.literal('unavailable'), reason: z.string() }),
]);
export type WorkingCopyPlan = z.infer<typeof WorkingCopyPlan>;

// Whether the folder is (or may still be) on disk.
export const workingCopyOnDisk = (copy: WorkingCopy): boolean =>
  copy.state === 'ready' || copy.state === 'kept';
