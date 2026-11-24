import type { Thread, ThreadListStatus } from '@wow/contracts';

// The thread list (orchestrator threads spec 30 to 32): main threads only, by status in the order
// Waits for you, Working, Unread, Done, pinned threads first within a status, then the newest
// activity. The status is the server's, read from the thread's whole tree; a row without one
// (a server from before) falls back to the thread's own state.

export const listStatusOrder: readonly ThreadListStatus[] = [
  'waits_for_you',
  'working',
  'unread',
  'done',
];

export const listStatusTitles: Readonly<Record<ThreadListStatus, string>> = {
  waits_for_you: 'Waits for you',
  working: 'Working',
  unread: 'Unread',
  done: 'Done',
};

export const isMainThread = (thread: Pick<Thread, 'parentThreadId'>): boolean =>
  !thread.parentThreadId;

export function listStatusOf(thread: Thread): ThreadListStatus {
  if (thread.listStatus) return thread.listStatus;
  if (thread.state === 'needs_you') return 'waits_for_you';
  if (thread.state === 'working') return 'working';
  return thread.seen === false ? 'unread' : 'done';
}

const rank = (thread: Thread) => listStatusOrder.indexOf(listStatusOf(thread));

export const threadListOrder = (threads: readonly Thread[]): Thread[] =>
  threads
    .filter(isMainThread)
    .toSorted(
      (a, b) =>
        rank(a) - rank(b) ||
        Number(b.pinned) - Number(a.pinned) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
