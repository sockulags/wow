import {
  branchName,
  helperDepth,
  helperPermissionMode,
  helperTree,
  sameBranchName,
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

const depthOf = (thread: Thread, read: ReadModel) =>
  helperDepth(thread.id, (id) => read.thread(id)?.parentThreadId);

// The main thread a thread belongs to: itself, or the top of its helper chain.
function mainOf(thread: Thread, read: ReadModel): Thread {
  let top = thread;
  const seen = new Set([thread.id]);
  for (let up = read.thread(top.parentThreadId ?? ''); up && !seen.has(up.id);) {
    seen.add(up.id);
    top = up;
    up = read.thread(top.parentThreadId ?? '');
  }
  return top;
}

// The thread whose agent called the helper tools: a chat thread of the user's or a helper (spec
// 4). A step's thread has none.
function startingThread(parentThreadId: string, read: ReadModel): Thread {
  const parent = read.thread(parentThreadId);
  if (!parent || parent.kind === 'assistant') {
    throw new CommandRejected('not_found', `There is no thread ${parentThreadId}.`);
  }
  if (parent.runId !== null) {
    throw new CommandRejected(
      'rejected',
      "A workflow step's thread cannot start helpers of its own.",
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
  const parent = startingThread(command.parentThreadId, read);
  switch (command.type) {
    case 'helper.start': {
      const deepest = settingValue('chat.helperDepth', read, context);
      const depth = depthOf(parent, read);
      if (typeof deepest === 'number' && depth >= deepest) {
        throw new CommandRejected(
          'rejected',
          `This thread is a helper ${depth} level${depth === 1 ? '' : 's'} down, the deepest a helper may start helpers from (chat.helperDepth). Do the work yourself.`,
        );
      }
      const perTree = settingValue('chat.helpersPerTree', read, context);
      const main = mainOf(parent, read);
      const inTree = helperTree(main.id, (id) => read.helperThreads(id)).filter(({ thread }) =>
        working(thread, read),
      ).length;
      if (typeof perTree === 'number' && inTree >= perTree) {
        throw new CommandRejected(
          'rejected',
          `${inTree} helpers are working under the main thread "${main.title}", the most at once (chat.helpersPerTree). Wait for one to finish.`,
        );
      }
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
      const folder = command.folder ?? parent.cwd;
      // A copy is made from the main worktree of the repository that holds the folder, which the
      // helper tools found (spec 5), on a helper's branch.
      const copyFrom = copy ? command.folder : undefined;
      if (copy && copyFrom === undefined) {
        throw new CommandRejected(
          'rejected',
          'A helper gets its own working copy of a Git repository; name its folder.',
        );
      }
      let branch: string | undefined;
      if (copyFrom !== undefined) {
        const template = settingValue('chat.helperBranch', read, context);
        const taken = read
          .helperThreads()
          .map((thread) => thread.branch)
          .filter((each): each is string => each !== null);
        // Ids differ, so names differ; this only matters when six characters of two ids agree.
        for (let length = 6; length <= 16; length += 2) {
          branch = branchName(
            typeof template === 'string' ? template : 'wow/helper/{{id}}',
            command.title,
            command.threadId,
            length,
          );
          if (!taken.some((other) => sameBranchName(other, branch ?? ''))) break;
        }
      }
      yield decide(
        {
          type: 'thread.create',
          threadId: command.threadId,
          providerInstanceId: instance.id,
          ...(parent.projectId === null ? {} : { projectId: parent.projectId }),
          // The folder it works in: the starting thread's own (its working copy when it has
          // one) or the one it named. For a copy, the folder it is made from.
          cwd: folder,
          ...(copyFrom === undefined ? {} : { copyFrom }),
          ...(branch === undefined ? {} : { branch }),
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
export function* decideHelperFollow(
  command: Extract<ServerCommand, { type: 'helper.followed' }>,
  read: ReadModel,
  context: DecideContext,
): Generator<DomainEvent[], void> {
  const helper = read.thread(command.threadId);
  if (!helper || helper.startedBy !== 'helper' || !helper.parentThreadId) return;
  const parent = read.thread(helper.parentThreadId);
  if (!parent) return;
  // A question or an approval for the user is drawn in the main thread first (spec 14), so the
  // message to the parent below reads the main thread's items as they are then.
  if (command.reason !== 'turnEnded') yield gateCard(command, helper, parent, read, context);
  // An approval is the user's alone (spec 17): the parent's agent is not asked.
  if (command.reason === 'approval') return;
  yield followMessage(command, helper, parent, read, context);
}

// The card in the main thread for a helper's approval or question (spec 14), once per request,
// on the main thread's last turn.
function gateCard(
  command: Extract<ServerCommand, { type: 'helper.followed' }>,
  helper: Thread,
  parent: Thread,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const request =
    command.reason === 'approval'
      ? command.approvalId === undefined
        ? undefined
        : read.approval(command.approvalId)
      : command.questionId === undefined
        ? undefined
        : read.question(command.questionId);
  if (!request || request.threadId !== helper.id) return [];
  const answered = 'decision' in request ? request.decision !== null : request.answer !== null;
  if (answered) return [];
  const main = mainOf(helper, read);
  const turn = read.lastTurn(main.id);
  if (!turn || main.id === helper.id) return [];
  const id = `${turn.id}:gate:${request.id}`;
  if (read.threadItems(main.id).some((item) => item.id === id)) return [];
  const instance = read.providerInstance(helper.providerInstanceId);
  return [
    {
      kind: 'threadItem.added',
      aggregate: main.id,
      payload: {
        id,
        threadId: main.id,
        turnId: turn.id,
        index: read.nextItemIndex(main.id),
        kind: 'gate_card',
        payload: {
          fromThreadId: helper.id,
          kind: command.reason === 'approval' ? 'approval' : 'question',
          requestId: request.id,
          itemId: request.itemId,
          title: helper.title,
          instanceName: instance?.name ?? helper.providerInstanceId,
          providerKind: instance?.kind ?? 'claude',
          depth: depthOf(helper, read),
          ...(parent.id === main.id ? {} : { parentTitle: parent.title }),
          at: context.now,
        },
        streaming: false,
      },
    },
  ];
}

function followMessage(
  command: Extract<ServerCommand, { type: 'helper.followed' }>,
  helper: Thread,
  parent: Thread,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
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
