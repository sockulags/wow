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
});
export type WorkflowStep = z.infer<typeof WorkflowStep>;

// Spec behavior 26: not started, running, waiting, done or failed.
export const StepRunState = z.enum(['not_started', 'running', 'waiting', 'done', 'failed']);
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
// `passedByUser`: the user approved it.
export const StepGate = z.object({
  state: z.enum(['waitingForChecks', 'waitingForUser', 'passedByItself', 'passedByUser']),
  parts: z.array(GatePartResult),
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
  // How the gate after the step stands or was passed. Only a gate with a condition has one.
  gate: StepGate.optional(),
});
export type StepRun = z.infer<typeof StepRun>;

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
export const WorkflowTemplateStep = z.object({
  skillName: z.string().min(1),
  gateBefore: z.boolean(),
  gateAfter: z.boolean(),
  expectedArtifacts: z.array(z.string().min(1)),
});
export type WorkflowTemplateStep = z.infer<typeof WorkflowTemplateStep>;

export const WorkflowTemplate = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  steps: z.array(WorkflowTemplateStep).min(1),
});
export type WorkflowTemplate = z.infer<typeof WorkflowTemplate>;
