import {
  TextItemPayload,
  ToolCallItemPayload,
  type Command,
  type SentImage,
  type Thread,
  type SkillRef,
  type ThreadItem,
  type Turn,
} from '@wow/contracts';
import type { EarlierExchange } from './items';

// Edit and Fork as the conversation shows them (agent workbench spec 62, 63, 71), read from the
// stored turns and items: which exchanges Edit replaced, which message Edit can replace and
// which messages a fork can start from. The server decides again when the command arrives.

export interface EditableMessage {
  readonly turnId: string;
  readonly itemId: string;
  readonly text: string;
  readonly skills: readonly SkillRef[];
  readonly files: readonly string[];
  readonly images: readonly SentImage[];
  // The turn changed files, which stay as they are (spec 63).
  readonly changedFiles: boolean;
}

export interface GoBackView {
  // Turns Edit replaced: their items show only as an earlier version.
  readonly replaced: ReadonlySet<string>;
  // Per turn, the exchanges it replaced, oldest first.
  readonly earlier: ReadonlyMap<string, readonly EarlierExchange[]>;
  readonly editable: EditableMessage | undefined;
  // User message item id -> its turn, for every message a fork can start from.
  readonly forkable: ReadonlyMap<string, string>;
}

const userItemId = (turnId: string) => `${turnId}:user`;

const ownText = (item: ThreadItem): string | undefined => {
  const parsed = TextItemPayload.safeParse(item.payload);
  return parsed.success && parsed.data.parentItemId === undefined ? parsed.data.text : undefined;
};

function exchangeOf(turnId: string, items: readonly ThreadItem[]): EarlierExchange {
  const own = items.filter((item) => item.turnId === turnId);
  const user = own.find((item) => item.id === userItemId(turnId));
  return {
    turnId,
    text: user ? (ownText(user) ?? '') : '',
    answers: own
      .filter((item) => item.kind === 'assistant_text')
      .flatMap((item) => ownText(item) ?? []),
    toolCalls: own.filter((item) => {
      if (item.kind !== 'tool_call') return false;
      const parsed = ToolCallItemPayload.safeParse(item.payload);
      return parsed.success && parsed.data.parentItemId === undefined;
    }).length,
  };
}

const changedFiles = (turnId: string, items: readonly ThreadItem[]) =>
  items.some((item) => {
    if (item.turnId !== turnId || item.kind !== 'tool_call') return false;
    const parsed = ToolCallItemPayload.safeParse(item.payload);
    return parsed.success && parsed.data.kind === 'edit' && parsed.data.status === 'ok';
  });

function editableOf(turn: Turn, items: readonly ThreadItem[]): EditableMessage | undefined {
  const item = items.find((candidate) => candidate.id === userItemId(turn.id));
  const parsed = item ? TextItemPayload.safeParse(item.payload) : undefined;
  if (!item || !parsed?.success || parsed.data.answers) return undefined;
  const skills = (parsed.data.skills ?? []).map((skill): SkillRef =>
    skill.source === 'wow' || skill.source === 'yours'
      ? { name: skill.name, source: skill.source }
      : { name: skill.name },
  );
  return {
    turnId: turn.id,
    itemId: item.id,
    text: parsed.data.text,
    skills,
    files: parsed.data.files ?? [],
    images: parsed.data.images ?? [],
    changedFiles: changedFiles(turn.id, items),
  };
}

export function goBackView(turns: readonly Turn[], items: readonly ThreadItem[]): GoBackView {
  const replaced = new Set(turns.flatMap((turn) => (turn.replacedBy ? [turn.id] : [])));
  const earlier = new Map<string, EarlierExchange[]>();
  for (const turn of turns) {
    if (!turn.replacedBy || replaced.has(turn.replacedBy)) continue;
    // The chain of edits that ends at a shown turn, oldest first.
    const chain: EarlierExchange[] = [];
    let current: string | undefined = turn.replacedBy;
    while (current !== undefined) {
      const before: Turn | undefined = turns.find((candidate) => candidate.replacedBy === current);
      if (!before) break;
      chain.unshift(exchangeOf(before.id, items));
      current = before.id;
    }
    earlier.set(turn.replacedBy, chain);
  }
  const shown = turns.filter((turn) => !replaced.has(turn.id));
  const has = (turn: Turn) => items.some((item) => item.id === userItemId(turn.id));
  const forkable = new Map(
    shown
      .filter((turn) => turn.state !== 'running' && turn.resumable === true && has(turn))
      .map((turn) => [userItemId(turn.id), turn.id]),
  );
  const last = shown.at(-1);
  const before = shown.at(-2);
  const editable =
    last &&
    last.state !== 'running' &&
    !turns.some((turn) => turn.state === 'running') &&
    (before === undefined || before.resumable === true)
      ? editableOf(last, items)
      : undefined;
  return { replaced, earlier, editable, forkable };
}

// "Fork from here" (spec 71): a new thread with the conversation up to the message and its
// answer, on the thread's own provider, folder and settings; the answer is the new thread's id.
export async function forkThread(
  send: (command: Command) => Promise<unknown>,
  thread: Thread,
  turnId: string,
): Promise<string> {
  const threadId = globalThis.crypto.randomUUID();
  await send({
    type: 'thread.create',
    threadId,
    providerInstanceId: thread.providerInstanceId,
    ...(thread.projectId === null ? {} : { projectId: thread.projectId }),
    cwd: thread.cwd,
    model: thread.model,
    effort: thread.effort,
    permissionMode: thread.permissionMode,
    forkFrom: { threadId: thread.id, turnId },
  });
  return threadId;
}

// A thread whose go-back failed keeps going back with every message (the provider wrote nothing,
// so there is no new point); while its last turn failed it is offered the way out.
export function stopGoingBack(
  thread: Pick<Thread, 'id' | 'goBack' | 'providerSessionId'>,
  lastFailed: boolean,
  send: (command: Command) => Promise<unknown>,
):
  | { readonly title: string; readonly detail: string; readonly run: () => Promise<unknown> }
  | undefined {
  if (!thread.goBack || !lastFailed) return undefined;
  const run = () => send({ type: 'thread.dropGoBack', threadId: thread.id });
  return thread.providerSessionId === null
    ? {
        title: 'Start a new conversation',
        detail:
          'The conversation this thread came from could not be picked up. Your next message starts a new one; the messages above stay here.',
        run,
      }
    : {
        title: 'Go on without going back',
        detail:
          'Going back in the conversation failed. Your next message goes on from the conversation as the agent has it, the replaced exchange included.',
        run,
      };
}
