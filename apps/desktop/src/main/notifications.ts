import type { AppNotification } from '@wow/contracts';

export interface Notice {
  readonly title: string;
  readonly body: string;
  // Where the window opens when the notification is clicked.
  readonly path: string;
}

export interface ChatNotice extends Notice {
  readonly id: string;
  // Set for a "Needs you" that waits on an approval: the notification offers Allow once and Deny.
  readonly approvalId: string | undefined;
}

// The chat threads' notifications the server stored since the previous snapshot of the
// notifications topic (agent workbench spec 64): the ones of a thread. The first snapshot only
// sets the baseline.
export function chatNotices(
  seen: ReadonlySet<string> | undefined,
  rows: readonly AppNotification[],
): ChatNotice[] {
  if (seen === undefined) return [];
  return rows
    .filter((row) => !seen.has(row.id) && row.threadId != null)
    .toReversed()
    .map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      path: row.path,
      approvalId: row.approvalId ?? undefined,
    }));
}

// The app's route a window at this address shows, for "that thread is on screen".
export const routeOf = (url: string, origin: string): string | undefined =>
  url.startsWith(`${origin}/`) ? new URL(url).pathname : undefined;
