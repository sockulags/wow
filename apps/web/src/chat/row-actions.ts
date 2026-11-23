import type { Command, Thread } from '@wow/contracts';
import { canMarkDone } from './model';
import { isArchived, isUnread } from './thread-commands';

// What a thread row offers on its menu and what several picked rows offer together (chat
// overview spec 13 to 16). Each action is the command the palette sends for one thread, offered
// or refused for the same reasons; a picked row that does not allow it is skipped and said why.

export type BulkAction = 'pin' | 'unpin' | 'done' | 'reopen' | 'archive' | 'unarchive';

export const bulkLabels: Readonly<Record<BulkAction, string>> = {
  pin: 'Pin',
  unpin: 'Unpin',
  done: 'Mark done',
  reopen: 'Reopen',
  archive: 'Archive',
  unarchive: 'Unarchive',
};

// Why a thread does not take the action, or undefined when it does.
export function refusal(thread: Thread, action: BulkAction): string | undefined {
  switch (action) {
    case 'pin':
      return thread.pinned ? 'is pinned already' : undefined;
    case 'unpin':
      return thread.pinned ? undefined : 'is not pinned';
    case 'done':
      if (thread.state === 'done') return 'is done already';
      if (thread.state === 'working') return 'is working';
      if (thread.state === 'needs_you') return 'waits for you';
      return canMarkDone(thread) ? undefined : 'cannot be marked done now';
    case 'reopen':
      return thread.state === 'done' ? undefined : 'is not done';
    case 'archive':
      if (isArchived(thread)) return 'is archived already';
      return thread.runId === null ? undefined : "is a workflow step's";
    case 'unarchive':
      return isArchived(thread) ? undefined : 'is not archived';
  }
}

export function commandFor(thread: Thread, action: BulkAction): Command {
  const threadId = thread.id;
  switch (action) {
    case 'pin':
    case 'unpin':
      return { type: 'thread.setPinned', threadId, pinned: action === 'pin' };
    case 'done':
    case 'reopen':
      return { type: 'thread.setDone', threadId, done: action === 'done' };
    case 'archive':
    case 'unarchive':
      return { type: 'thread.setArchived', threadId, archived: action === 'archive' };
  }
}

// The picked threads that take the action, and what the rest are skipped for, grouped by reason:
// "1 is working", "2 are pinned already".
export function splitPicked(
  threads: readonly Thread[],
  action: BulkAction,
): { readonly taken: Thread[]; readonly skipped: string | undefined } {
  const taken: Thread[] = [];
  const reasons = new Map<string, number>();
  for (const thread of threads) {
    const why = refusal(thread, action);
    if (why === undefined) taken.push(thread);
    else reasons.set(why, (reasons.get(why) ?? 0) + 1);
  }
  const skipped = [...reasons]
    .map(([why, count]) => `${count} ${count === 1 ? why : plural(why)}`)
    .join(', ');
  return { taken, skipped: skipped === '' ? undefined : skipped };
}

// "is working" → "are working"; "waits for you" → "wait for you".
const plural = (why: string): string =>
  why.startsWith('is ') ? `are ${why.slice(3)}` : why.replace(/^waits /, 'wait ');

// The actions offered on one row's menu, in the order the menu lists them.
export function rowMenuActions(thread: Thread): BulkAction[] {
  const order: readonly BulkAction[] = ['pin', 'unpin', 'done', 'reopen', 'archive', 'unarchive'];
  return order.filter((action) => refusal(thread, action) === undefined);
}

export const canMarkUnread = (thread: Thread): boolean => !isUnread(thread);
