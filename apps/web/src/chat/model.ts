import {
  providerChatOptions,
  UsageItemPayload,
  type PermissionModeOption,
  type ProviderKind,
  type ProviderModel,
  type Skill,
  type Thread,
  type ThreadItem,
  type ThreadState,
  type Turn,
  type Workflow,
  type WorkflowRun,
} from '@wow/contracts';

// Pure helpers for the chat view. Everything here derives from rows the server pushed; nothing
// reads the clock or keeps state of its own.

export type ThreadGroup = 'Needs you' | 'Working' | 'Idle' | 'Done';

export const threadGroups: readonly ThreadGroup[] = ['Needs you', 'Working', 'Idle', 'Done'];

const groupOfState: Readonly<Record<ThreadState, ThreadGroup>> = {
  needs_you: 'Needs you',
  working: 'Working',
  idle: 'Idle',
  // A failed turn leaves the thread waiting for the user like an idle one; the row marks it.
  failed: 'Idle',
  done: 'Done',
};

const pinnedThenRecent = (a: Thread, b: Thread) =>
  Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt);

// Spec 21: grouped by state, pinned threads first, then the most recently active.
export function groupThreads(
  threads: readonly Thread[],
): ReadonlyArray<readonly [ThreadGroup, readonly Thread[]]> {
  const groups = new Map<ThreadGroup, Thread[]>(threadGroups.map((group) => [group, []]));
  for (const thread of threads) groups.get(groupOfState[thread.state])?.push(thread);
  return threadGroups.map(
    (group) => [group, (groups.get(group) ?? []).toSorted(pinnedThenRecent)] as const,
  );
}

// The server refuses to put away a thread that works or waits for the user; the controls follow.
export const canMarkDone = (thread: Pick<Thread, 'state'>): boolean =>
  thread.state === 'idle' || thread.state === 'failed';

export const threadTitle = (thread: Pick<Thread, 'title'>): string =>
  thread.title.trim() === '' ? 'New thread' : thread.title;

// The thread title is the first line of the first message, the way it was asked.
export const titleFromMessage = (text: string): string => text.trim().split('\n', 1)[0] ?? '';

// "Feature · plan-work" for a thread a workflow run started.
export function runLabel(
  thread: Pick<Thread, 'runId' | 'stepId'>,
  runs: readonly WorkflowRun[],
  workflows: readonly Workflow[],
): string | undefined {
  if (thread.runId === null) return undefined;
  const run = runs.find((candidate) => candidate.id === thread.runId);
  const workflow = run && workflows.find((candidate) => candidate.id === run.workflowId);
  const step = workflow?.steps.find((candidate) => candidate.id === thread.stepId);
  const runName = workflow?.name ?? 'Workflow run';
  if (step) return `${runName} · ${step.skillName}`;
  return thread.stepId === null ? runName : `${runName} · ${thread.stepId}`;
}

export const runningTurn = (turns: readonly Turn[]): Turn | undefined =>
  turns.find((turn) => turn.state === 'running');

export const lastTurn = (turns: readonly Turn[]): Turn | undefined =>
  turns.reduce<Turn | undefined>(
    (latest, turn) => (latest === undefined || turn.index > latest.index ? turn : latest),
    undefined,
  );

export interface ContextUsage {
  readonly usedTokens: number;
  readonly maxTokens: number;
}

// The latest context report: usage items hold it under `context` once the provider sent one.
export function latestContext(items: readonly ThreadItem[]): ContextUsage | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== 'usage') continue;
    const parsed = UsageItemPayload.safeParse(item.payload);
    if (parsed.success && parsed.data.context) return parsed.data.context;
  }
  return undefined;
}

const integer = new Intl.NumberFormat('en-US');

export const formatTokens = (value: number): string => integer.format(value);

export function formatCost(usd: number): string {
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

export function contextPercent(context: ContextUsage): number {
  return Math.min(100, Math.round((context.usedTokens / context.maxTokens) * 100));
}

// Model, effort and permission choices for a provider kind. The current value always stays
// selectable, so a thread whose model is not in the list (yet) still shows it.
export function modelOptions(models: readonly ProviderModel[], current: string): string[] {
  const ids = models.map((model) => model.id);
  return current === '' || ids.includes(current) ? ids : [current, ...ids];
}

export function effortOptions(
  kind: ProviderKind,
  models: readonly ProviderModel[],
  model: string,
  current: string,
): string[] {
  const efforts = models.find((candidate) => candidate.id === model)?.efforts ?? [];
  const fallback = providerChatOptions[kind].defaultEffort;
  const options = [...(fallback === null ? [] : [fallback]), ...efforts];
  const unique = [...new Set(options)];
  return current === '' || unique.includes(current) ? unique : [current, ...unique];
}

export function permissionOptions(
  kind: ProviderKind,
  current: string,
): readonly PermissionModeOption[] {
  const options = providerChatOptions[kind].permissionModes;
  return current === '' || options.some((option) => option.id === current)
    ? options
    : [{ id: current, label: current }, ...options];
}

// Skill picker (spec 18): a `$` at the start of a word opens it; what follows filters it.
export interface SkillQuery {
  readonly start: number;
  readonly query: string;
}

export function skillQuery(text: string, caret: number): SkillQuery | undefined {
  const before = text.slice(0, caret);
  const match = /(^|\s)\$([^\s$]*)$/.exec(before);
  if (!match) return undefined;
  const query = match[2] ?? '';
  return { start: caret - query.length - 1, query };
}

export function filterSkills(skills: readonly Skill[], query: string): Skill[] {
  const needle = query.toLowerCase();
  const rank = (skill: Skill): number => {
    const name = skill.name.toLowerCase();
    if (name.startsWith(needle)) return 0;
    if (name.includes(needle)) return 1;
    if (skill.description.toLowerCase().includes(needle)) return 2;
    return 3;
  };
  return skills
    .map((skill) => ({ skill, rank: rank(skill) }))
    .filter((entry) => entry.rank < 3)
    .toSorted((a, b) => a.rank - b.rank || a.skill.name.localeCompare(b.skill.name))
    .map((entry) => entry.skill);
}

export function insertSkill(
  text: string,
  query: SkillQuery,
  caret: number,
  invocation: string,
): { readonly text: string; readonly caret: number } {
  const inserted = `${invocation} `;
  return {
    text: text.slice(0, query.start) + inserted + text.slice(caret),
    caret: query.start + inserted.length,
  };
}
