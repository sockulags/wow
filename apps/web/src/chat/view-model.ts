import {
  TextItemPayload,
  type Approval,
  type Project,
  type ProviderInstance,
  type ProviderKind,
  type Question,
  type Skill,
  type Thread,
  type ThreadItem,
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

export const pendingQuestion = (questions: readonly Question[]): Question | undefined =>
  questions.find((question) => question.answer === null);

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
