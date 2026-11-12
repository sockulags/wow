import {
  providerChatOptions,
  type CopiedTurn,
  type DomainEvent,
  type ForkOrigin,
  type GoBack,
  type ResumePointRef,
  type Thread,
  type ThreadItem,
  type Turn,
} from '@wow/contracts';
import { CommandRejected, type ReadModel } from './orchestrator.js';

// Edit and Fork (agent workbench spec 62, 63, 71): both go back in the provider's conversation to
// the point it gave after a turn, and neither touches files. Edit goes on in the same thread from
// before its last message; Fork starts a new thread with the conversation up to a message.

type StoredTurn = Turn & { readonly resumePoint: ResumePointRef | null };

// The conversation as it goes on: a turn Edit replaced is only an earlier version.
const shownTurns = (turns: readonly StoredTurn[]) => turns.filter((turn) => !turn.replacedBy);

const userItemId = (turn: Turn) => `${turn.id}:user`;

// Only a chat thread on a provider that can go back offers Edit and Fork.
function checkGoesBack(read: ReadModel, thread: Thread, action: 'edited' | 'forked'): void {
  if (thread.kind === 'assistant' || thread.runId !== null) {
    throw new CommandRejected('rejected', `Only a chat thread's messages can be ${action}.`);
  }
  const kind = read.providerInstance(thread.providerInstanceId)?.kind;
  if (!kind) {
    throw new CommandRejected('not_found', `No provider instance ${thread.providerInstanceId}`);
  }
  const reason = providerChatOptions[kind].cannotGoBack;
  if (reason !== null) throw new CommandRejected('rejected', reason);
}

// Where Edit of the message `turnId` starts goes back to: the point after the exchange before
// it, or a new conversation when it is the first. A point in another session than the thread's
// own (the origin of a fork) is left as it is and forked.
export function editGoBack(read: ReadModel, thread: Thread, turnId: string): GoBack {
  checkGoesBack(read, thread, 'edited');
  if (read.runningTurn(thread.id)) {
    throw new CommandRejected(
      'conflict',
      'A turn runs in this thread; stop it or let it end first.',
    );
  }
  const shown = shownTurns(read.threadTurns(thread.id));
  const last = shown.at(-1);
  if (!last || last.id !== turnId || !read.itemExists(userItemId(last))) {
    throw new CommandRejected('conflict', 'Only the last message of the thread can be edited.');
  }
  const before = shown.at(-2);
  if (!before) return { resumeId: null, at: null, fork: false };
  const point = before.resumePoint;
  if (!point) {
    throw new CommandRejected(
      'rejected',
      'The message before this one was answered before wow kept the place in the conversation, so this message cannot be edited.',
    );
  }
  return {
    resumeId: point.sessionId,
    at: point.at,
    fork: point.sessionId !== thread.providerSessionId,
  };
}

// The id an item of the origin gets in the fork: under the new turn's id where it was under the
// old one, so a subagent's work still names its call.
function copiedId(id: string, from: ReadonlyMap<string, string>): string {
  for (const [oldTurn, newTurn] of from) {
    if (id.startsWith(`${oldTurn}:`)) return `${newTurn}${id.slice(oldTurn.length)}`;
  }
  return id;
}

// Approvals and questions were answered in the origin and have their rows there; the fork shows
// the exchange, not those cards.
const copiedKinds = new Set<ThreadItem['kind']>(['approval', 'question']);

function copiedItem(
  item: ThreadItem,
  threadId: string,
  index: number,
  turns: ReadonlyMap<string, string>,
): ThreadItem {
  const payload =
    typeof item.payload === 'object' && item.payload !== null && 'parentItemId' in item.payload
      ? {
          ...item.payload,
          parentItemId: copiedId(String(item.payload.parentItemId), turns),
        }
      : item.payload;
  return {
    ...item,
    id: copiedId(item.id, turns),
    threadId,
    turnId: turns.get(item.turnId) ?? item.turnId,
    index,
    payload,
    streaming: false,
  };
}

const turnIdOf = (threadId: string, index: number) => `${threadId}:turn:${index}`;

// "Fork from here": the new thread, its copied conversation, and the point its first message
// forks the provider's conversation from.
export function forkEvents(
  read: ReadModel,
  threadId: string,
  from: ForkOrigin,
  title: string | undefined,
  now: string,
): DomainEvent[] {
  const origin = read.thread(from.threadId);
  if (!origin) throw new CommandRejected('not_found', `No thread ${from.threadId}`);
  checkGoesBack(read, origin, 'forked');
  const shown = shownTurns(read.threadTurns(origin.id));
  const at = shown.findIndex((turn) => turn.id === from.turnId);
  const target = shown[at];
  if (!target || !read.itemExists(userItemId(target))) {
    throw new CommandRejected('not_found', 'That message is not in the conversation any more.');
  }
  if (target.state === 'running') {
    throw new CommandRejected(
      'conflict',
      'This message is still being answered; fork it once it ends.',
    );
  }
  const point = target.resumePoint;
  if (!point) {
    throw new CommandRejected(
      'rejected',
      'This message was answered before wow kept the place in the conversation, so it cannot be forked.',
    );
  }
  const kept = shown.slice(0, at + 1);
  const ids = new Map(kept.map((turn, index) => [turn.id, turnIdOf(threadId, index)]));
  const turns: CopiedTurn[] = kept.map((turn, index) => ({
    id: turnIdOf(threadId, index),
    threadId,
    index,
    state: turn.state,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    usage: turn.usage,
    resumePoint: turn.resumePoint,
  }));
  const items = read
    .threadItems(origin.id)
    .filter((item) => ids.has(item.turnId) && !copiedKinds.has(item.kind))
    .map((item, index) => copiedItem(item, threadId, index, ids));
  const originTitle = origin.title.trim() === '' ? 'New thread' : origin.title;
  return [
    {
      kind: 'thread.created',
      aggregate: threadId,
      payload: {
        id: threadId,
        projectId: origin.projectId,
        cwd: origin.cwd,
        branch: origin.branch,
        providerInstanceId: origin.providerInstanceId,
        providerSessionId: null,
        title: title !== undefined && title.trim() !== '' ? title : `${originTitle} (fork)`,
        model: origin.model,
        effort: origin.effort,
        permissionMode: origin.permissionMode,
        state: 'idle',
        pinned: false,
        runId: null,
        stepId: null,
        goBack: { resumeId: point.sessionId, at: point.at, fork: true },
        forkedFrom: { threadId: origin.id, turnId: target.id },
        createdAt: now,
        updatedAt: now,
      },
    },
    { kind: 'thread.historyCopied', aggregate: threadId, payload: { threadId, turns, items } },
  ];
}
