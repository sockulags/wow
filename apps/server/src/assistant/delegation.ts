import {
  assistantPermissionLabels,
  assistantThreadId,
  type AssistantPermissionKind,
  type DomainEvent,
  type ServerCommand,
} from '@wow/contracts';
import {
  CommandRejected,
  decide,
  type DecideContext,
  type ReadModel,
} from '../core/orchestrator.js';
import { permitFor, settingValue } from './permissions.js';

// Delegated work (chief of staff spec 9 to 15): threads the assistant starts, writes in and
// answers for, and the turns it is given to follow them. Each is settled here by the standing
// permissions before anything else; without one it is refused with what to do instead. The
// thread commands themselves are decided as the user's, so a delegated thread is an ordinary
// chat thread in every other way.

type DelegationCommand = Extract<
  ServerCommand,
  { type: 'assistant.startThread' | 'assistant.sendToThread' | 'assistant.answerQuestion' }
>;

export const isDelegationCommand = (command: ServerCommand): command is DelegationCommand =>
  command.type === 'assistant.startThread' ||
  command.type === 'assistant.sendToThread' ||
  command.type === 'assistant.answerQuestion';

const usedEvent = (
  commandId: string,
  permission: { id: string; kind: AssistantPermissionKind },
  commandType: string,
  what: string,
  threadId: string,
  context: DecideContext,
): DomainEvent => ({
  kind: 'assistant.permissionUsed',
  aggregate: commandId,
  payload: {
    id: commandId,
    at: context.now,
    permissionId: permission.id,
    kind: permission.kind,
    commandType,
    what,
    place: { label: 'the thread', path: `/chat/${encodeURIComponent(threadId)}` },
  },
});

// Threads and runs the assistant started that are working now (spec 15).
export function delegatedLive(read: ReadModel): number {
  const threads = read
    .projects()
    .flatMap((project) => read.projectThreads(project.id))
    .filter(
      (thread) =>
        thread.startedBy === 'assistant' &&
        (thread.state === 'working' || read.runningTurn(thread.id) !== undefined),
    ).length;
  return threads;
}

function permitted(
  kind: 'startThreads' | 'driveThreads',
  projectId: string | null,
  read: ReadModel,
  context: DecideContext,
) {
  const label = assistantPermissionLabels[kind];
  if (projectId === null) {
    throw new CommandRejected('rejected', `${label} covers threads in a project only.`);
  }
  const cover = permitFor({ kind, projectId }, read, context);
  if (!cover) {
    throw new CommandRejected(
      'rejected',
      kind === 'startThreads'
        ? `No ${label} permission covers ${read.project(projectId)?.name ?? projectId}, or acting under permissions is off. Offer the thread with offer_project_work instead.`
        : `No ${label} permission covers this thread's project, or acting under permissions is off. Tell the person what you would write instead.`,
    );
  }
  if ('held' in cover) throw new CommandRejected('rejected', cover.held);
  return cover.covered;
}

function delegatedThread(threadId: string, read: ReadModel) {
  const thread = read.thread(threadId);
  if (!thread || thread.kind === 'assistant') {
    throw new CommandRejected('not_found', `There is no thread ${threadId}.`);
  }
  if (thread.startedBy !== 'assistant') {
    throw new CommandRejected(
      'rejected',
      'You write only in threads you started; this one is the person’s.',
    );
  }
  return thread;
}

export function* decideDelegation(
  commandId: string,
  command: DelegationCommand,
  read: ReadModel,
  context: DecideContext,
): Generator<DomainEvent[], void> {
  const asUser: DecideContext = { ...context, origin: 'user' };
  switch (command.type) {
    case 'assistant.startThread': {
      const permission = permitted('startThreads', command.projectId, read, context);
      const project = read.project(command.projectId);
      if (!project)
        throw new CommandRejected('not_found', `There is no project ${command.projectId}.`);
      const limit = settingValue('assistant.maxDelegatedLive', read, context);
      const live = delegatedLive(read);
      if (typeof limit === 'number' && live >= limit) {
        throw new CommandRejected(
          'rejected',
          `${live} threads you started are working, the most at once (assistant.maxDelegatedLive). Plan it for a free slot instead, or tell the person.`,
        );
      }
      const providerInstanceId =
        command.providerInstanceId ?? project.defaultProviderInstanceId ?? undefined;
      const instance = providerInstanceId ? read.providerInstance(providerInstanceId) : undefined;
      if (!instance) {
        throw new CommandRejected(
          'rejected',
          `${project.name} names no provider instance to start a thread on; give one from read_providers.`,
        );
      }
      const model = command.model ?? project.defaultModel ?? instance.defaultModel;
      const effort = command.effort ?? project.defaultEffort ?? instance.defaultEffort;
      // The permission's widest mode is the mode, so the thread never gets more than was given.
      const permissionMode =
        permission.maxPermissionMode ??
        project.defaultPermissionMode ??
        instance.defaultPermissionMode;
      if (!model || !effort || !permissionMode) {
        throw new CommandRejected(
          'rejected',
          `${instance.name} has no default model, effort or permission mode; give them.`,
        );
      }
      yield decide(
        {
          type: 'thread.create',
          threadId: command.threadId,
          providerInstanceId: instance.id,
          projectId: project.id,
          cwd: project.cwd,
          title: command.title,
          model,
          effort,
          permissionMode,
          ...(command.ownWorkingCopy ? { ownWorkingCopy: true } : {}),
        },
        read,
        asUser,
      );
      yield [
        {
          kind: 'thread.delegated',
          aggregate: command.threadId,
          payload: { threadId: command.threadId, at: context.now },
        },
      ];
      yield decide(
        { type: 'thread.sendMessage', threadId: command.threadId, text: command.message },
        read,
        asUser,
      );
      yield [
        usedEvent(
          commandId,
          permission,
          command.type,
          `Started "${command.title}" in ${project.name}`,
          command.threadId,
          context,
        ),
      ];
      return;
    }
    case 'assistant.sendToThread': {
      const thread = delegatedThread(command.threadId, read);
      const permission = permitted('driveThreads', thread.projectId, read, context);
      yield decide(
        { type: 'thread.sendMessage', threadId: thread.id, text: command.text },
        read,
        asUser,
      );
      yield [
        usedEvent(
          commandId,
          permission,
          command.type,
          `Wrote in "${thread.title}"`,
          thread.id,
          context,
        ),
      ];
      return;
    }
    case 'assistant.answerQuestion': {
      const thread = delegatedThread(command.threadId, read);
      const permission = permitted('driveThreads', thread.projectId, read, context);
      const question = read.question(command.questionId);
      if (!question || question.threadId !== thread.id) {
        throw new CommandRejected(
          'not_found',
          `"${thread.title}" has no question ${command.questionId}.`,
        );
      }
      if (question.answer !== null) {
        throw new CommandRejected('conflict', 'That question was already answered.');
      }
      yield decide(
        { type: 'question.answer', answers: [{ questionId: question.id, reply: command.reply }] },
        read,
        asUser,
      );
      yield [
        {
          kind: 'question.answeredByAssistant',
          aggregate: question.id,
          payload: { questionId: question.id, because: command.because },
        },
        usedEvent(
          commandId,
          permission,
          command.type,
          `Answered a question in "${thread.title}"`,
          thread.id,
          context,
        ),
      ];
      return;
    }
  }
}

const followText: Readonly<Record<'turnEnded' | 'question' | 'approval', string>> = {
  turnEnded: 'ended its turn',
  question: 'asks a question',
  approval: 'asks for an approval, which only the person gives',
};

// A turn for the assistant to look at a thread it started (spec 11 to 13), as a message from wow
// in its conversation; nothing once the thread has had `assistant.followTurns` of them.
export function decideFollow(
  command: Extract<ServerCommand, { type: 'assistant.follow' }>,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const thread = read.thread(command.threadId);
  if (!thread || thread.startedBy !== 'assistant') return [];
  if (!read.thread(assistantThreadId)) return [];
  const limit = settingValue('assistant.followTurns', read, context);
  if (typeof limit !== 'number' || (thread.followTurns ?? 0) >= limit) return [];
  const text = `From wow: "${thread.title}" (thread ${thread.id}), which you started, ${followText[command.reason]}. Read it with read_thread and report back${command.reason === 'approval' ? '' : ', or go on within what the person asked'}.`;
  return [
    {
      kind: 'thread.followed',
      aggregate: thread.id,
      payload: { threadId: thread.id, at: context.now },
    },
    ...decide({ type: 'thread.sendMessage', threadId: assistantThreadId, text }, read, {
      ...context,
      origin: 'user',
    }),
  ];
}
