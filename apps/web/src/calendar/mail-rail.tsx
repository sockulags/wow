import type { MailItem, OutlookStatus } from '@wow/contracts';
import { MailIcon, PanelRightCloseIcon, PanelRightOpenIcon } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { useRuntime } from '@/app/runtime';
import { useTopicState } from '@/app/topic-state';
import { errorMessage } from '@/chat/data';
import { IconButton, WithTooltip } from '@/components/hint';
import { EmptyState, Stale, TopicPlaceholder } from '@/components/states';
import { Button } from '@/components/ui/button';
import { notify } from '@/lib/feedback';
import { formatWhen } from '@/lib/format';

// Unread mail from the configured folders, newest first (spec 4). Clicking an entry asks Outlook
// to open it; nothing is marked read or changed from here. The rail folds to a strip with the
// count (outlook.mailRailCollapsed, owner decision F-3).
export function MailRail({
  status,
  zone,
  collapsed,
  onCollapsedChange,
}: {
  status: OutlookStatus | undefined;
  zone: string;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const { connection } = useRuntime();
  const { rows: mail, status: topicStatus } = useTopicState('mailItems');
  const [active, setActive] = useState(0);
  const unreadCount = status?.unreadCount ?? 0;
  // While Outlook cannot be read the list is what it was at the last good poll.
  const stale = Boolean(status?.lastError);

  const open = (entry: MailItem) => {
    if (!connection) return;
    connection.request('outlook.open', { entryId: entry.externalId }).then(
      () => notify.success('Opened in Outlook', { description: entry.subject, id: 'mail-open' }),
      (caught: unknown) =>
        notify.error('Could not open the message in Outlook', {
          description: errorMessage(caught),
          id: 'mail-open',
        }),
    );
  };

  if (collapsed) {
    return (
      <aside
        aria-label="Unread mail"
        className="flex w-10 shrink-0 flex-col items-center gap-1 border-l border-border bg-sidebar/50 py-1"
      >
        <IconButton
          label={`Show mail rail, ${unreadCount} unread`}
          shortcut="keybindings.toggleMailRail"
          side="left"
          onClick={() => onCollapsedChange(false)}
        >
          <PanelRightOpenIcon />
        </IconButton>
        <span className="flex flex-col items-center gap-0.5 text-2xs text-muted-foreground tabular-nums">
          <MailIcon className="size-3.5" aria-hidden />
          <span aria-label={`${unreadCount} unread`}>{unreadCount}</span>
        </span>
      </aside>
    );
  }

  const rows = mail ?? [];
  // Roving focus: one Tab stop for the list, arrow keys between messages.
  const focusRow = (list: HTMLElement | null, index: number) => {
    const next = Math.min(rows.length - 1, Math.max(0, index));
    setActive(next);
    list?.querySelectorAll<HTMLElement>('[data-mail-row]')[next]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const keys: Record<string, number> = {
      ArrowDown: active + 1,
      ArrowUp: active - 1,
      Home: 0,
      End: rows.length - 1,
    };
    const target = keys[event.key];
    if (target === undefined) return;
    event.preventDefault();
    focusRow(event.currentTarget, target);
  };

  return (
    <aside
      aria-label="Unread mail"
      className="flex w-72 shrink-0 flex-col border-l border-border bg-sidebar/50"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-1 pl-3 text-xs font-medium">
        <MailIcon className="size-3.5 text-muted-foreground" aria-hidden />
        Unread
        <span
          aria-label={`${unreadCount} unread`}
          className="rounded-full bg-muted px-1.5 text-2xs text-muted-foreground tabular-nums"
        >
          {unreadCount}
        </span>
        {stale && status?.lastSyncAt && (
          <span className="truncate text-2xs font-normal text-warning" data-testid="mail-stale">
            Last read {formatWhen(status.lastSyncAt, zone)}
          </span>
        )}
        <IconButton
          label="Collapse mail rail"
          shortcut="keybindings.toggleMailRail"
          side="left"
          className="ml-auto"
          onClick={() => onCollapsedChange(true)}
        >
          <PanelRightCloseIcon />
        </IconButton>
      </div>
      {mail === undefined ? (
        <TopicPlaceholder status={topicStatus} compact rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          icon={MailIcon}
          title={stale ? 'No unread mail at the last read' : 'No unread mail'}
          description="New messages in your mail folders show up here."
        />
      ) : (
        <Stale
          status={stale ? 'disconnected' : topicStatus}
          className="flex min-h-0 flex-1 flex-col"
        >
          <ul
            aria-label="Unread messages"
            className="min-h-0 flex-1 overflow-y-auto p-1"
            onKeyDown={onKeyDown}
          >
            {rows.map((entry, index) => (
              <li key={entry.id}>
                <WithTooltip
                  side="left"
                  label={
                    <span className="flex max-w-72 flex-col whitespace-normal">
                      <span className="font-medium">{entry.subject}</span>
                      {entry.snippet && <span>{entry.snippet}</span>}
                    </span>
                  }
                >
                  <Button
                    type="button"
                    variant="ghost"
                    data-mail-row
                    tabIndex={index === Math.min(active, rows.length - 1) ? 0 : -1}
                    onFocus={() => setActive(index)}
                    onClick={() => open(entry)}
                    className="h-auto w-full flex-col items-stretch gap-0.5 px-2 py-1.5 text-left font-normal whitespace-normal hover:bg-sidebar-accent focus-visible:bg-sidebar-accent dark:hover:bg-sidebar-accent"
                  >
                    <span className="flex items-center gap-2 text-xs">
                      <span className="min-w-0 flex-1 truncate font-medium">{entry.from}</span>
                      <time
                        dateTime={entry.receivedAt}
                        className="shrink-0 text-2xs text-muted-foreground tabular-nums"
                      >
                        {formatWhen(entry.receivedAt, zone)}
                      </time>
                    </span>
                    <span className="truncate text-xs">{entry.subject}</span>
                    {entry.snippet && (
                      <span className="truncate text-2xs text-muted-foreground">
                        {entry.snippet}
                      </span>
                    )}
                    {entry.folder !== 'Inbox' && (
                      <span className="text-2xs text-muted-foreground">{entry.folder}</span>
                    )}
                  </Button>
                </WithTooltip>
              </li>
            ))}
          </ul>
        </Stale>
      )}
    </aside>
  );
}
