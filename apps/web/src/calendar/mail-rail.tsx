import type { MailItem } from '@wow/contracts';
import { MailIcon } from 'lucide-react';
import { useState } from 'react';
import { useRuntime } from '@/app/runtime';
import { errorMessage } from '@/chat/data';
import { formatTime, isoDate, localDate } from './time';

// Unread mail from the configured folders, newest first (spec 4). Clicking an entry asks Outlook
// to open it; nothing is marked read or changed from here.
export function MailRail({
  mail,
  unreadCount,
  zone,
}: {
  mail: readonly MailItem[];
  unreadCount: number;
  zone: string;
}) {
  const { connection } = useRuntime();
  const [error, setError] = useState<string>();
  // What the last click opened, as Outlook confirmed it.
  const [opened, setOpened] = useState<string>();
  const today = isoDate(localDate(new Date(), zone));
  const open = (entry: MailItem) => {
    if (!connection) return;
    setError(undefined);
    setOpened(undefined);
    connection.request('outlook.open', { entryId: entry.externalId }).then(
      () => setOpened(entry.subject),
      (caught: unknown) => setError(errorMessage(caught)),
    );
  };

  return (
    <aside
      aria-label="Unread mail"
      className="flex w-72 shrink-0 flex-col border-l border-border bg-sidebar/50"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 text-xs font-medium">
        <MailIcon className="size-3.5 text-muted-foreground" aria-hidden />
        Unread
        <span
          aria-label={`${unreadCount} unread`}
          className="ml-auto rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground"
        >
          {unreadCount}
        </span>
      </div>
      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {opened !== undefined && (
        <p role="status" className="truncate px-3 py-1.5 text-[11px] text-muted-foreground">
          Opened in Outlook: {opened}
        </p>
      )}
      <ul className="min-h-0 flex-1 overflow-y-auto p-1">
        {mail.length === 0 && (
          <li className="px-2 py-6 text-center text-xs text-muted-foreground">No unread mail.</li>
        )}
        {mail.map((entry) => {
          const received = new Date(entry.receivedAt);
          const sameDay = isoDate(localDate(received, zone)) === today;
          return (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => open(entry)}
                title={entry.snippet}
                className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent focus-visible:bg-sidebar-accent focus-visible:outline-none"
              >
                <span className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate font-medium">{entry.from}</span>
                  <time
                    dateTime={entry.receivedAt}
                    className="shrink-0 text-[11px] text-muted-foreground"
                  >
                    {sameDay ? formatTime(received, zone) : isoDate(localDate(received, zone))}
                  </time>
                </span>
                <span className="truncate text-xs">{entry.subject}</span>
                {entry.folder !== 'Inbox' && (
                  <span className="text-[11px] text-muted-foreground">{entry.folder}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
