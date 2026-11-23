import { TextItemPayload, type BacklogItem, type Thread, type ThreadItem } from '@wow/contracts';

// `@` on another thread or a backlog item (chat overview spec 36): the pick puts a quoted block
// into the message, so the thread shows exactly what the agent gets. The named thread is not
// changed or told. Blocks longer than `chat.mentionMaxChars` are cut with a line saying so.

export const threadValue = (id: string) => `thread:${id}`;
export const backlogValue = (id: string) => `backlog:${id}`;

const matches = (title: string, query: string) =>
  query
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
    .every((word) => title.toLowerCase().includes(word));

// Other chat threads, newest first; never the thread itself, a step's or the Assistant's.
export function threadMatches(
  threads: readonly Thread[],
  query: string,
  self: string,
  max: number,
): Thread[] {
  return threads
    .filter(
      (thread) =>
        thread.id !== self &&
        thread.runId === null &&
        thread.kind !== 'assistant' &&
        matches(thread.title, query),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, max);
}

export const backlogMatches = (items: readonly BacklogItem[], query: string, max: number) =>
  items.filter((item) => item.state !== 'done' && matches(item.title, query)).slice(0, max);

// The thread's last answer of its own agent (not a subagent's).
export function lastAnswer(items: readonly ThreadItem[]): string | undefined {
  for (const item of items.toReversed()) {
    if (item.kind !== 'assistant_text') continue;
    const parsed = TextItemPayload.safeParse(item.payload);
    if (parsed.success && parsed.data.parentItemId === undefined && parsed.data.text.trim() !== '')
      return parsed.data.text;
  }
  return undefined;
}

function block(head: string, body: string, maxChars: number): string {
  const cut = body.length > maxChars;
  const text = cut
    ? `${body.slice(0, maxChars)}\n[Cut here: the rest is longer than wow puts in a message.]`
    : body;
  const longest = Math.max(2, ...[...text.matchAll(/`+/gu)].map((run) => run[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${head}\n${text}\n${fence}`;
}

export function threadBlock(
  thread: Pick<Thread, 'title'>,
  project: string | undefined,
  answer: string | undefined,
  maxChars: number,
): string {
  const facts = [`Thread: ${thread.title}`, ...(project ? [`Project: ${project}`] : [])];
  return block(
    'thread',
    `${facts.join('\n')}\n\n${answer ?? '(The thread has no answer yet.)'}`,
    maxChars,
  );
}

export function backlogBlock(item: BacklogItem, maxChars: number): string {
  const facts = [
    `Backlog item: ${item.title}`,
    `State: ${item.state}`,
    ...(item.tags.length > 0 ? [`Tags: ${item.tags.join(', ')}`] : []),
  ];
  return block(
    'backlog',
    `${facts.join('\n')}${item.body.trim() === '' ? '' : `\n\n${item.body}`}`,
    maxChars,
  );
}
