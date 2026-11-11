import {
  QuestionItemPayload,
  TextItemPayload,
  ToolCallItemPayload,
  type Approval,
  type Project,
  type ProviderInstance,
  type ProviderKind,
  type Question,
  type Skill,
  type Thread,
  type ThreadItem,
  type Turn,
} from '@wow/contracts';
import { threadTitle } from './model';

// Pure helpers for how chat, workflows and backlog present server rows: labels, times, groups.
// Nothing here keeps state; `now` is passed in where a label depends on the day.

export const providerKindNames: Readonly<Record<ProviderKind, string>> = {
  claude: 'Claude',
  codex: 'Codex',
};

// "Mock Claude", with the kind only when two instances share a name.
export function providerLabel(
  instance: Pick<ProviderInstance, 'id' | 'name' | 'kind'>,
  instances: readonly Pick<ProviderInstance, 'id' | 'name'>[],
): string {
  const clash = instances.some(
    (other) => other.id !== instance.id && other.name.trim() === instance.name.trim(),
  );
  return clash ? `${instance.name} (${providerKindNames[instance.kind]})` : instance.name;
}

// What the new-thread view starts with (owner decision F-5): the instance, model, effort,
// permission mode and folder of the thread the user started last. Threads live on the server, so
// this follows the user across windows and restarts without anything kept in the browser.
export function lastUsedThread(threads: readonly Thread[]): Thread | undefined {
  return threads
    .filter((thread) => thread.runId === null)
    .reduce<Thread | undefined>(
      (latest, thread) =>
        latest === undefined || thread.createdAt > latest.createdAt ? thread : latest,
      undefined,
    );
}

// Folders threads ran in without a project, newest first, for the project picker's recent
// folders. A folder that is a project's folder is offered as that project instead.
export function recentFolders(
  threads: readonly Thread[],
  projects: readonly Pick<Project, 'cwd'>[],
): string[] {
  const projectFolders = new Set(projects.map((project) => project.cwd));
  const folders: string[] = [];
  for (const thread of threads.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (thread.projectId !== null || projectFolders.has(thread.cwd)) continue;
    if (!folders.includes(thread.cwd)) folders.push(thread.cwd);
  }
  return folders;
}

// A run's thread is titled "<workflow>: <skill>"; in a list that names the workflow on the
// second line, the title is the step.
export function listTitle(thread: Pick<Thread, 'title'>, workflowName: string | undefined): string {
  const title = threadTitle(thread);
  const prefix = workflowName ? `${workflowName}: ` : undefined;
  return prefix && title.startsWith(prefix) && title.length > prefix.length
    ? title.slice(prefix.length)
    : title;
}

const pad = (value: number) => String(value).padStart(2, '0');

// A running turn's clock: "0:42", "12:05", "1:02:03".
export function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

// One label map for effort values: Default, Low, Medium, High.
export const effortLabel = (effort: string): string =>
  effort === 'default' ? 'Default' : effort.charAt(0).toUpperCase() + effort.slice(1);

export type SkillGroup = 'Project' | 'User' | 'Plugins' | 'Other';
export const skillGroups: readonly SkillGroup[] = ['Project', 'User', 'Plugins', 'Other'];

// Where a skill comes from, for the picker's group headings.
export function skillGroup(skill: Pick<Skill, 'source' | 'invocations'>): SkillGroup {
  if (skill.invocations.claude.includes(':')) return 'Plugins';
  if (skill.source === 'project-claude' || skill.source === 'project-agents') return 'Project';
  if (skill.source === 'user-claude' || skill.source === 'user-codex') return 'User';
  return 'Other';
}

export const skillSourceLabels: Readonly<Record<Skill['source'], string>> = {
  'user-claude': 'Claude user skills',
  'user-codex': 'Codex user skills',
  'project-claude': 'Project .claude',
  'project-agents': 'Project .agents',
  custom: 'Custom folder',
  wow: 'Built into wow',
  yours: 'Your skills',
};

// The muted source label of one picker row: the plugin's name, or where it was found.
export function skillSourceLabel(skill: Pick<Skill, 'source' | 'invocations'>): string {
  const plugin = /^\/([^:]+):/.exec(skill.invocations.claude)?.[1];
  return plugin ? `Plugin ${plugin}` : skillSourceLabels[skill.source];
}

// Skills for the new-thread starters: the project's own first, then the rest, by name.
export function starterSkills(skills: readonly Skill[], count: number): Skill[] {
  const seen = new Set<string>();
  const unique: Skill[] = [];
  for (const skill of skills.toSorted(
    (a, b) =>
      Number(skillGroup(b) === 'Project') - Number(skillGroup(a) === 'Project') ||
      a.name.localeCompare(b.name),
  )) {
    if (skill.manualOnly || seen.has(skill.name)) continue;
    seen.add(skill.name);
    unique.push(skill);
  }
  return unique.slice(0, count);
}

export const pendingApproval = (approvals: readonly Approval[]): Approval | undefined =>
  approvals.find((approval) => approval.decision === null);

// Only a question of the running turn waits: once its turn ends it takes no answer (spec 5), and
// the composer goes back to sending messages.
export const pendingQuestion = (
  questions: readonly Question[],
  items: readonly ThreadItem[],
  running: Turn | undefined,
): Question | undefined => {
  if (!running) return undefined;
  const turnOf = new Map(items.map((item) => [item.id, item.turnId]));
  return questions.find(
    (question) => question.answer === null && turnOf.get(question.itemId) === running.id,
  );
};

function lastText(items: readonly ThreadItem[], kind: ThreadItem['kind']): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== kind) continue;
    const parsed = TextItemPayload.safeParse(item.payload);
    if (parsed.success && parsed.data.text.trim() !== '') return parsed.data.text;
  }
  return undefined;
}

// The user's last message, for "Retry".
export const lastUserMessage = (items: readonly ThreadItem[]) => lastText(items, 'user');

// A thread's last assistant message, for the gate's "what to review".
export const lastAssistantText = (items: readonly ThreadItem[]) =>
  lastText(items, 'assistant_text');

// The last error item, the one Retry and Resume belong to.
export const lastErrorId = (items: readonly ThreadItem[]): string | undefined =>
  items.findLast((item) => item.kind === 'error')?.id;

// One entry of the conversation list: an item as it is, or a run of tool calls drawn as one row.
export type ConversationEntry =
  | { readonly kind: 'item'; readonly item: ThreadItem }
  | { readonly kind: 'tools'; readonly id: string; readonly items: readonly ThreadItem[] }
  | { readonly kind: 'questions'; readonly id: string; readonly items: readonly ThreadItem[] };

const askIdOf = (item: ThreadItem): string | undefined => {
  if (item.kind !== 'question') return undefined;
  const parsed = QuestionItemPayload.safeParse(item.payload);
  return parsed.success ? parsed.data.askId : undefined;
};

// The questions of one ask are one card (questions spec 3): consecutive question items of the
// same turn with the same ask become one entry. A question from before the card has no ask and
// stays alone.
export function groupQuestions(entries: readonly ConversationEntry[]): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  for (const entry of entries) {
    const previous = out.at(-1);
    const askId = entry.kind === 'item' ? askIdOf(entry.item) : undefined;
    if (entry.kind !== 'item' || askId === undefined) {
      out.push(entry);
      continue;
    }
    const last =
      previous?.kind === 'questions'
        ? previous.items.at(-1)
        : previous?.kind === 'item'
          ? previous.item
          : undefined;
    if (
      previous &&
      previous.kind !== 'tools' &&
      last !== undefined &&
      askIdOf(last) === askId &&
      last.turnId === entry.item.turnId
    ) {
      const items = previous.kind === 'questions' ? previous.items : [previous.item];
      out[out.length - 1] = {
        kind: 'questions',
        id: items[0]?.id ?? entry.item.id,
        items: [...items, entry.item],
      };
      continue;
    }
    out.push(entry);
  }
  return out;
}

// Consecutive tool calls of one turn become one entry, so a turn that reads ten things does not
// fill the screen before its answer. Any other item breaks the run, and so does a row the view
// draws after a call (`endsRun`: the Assistant's change rows and cards). The entry's id is its
// first call's, so the row keeps its open state while the run grows.
export function groupToolCalls(
  items: readonly ThreadItem[],
  endsRun: (item: ThreadItem) => boolean = () => false,
): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  let run: ThreadItem[] = [];
  const close = () => {
    const [first] = run;
    if (first !== undefined) {
      entries.push(
        run.length === 1
          ? { kind: 'item', item: first }
          : { kind: 'tools', id: first.id, items: run },
      );
    }
    run = [];
  };
  for (const item of items) {
    if (item.kind !== 'tool_call') {
      close();
      entries.push({ kind: 'item', item });
      continue;
    }
    if (run[0] !== undefined && run[0].turnId !== item.turnId) close();
    run.push(item);
    if (endsRun(item)) close();
  }
  close();
  return entries;
}

// How many calls of a run failed or were refused, so the collapsed row still says so.
export const failedToolCalls = (items: readonly ThreadItem[]): number =>
  items.filter((item) => {
    const parsed = ToolCallItemPayload.safeParse(item.payload);
    return parsed.success && parsed.data.status === 'error';
  }).length;
