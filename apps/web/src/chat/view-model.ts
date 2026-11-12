import {
  isBuiltInSkillName,
  QuestionItemPayload,
  UsageItemPayload,
  SkillGroup,
  skillGroupOf,
  TextItemPayload,
  ToolCallItemPayload,
  type Approval,
  type Project,
  type ProviderInstance,
  type ProviderKind,
  type Question,
  type SentImage,
  type SentSkill,
  type Skill,
  type SkillRef,
  type Thread,
  type ThreadItem,
  type Turn,
} from '@wow/contracts';
import { threadTitle } from './model';
import { oneLine } from './tools/facts';

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

// Where a skill comes from, for the list's group headings and the chip's mark: Yours, wow,
// Project, User, Plugins, Other, in that order (wow skills spec 1, 7).
export const skillGroups: readonly SkillGroup[] = SkillGroup.options;
export const skillGroup = (skill: Pick<Skill, 'source' | 'invocations'>): SkillGroup =>
  skillGroupOf(skill);

// The chat's skill list (agent workbench spec 57): your own skills and the project's lead,
// then the ones this thread used lately, the user's and the plugins', and wow's last: wow's own
// are mostly for workflow steps.
export type ChatSkillSection = SkillGroup | 'recent';
export const chatSkillSections: readonly ChatSkillSection[] = [
  'yours',
  'project',
  'recent',
  'user',
  'plugins',
  'other',
  'wow',
];
export const chatSkillSectionLabels: Readonly<Record<ChatSkillSection, string>> = {
  yours: 'Yours',
  project: 'Project',
  recent: 'Recently used',
  user: 'User',
  plugins: 'Plugins',
  other: 'Other',
  wow: 'wow',
};
export function chatSkillSection(
  skill: Pick<Skill, 'source' | 'invocations' | 'name'>,
  recent: readonly string[],
): ChatSkillSection {
  const group = skillGroupOf(skill);
  return group !== 'yours' && group !== 'project' && recent.includes(skill.name) ? 'recent' : group;
}

// wow's four built-in skills are written for workflow steps (wow skills spec 1).
export const isStepSkill = (skill: Pick<Skill, 'source' | 'name'>): boolean =>
  skill.source === 'wow' && isBuiltInSkillName(skill.name);

// The skills this thread's messages were sent with, newest first, once each.
export function recentSkillNames(items: readonly ThreadItem[]): string[] {
  const names: string[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== 'user') continue;
    const parsed = TextItemPayload.safeParse(item.payload);
    for (const skill of parsed.success ? (parsed.data.skills ?? []) : []) {
      if (!names.includes(skill.name)) names.push(skill.name);
    }
  }
  return names;
}

// The group of a skill a message was sent with: a folder skill's group follows its invocation.
export const sentSkillGroup = (skill: SentSkill): SkillGroup =>
  skillGroupOf({ source: skill.source, invocations: { claude: skill.invocation ?? '' } });

// The name a sent skill's chip shows: a plugin skill is named `plugin:name` when it is sent, but
// shows its own name with the plugins mark, as in the composer.
export const sentSkillName = (skill: SentSkill): string =>
  sentSkillGroup(skill) === 'plugins' ? skill.name.slice(skill.name.indexOf(':') + 1) : skill.name;

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
      Number(skillGroup(b) === 'project') - Number(skillGroup(a) === 'project') ||
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

// The user's last message with its skills, as a message names them, so "Retry" sends both again
// (a message may be only a chip).
export function lastUserSent(
  items: readonly ThreadItem[],
):
  { readonly text: string; readonly skills: SkillRef[]; readonly images: SentImage[] } | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== 'user') continue;
    const parsed = TextItemPayload.safeParse(item.payload);
    if (!parsed.success) continue;
    const skills = (parsed.data.skills ?? []).map((skill): SkillRef =>
      skill.source === 'wow' || skill.source === 'yours'
        ? { name: skill.name, source: skill.source }
        : { name: skill.name },
    );
    const images = parsed.data.images ?? [];
    if (parsed.data.text.trim() !== '' || skills.length > 0 || images.length > 0) {
      return { text: parsed.data.text, skills, images };
    }
  }
  return undefined;
}

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

// What the working line says about the running turn (agent workbench spec 45): the tool call
// that runs now, how many calls the turn made, and its tokens where the provider counts them
// while the turn runs (Codex does; Claude Code reports them only at the end).
export interface WorkingFacts {
  readonly tool: string | undefined;
  readonly toolCalls: number;
  readonly tokens: { readonly input: number; readonly output: number } | undefined;
}

export function workingFacts(
  items: readonly ThreadItem[],
  turnId: string,
  cwd: string,
): WorkingFacts {
  const ofTurn = items.filter((item) => item.turnId === turnId);
  const calls = ofTurn.flatMap((item) => {
    if (item.kind !== 'tool_call') return [];
    const parsed = ToolCallItemPayload.safeParse(item.payload);
    return parsed.success ? [parsed.data] : [];
  });
  const runningCall = calls.findLast((call) => call.status === 'running');
  const usageItem = ofTurn.findLast((item) => item.kind === 'usage');
  const usage = usageItem ? UsageItemPayload.safeParse(usageItem.payload) : undefined;
  const counted =
    usage?.success &&
    (usage.data.inputTokens !== undefined || usage.data.outputTokens !== undefined)
      ? { input: usage.data.inputTokens ?? 0, output: usage.data.outputTokens ?? 0 }
      : undefined;
  return {
    tool:
      runningCall === undefined
        ? undefined
        : (runningCall.command ??
          (runningCall.server !== undefined && runningCall.tool !== undefined
            ? `${runningCall.server} › ${runningCall.tool}`
            : oneLine(runningCall, cwd))),
    toolCalls: calls.length,
    tokens: counted,
  };
}

// The messages Alt+Up and Alt+Down move between (spec 74): the user's and the agent's text.
export const isMessage = (item: Pick<ThreadItem, 'kind'>): boolean =>
  item.kind === 'user' || item.kind === 'assistant_text';

// The item ids whose row shows when their turn ended (spec 75): each ended turn's last answer.
export function turnEndRows(items: readonly ThreadItem[], turns: readonly Turn[]): Set<string> {
  const ended = new Set(turns.filter((turn) => turn.endedAt !== null).map((turn) => turn.id));
  const last = new Map<string, string>();
  for (const item of items) {
    if (item.kind === 'assistant_text' && ended.has(item.turnId)) last.set(item.turnId, item.id);
  }
  return new Set(last.values());
}

// Reasoning is done once its turn ended or anything came after it in the turn (spec 88).
export function finishedReasoning(items: readonly ThreadItem[]): Set<string> {
  const done = new Set<string>();
  const turnsWithLater = new Set<string>();
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    if (item.kind === 'reasoning' && (!item.streaming || turnsWithLater.has(item.turnId))) {
      done.add(item.id);
    }
    turnsWithLater.add(item.turnId);
  }
  return done;
}
