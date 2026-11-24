import type { ThreadListStatus } from '@wow/contracts';

// The thread list's status of each main thread, read from its whole tree (orchestrator threads
// spec 31). A thread waits for the user when it needs the user itself or holds a gate card nobody
// answered (spec 14 draws every approval and question for the user from any depth there); it works
// when it or a helper anywhere under it works; it is unread when a turn ended since the user last
// looked; else it is done.

interface TreeRow {
  readonly id: string;
  readonly parentThreadId?: string | null;
  readonly state: string;
  readonly seen?: boolean | null;
}

export function threadListStatuses(
  threads: readonly TreeRow[],
  // Main threads that hold a gate card whose approval or question is still open.
  openGates: ReadonlySet<string>,
): Map<string, ThreadListStatus> {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const mainOf = (thread: TreeRow): TreeRow => {
    let at = thread;
    // Bounded by the number of threads, so a broken parent link cannot loop.
    for (let hops = 0; hops < threads.length; hops += 1) {
      const parent = at.parentThreadId ? byId.get(at.parentThreadId) : undefined;
      if (!parent) return at;
      at = parent;
    }
    return at;
  };
  const working = new Set<string>();
  const waiting = new Set<string>(openGates);
  for (const thread of threads) {
    const main = mainOf(thread);
    if (thread.state === 'working') working.add(main.id);
    if (thread.id === main.id && thread.state === 'needs_you') waiting.add(main.id);
  }
  const statuses = new Map<string, ThreadListStatus>();
  for (const thread of threads) {
    if (thread.parentThreadId) continue;
    statuses.set(
      thread.id,
      waiting.has(thread.id)
        ? 'waits_for_you'
        : working.has(thread.id)
          ? 'working'
          : thread.seen === false
            ? 'unread'
            : 'done',
    );
  }
  return statuses;
}
