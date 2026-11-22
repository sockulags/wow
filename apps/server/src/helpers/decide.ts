import {
  helperPermissionMode,
  type DomainEvent,
  type ServerCommand,
  type Thread,
} from '@wow/contracts';
import {
  CommandRejected,
  decide,
  type DecideContext,
  type ReadModel,
} from '../core/orchestrator.js';
import { settingValue } from '../assistant/permissions.js';

// Helper threads (agent orchestration spec 2 to 8), decided in steps like the assistant's
// delegation: the helper is made with the user's own `thread.create` and gets its brief with
// `thread.sendMessage`, so it is an ordinary chat thread from then on. Only wow's helper tools
// send these, with the `helper` origin, for the main thread whose token called them.

export type HelperCommand = Extract<
  ServerCommand,
  { type: 'helper.start' | 'helper.write' | 'helper.stop' | 'helper.answer' }
>;

// Working: its turn runs, or it is between a message and its turn.
const working = (thread: Thread, read: ReadModel) =>
  thread.state === 'working' || read.runningTurn(thread.id) !== undefined;

function mainThread(parentThreadId: string, read: ReadModel): Thread {
  const parent = read.thread(parentThreadId);
  if (!parent || parent.kind === 'assistant') {
    throw new CommandRejected('not_found', `There is no thread ${parentThreadId}.`);
  }
  if (parent.runId !== null || parent.startedBy === 'helper') {
    throw new CommandRejected(
      'rejected',
      "A workflow step's thread and a helper cannot start helpers of their own.",
    );
  }
  return parent;
}

function helperOf(threadId: string, parent: Thread, read: ReadModel): Thread {
  const helper = read.thread(threadId);
  if (!helper || helper.parentThreadId !== parent.id) {
    throw new CommandRejected('not_found', `This thread has no helper ${threadId}.`);
  }
  return helper;
}

export function* decideHelper(
  command: HelperCommand,
  read: ReadModel,
  context: DecideContext,
): Generator<DomainEvent[], void> {
  const asUser: DecideContext = { ...context, origin: 'user' };
  const parent = mainThread(command.parentThreadId, read);
  switch (command.type) {
    case 'helper.start': {
      const perThread = settingValue('chat.helpersPerThread', read, context);
      const mine = read.helperThreads(parent.id).filter((thread) => working(thread, read)).length;
      if (typeof perThread === 'number' && mine >= perThread) {
        throw new CommandRejected(
          'rejected',
          `${mine} of your helpers are working, the most one thread may have at once (chat.helpersPerThread). Wait for one to finish, or stop one.`,
        );
      }
      const inAll = settingValue('chat.helpersLive', read, context);
      const live = read.helperThreads().filter((thread) => working(thread, read)).length;
      if (typeof inAll === 'number' && live >= inAll) {
        throw new CommandRejected(
          'rejected',
          `${live} helpers are working across all threads, the most at once (chat.helpersLive). Wait for one to finish.`,
        );
      }
      const own = read.providerInstance(parent.providerInstanceId);
      const instance =
        command.providerInstanceId === undefined
          ? own
          : read.providerInstance(command.providerInstanceId);
      if (!instance || !own) {
        throw new CommandRejected(
          'not_found',
          `There is no provider instance ${command.providerInstanceId ?? parent.providerInstanceId}. list_helpers names the connected ones.`,
        );
      }
      if (instance.status !== 'ready') {
        throw new CommandRejected(
          'rejected',
          `${instance.name} is not connected (its last test did not pass), so no helper starts on it.`,
        );
      }
      const same = instance.id === parent.providerInstanceId;
      const model = command.model ?? (same ? parent.model : instance.defaultModel);
      const effort = command.effort ?? (same ? parent.effort : instance.defaultEffort);
      if (!model || !effort) {
        throw new CommandRejected(
          'rejected',
          `${instance.name} has no default model or effort; name them in start_helper.`,
        );
      }
      const copy = command.isolation === 'copy';
      if (copy && parent.projectId === null) {
        throw new CommandRejected(
          'rejected',
          'A helper gets its own working copy only in a project; this thread has none. Start it in this folder instead.',
        );
      }
      const project = parent.projectId === null ? undefined : read.project(parent.projectId);
      yield decide(
        {
          type: 'thread.create',
          threadId: command.threadId,
          providerInstanceId: instance.id,
          ...(parent.projectId === null ? {} : { projectId: parent.projectId }),
          // The main thread's own folder (its working copy when it has one), or the project's,
          // from which the helper's own copy is made.
          cwd: copy && project ? project.cwd : parent.cwd,
          title: command.title,
          model,
          effort,
          permissionMode: helperPermissionMode(
            { kind: own.kind, mode: parent.permissionMode },
            instance.kind,
          ),
          ...(copy ? { ownWorkingCopy: true } : {}),
        },
        read,
        asUser,
      );
      yield [
        {
          kind: 'thread.helperStarted',
          aggregate: command.threadId,
          payload: { threadId: command.threadId, parentThreadId: parent.id, at: context.now },
        },
      ];
      // The row in the main thread, on the turn that started it (spec 10).
      const last = read.lastTurn(parent.id);
      if (last) {
        const index = read.nextItemIndex(parent.id);
        yield [
          {
            kind: 'threadItem.added',
            aggregate: parent.id,
            payload: {
              id: `${last.id}:helper:${command.threadId}`,
              threadId: parent.id,
              turnId: last.id,
              index,
              kind: 'helper_started',
              payload: {
                helperThreadId: command.threadId,
                title: command.title,
                instanceName: instance.name,
                providerKind: instance.kind,
                isolation: command.isolation,
                at: context.now,
              },
              streaming: false,
            },
          },
        ];
      }
      yield decide(
        { type: 'thread.sendMessage', threadId: command.threadId, text: command.brief },
        read,
        asUser,
      );
      return;
    }
    case 'helper.write': {
      const helper = helperOf(command.threadId, parent, read);
      yield decide(
        { type: 'thread.sendMessage', threadId: helper.id, text: command.text },
        read,
        asUser,
      );
      return;
    }
    case 'helper.answer': {
      const helper = helperOf(command.threadId, parent, read);
      const question = read.question(command.questionId);
      if (!question || question.threadId !== helper.id) {
        throw new CommandRejected(
          'not_found',
          `"${helper.title}" has no question ${command.questionId}.`,
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
      return;
    }
    case 'helper.stop': {
      const helper = helperOf(command.threadId, parent, read);
      if (read.runningTurn(helper.id) === undefined) {
        throw new CommandRejected('rejected', `"${helper.title}" is not working.`);
      }
      yield decide({ type: 'thread.interrupt', threadId: helper.id }, read, asUser);
      return;
    }
  }
}

// What the main thread's agent is told when its helper ends a turn or asks (spec 3), as a message
// from wow. A stopped turn tells nothing, so stopping a main thread does not start it again.
export function decideHelperFollow(
  command: Extract<ServerCommand, { type: 'helper.followed' }>,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const helper = read.thread(command.threadId);
  if (!helper || helper.startedBy !== 'helper' || !helper.parentThreadId) return [];
  const parent = read.thread(helper.parentThreadId);
  if (!parent) return [];
  const instance = read.providerInstance(helper.providerInstanceId);
  const who = `your helper "${helper.title}" (id ${helper.id}, on ${instance?.name ?? 'its instance'})`;
  let text: string;
  if (command.reason === 'question') {
    const question = command.questionId ? read.question(command.questionId) : undefined;
    if (!question || question.answer !== null) return [];
    text = `From wow: ${who} asks a question (id ${question.id}): ${JSON.stringify(question.request)}\nAnswer it with answer_helper_question if what you know settles it; otherwise tell the person it waits for them.`;
  } else {
    const turn = read.lastTurn(helper.id);
    if (!turn || turn.state === 'running' || turn.state === 'interrupted') return [];
    if (turn.state === 'failed') {
      const error = read
        .threadItems(helper.id)
        .findLast((item) => item.turnId === turn.id && item.kind === 'error');
      const message =
        error &&
        typeof error.payload === 'object' &&
        error.payload !== null &&
        'message' in error.payload
          ? String(error.payload.message)
          : 'no reason was given';
      text = `From wow: ${who} failed: ${message}\nRead it with read_helper, write to it to go on, or do the work yourself.`;
    } else {
      const max = settingValue('chat.helperAnswerMaxLength', read, context);
      const limit = typeof max === 'number' ? max : 20_000;
      const answer = read
        .threadItems(helper.id)
        .filter((item) => item.turnId === turn.id && item.kind === 'assistant_text')
        .map((item) =>
          typeof item.payload === 'object' && item.payload !== null && 'text' in item.payload
            ? String(item.payload.text)
            : '',
        )
        .join('\n\n')
        .trim();
      const shown =
        answer.length > limit
          ? `${answer.slice(0, limit)}\n[Cut at ${limit} characters; read_helper has the rest.]`
          : answer;
      text = `From wow: ${who} ended its turn.${shown === '' ? ' It said nothing.' : ` Its answer:\n\n${shown}`}`;
    }
  }
  return decide({ type: 'thread.sendMessage', threadId: parent.id, text }, read, {
    ...context,
    origin: 'user',
  });
}
