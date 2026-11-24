import {
  isWorkflowSkill,
  providerChatOptions,
  type CalendarItem,
  type CardState,
  type DomainEvent,
  type ServerCommand,
} from '@wow/contracts';
import path from 'node:path';
import { settingValue } from '../assistant/permissions.js';
import { backlogFollowsCard } from './backlog.js';
import { CommandRejected, type DecideContext, type ReadModel } from './orchestrator.js';

// Scheduled jobs as main threads (orchestrator threads spec 27, 28): a card's occurrence starts a
// main thread that runs the card's workflow, or sends the next message to the same one, and the
// card follows that thread.

// The workflow a card starts, by its file's name. A card made before workflows were files names
// its stored workflow, which the one-time export wrote out under the same name.
export function cardWorkflowName(card: CalendarItem, read: ReadModel): string | null {
  if (card.workflowName) return card.workflowName;
  if (card.workflowId === null) return null;
  return read.workflow(card.workflowId)?.name ?? null;
}

// Whether the card has a workflow to start at all (a project is not needed, spec 27).
export const startsWork = (card: CalendarItem): boolean =>
  card.source === 'local' && (card.workflowName ?? card.workflowId ?? null) !== null;

// What the scheduler starts for one occurrence: the thread, made first when it is new, and the
// message that runs the workflow in it.
export interface CardThreadStart {
  readonly create?: Extract<ServerCommand, { type: 'thread.create' }>;
  readonly send: Extract<ServerCommand, { type: 'thread.sendMessage' }>;
  // What the occurrence records when making the thread or sending the message is refused all
  // the same: the card fails with the reason instead of the trigger being tried again.
  readonly refused: (reason: string) => DomainEvent[];
}

// What `cardThreadStart` answers; the trigger code adds what a refusal records.
export type CardThreadPlan = Omit<CardThreadStart, 'refused'>;

const sameThreadOf = (card: CalendarItem, read: ReadModel) =>
  card.threadMode === 'same' && card.threadId ? read.thread(card.threadId) : undefined;

// The card's `same` thread while it still works: the next occurrence is skipped (spec 28).
export function busyThreadOf(card: CalendarItem, read: ReadModel) {
  const thread = sameThreadOf(card, read);
  return thread && read.runningTurn(thread.id) ? thread : undefined;
}

// Instance, model, effort and permission mode for a new main thread (spec 2): the chat settings,
// then the project's defaults, then the instance's own.
function newThreadSettings(card: CalendarItem, read: ReadModel, context: DecideContext) {
  const project = card.projectId === null ? undefined : read.project(card.projectId);
  const instances = read.providerInstances();
  const named = settingValue('chat.defaultInstance', read, context);
  const instance =
    instances.find((each) => each.id === named) ??
    instances.find((each) => each.id === project?.defaultProviderInstanceId) ??
    instances.find((each) => each.status === 'ready') ??
    instances[0];
  if (!instance) throw new CommandRejected('rejected', 'No provider is set up to run the thread.');
  const settingModel = settingValue('chat.defaultModel', read, context);
  const fromProject = project?.defaultProviderInstanceId === instance.id ? project : undefined;
  const model =
    (named === instance.id && typeof settingModel === 'string' && settingModel.trim()) ||
    fromProject?.defaultModel ||
    instance.defaultModel;
  if (!model) {
    throw new CommandRejected(
      'rejected',
      `${instance.name} has no default model. Choose one in Settings › Chat (chat.defaultModel) or give ${instance.name} a default model in Settings › Providers.`,
    );
  }
  const options = providerChatOptions[instance.kind];
  return {
    instance,
    model,
    effort:
      fromProject?.defaultEffort || instance.defaultEffort || options.defaultEffort || 'default',
    permissionMode:
      fromProject?.defaultPermissionMode ||
      instance.defaultPermissionMode ||
      options.permissionModes[0]?.id ||
      'default',
  };
}

// The title of a thread a card starts: the card and the occurrence's day (spec 27).
const threadTitle = (card: CalendarItem, date: string | undefined): string =>
  date === undefined || card.threadMode === 'same' ? card.title : `${card.title} · ${date}`;

// What to start for an occurrence, or a refusal in words. `threadId` is the id a new thread gets.
export function cardThreadStart(
  card: CalendarItem,
  date: string | undefined,
  threadId: string,
  read: ReadModel,
  context: DecideContext,
): CardThreadPlan {
  const name = cardWorkflowName(card, read);
  if (name === null) throw new CommandRejected('rejected', `"${card.title}" has no workflow`);
  const project = card.projectId === null ? undefined : read.project(card.projectId);
  if (card.projectId !== null && !project) {
    throw new CommandRejected('rejected', `The project of "${card.title}" is gone`);
  }
  const same = sameThreadOf(card, read);
  if (same && !read.providerInstanceExists(same.providerInstanceId)) {
    throw new CommandRejected(
      'rejected',
      `The provider of the thread "${same.title || card.title}" is gone; make it New thread each time or start the thread again`,
    );
  }
  if (!same && !project && context.home === undefined) {
    throw new CommandRejected('rejected', 'A thread needs a project or a folder.');
  }
  // The workflow is looked up where the thread works: the same thread's project, else the card's.
  const threadProject = same
    ? same.projectId === null
      ? undefined
      : read.project(same.projectId)
    : project;
  const folder = threadProject ? path.join(threadProject.cwd, '.wow', 'workflows') : undefined;
  const workflow = read
    .skills()
    .find(
      (skill) =>
        isWorkflowSkill(skill) &&
        skill.name === name &&
        (skill.source === 'workflow' ||
          (folder !== undefined && path.resolve(skill.dir) === path.resolve(folder))),
    );
  if (!workflow) {
    throw new CommandRejected(
      'rejected',
      `No workflow named ${name} in wow's or the project's workflows`,
    );
  }
  // The card's notes, else its title, and the backlog item it was planned from, as a run had it.
  const item = card.backlogItemId === null ? undefined : read.backlogItem(card.backlogItemId);
  const text = [card.body?.trim() || card.title, item?.body.trim()].filter(Boolean).join('\n\n');
  const skills = [
    {
      name,
      source: workflow.source === 'project-workflow' ? 'project-workflow' : 'workflow',
    } as const,
  ];
  if (same) {
    return { send: { type: 'thread.sendMessage', threadId: same.id, text, skills } };
  }
  const settings = newThreadSettings(card, read, context);
  return {
    create: {
      type: 'thread.create',
      threadId,
      providerInstanceId: settings.instance.id,
      ...(project ? { projectId: project.id } : {}),
      title: threadTitle(card, date),
      model: settings.model,
      effort: settings.effort,
      permissionMode: settings.permissionMode,
    },
    send: { type: 'thread.sendMessage', threadId, text, skills },
  };
}

// The card's state from its thread (spec 28): `waiting` while a card in it waits for the user,
// `running` while it works, else how its last turn ended.
export function cardStateOfThread(threadId: string, read: ReadModel): CardState | undefined {
  const thread = read.thread(threadId);
  if (!thread) return undefined;
  if (thread.state === 'needs_you' || openGate(threadId, read)) return 'waiting';
  if (read.runningTurn(threadId)) return 'running';
  const last = read.lastTurn(threadId);
  if (!last) return 'running';
  if (last.state === 'completed') return 'done';
  if (last.state === 'failed') return 'failed';
  if (last.state === 'interrupted') return 'stopped';
  return 'running';
}

// A gate card in the thread whose approval or question nobody answered yet (spec 14).
function openGate(threadId: string, read: ReadModel): boolean {
  return read.threadItems(threadId).some((item) => {
    if (item.kind !== 'gate_card') return false;
    const payload = item.payload as { kind?: unknown; requestId?: unknown };
    if (typeof payload.requestId !== 'string') return false;
    if (payload.kind === 'approval') return read.approval(payload.requestId)?.decision === null;
    return read.question(payload.requestId)?.answer === null;
  });
}

// The card follows its thread; a card whose thread is gone keeps what it shows.
export function cardFollowsThread(
  card: CalendarItem,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  if (card.source !== 'local' || !card.threadId) return [];
  const state = cardStateOfThread(card.threadId, read);
  if (state === undefined || state === card.state) return [];
  return [
    ...backlogFollowsCard(card, state, read),
    {
      kind: 'card.stateChanged',
      aggregate: card.id,
      payload: {
        cardId: card.id,
        state,
        runId: card.runId,
        threadId: card.threadId,
        updatedAt: context.now,
      },
    },
  ];
}
