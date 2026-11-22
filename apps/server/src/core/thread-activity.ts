import {
  TextItemPayload,
  ToolCallItemPayload,
  settingsRegistry,
  type ThreadActivity,
} from '@wow/contracts';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/database.js';
import * as t from '../db/schema.js';

// What each thread at work does now (parallel threads spec 11, 12): the threads that work, need
// the user or ended a turn not yet seen, with the facts of their last turn. Read from the stored
// rows on each change, so every window shows the same and nothing is kept in memory.

// The global value of `chat.activityTextMaxLength`, as the settings table holds it.
function textMaxLength(db: Db): number {
  const stored = db
    .select({ value: t.settings.value })
    .from(t.settings)
    .where(and(eq(t.settings.key, 'chat.activityTextMaxLength'), eq(t.settings.scope, 'global')))
    .get()?.value;
  const parsed = settingsRegistry['chat.activityTextMaxLength'].schema.safeParse(stored);
  return parsed.success ? parsed.data : settingsRegistry['chat.activityTextMaxLength'].default;
}

// The last line with words of an answer, cut at `max` characters.
function lastLine(text: string, max: number): string | null {
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .findLast((part) => part !== '');
  if (line === undefined) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function threadActivityRows(db: Db): ThreadActivity[] {
  const atWork = db
    .select()
    .from(t.threads)
    .all()
    .filter(
      (thread) =>
        thread.kind !== 'assistant' &&
        thread.archived !== true &&
        (thread.state === 'working' || thread.state === 'needs_you' || thread.seen === false),
    );
  if (atWork.length === 0) return [];
  const ids = atWork.map((thread) => thread.id);
  const lastTurns = new Map<string, typeof t.turns.$inferSelect>();
  for (const turn of db
    .select()
    .from(t.turns)
    .where(inArray(t.turns.threadId, ids))
    .orderBy(asc(t.turns.index))
    .all()) {
    // An exchange Edit replaced is not the thread's last word.
    if (turn.replacedBy === null) lastTurns.set(turn.threadId, turn);
  }
  const turnIds = [...lastTurns.values()].map((turn) => turn.id);
  const items =
    turnIds.length === 0
      ? []
      : db
          .select()
          .from(t.threadItems)
          .where(inArray(t.threadItems.turnId, turnIds))
          .orderBy(desc(t.threadItems.index))
          .all();
  const max = textMaxLength(db);
  return atWork.map((thread): ThreadActivity => {
    const turn = lastTurns.get(thread.id);
    const own = turn ? items.filter((item) => item.turnId === turn.id) : [];
    const calls = own.flatMap((item) => {
      if (item.kind !== 'tool_call') return [];
      const parsed = ToolCallItemPayload.safeParse(item.payload);
      return parsed.success ? [parsed.data] : [];
    });
    // Newest first, so the first running call is the one that runs now.
    const runningTool =
      turn?.state === 'running' ? (calls.find((call) => call.status === 'running') ?? null) : null;
    const answer = own.find((item) => item.kind === 'assistant_text');
    const text = TextItemPayload.safeParse(answer?.payload);
    return {
      threadId: thread.id,
      turnId: turn?.id ?? null,
      turnState: turn?.state ?? null,
      startedAt: turn?.startedAt ?? null,
      endedAt: turn?.endedAt ?? null,
      toolCalls: calls.length,
      runningTool,
      lastText: text.success ? lastLine(text.data.text, max) : null,
    };
  });
}

// The topics the activity is read from; a change to any of them changes it.
export const activitySources = new Set(['threads', 'turns', 'threadItems', 'settings'] as const);
