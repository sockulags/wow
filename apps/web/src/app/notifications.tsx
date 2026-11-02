import type { AppNotification } from '@wow/contracts';
import { useNavigate } from '@tanstack/react-router';
import { AlertTriangleIcon, BellIcon, PlayIcon, XIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTopic } from '@/chat/data';
import { cn } from '@/lib/utils';
import { useSetting } from './runtime';

// The rows of the notifications topic that arrived after the first snapshot. The first snapshot
// only sets what was seen, so opening the app does not replay old notifications.
export function freshNotifications(
  seen: ReadonlySet<string> | undefined,
  rows: readonly AppNotification[],
): AppNotification[] {
  if (seen === undefined) return [];
  return rows.filter((row) => !seen.has(row.id)).toReversed();
}

const icons = { started: PlayIcon, waiting: BellIcon, failed: AlertTriangleIcon } as const;

function Toast({
  notification,
  seconds,
  onClose,
}: {
  notification: AppNotification;
  seconds: number;
  onClose: (id: string) => void;
}) {
  const navigate = useNavigate();
  const Icon = icons[notification.kind];
  const { id } = notification;
  useEffect(() => {
    const timer = setTimeout(() => onClose(id), seconds * 1000);
    return () => clearTimeout(timer);
  }, [onClose, id, seconds]);
  return (
    <li
      data-testid="toast"
      className="flex w-80 items-start gap-2 rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-md"
    >
      <Icon
        aria-hidden
        className={cn(
          'mt-0.5 size-3.5 shrink-0',
          notification.kind === 'waiting' && 'text-state-needs-you',
          notification.kind === 'failed' && 'text-state-failed',
          notification.kind === 'started' && 'text-state-working',
        )}
      />
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={() => {
          void navigate({ to: notification.path });
          onClose(id);
        }}
      >
        <span className="block font-medium">{notification.title}</span>
        {notification.body !== '' && (
          <span className="block truncate text-muted-foreground">{notification.body}</span>
        )}
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        className="text-muted-foreground hover:text-foreground"
        onClick={() => onClose(id)}
      >
        <XIcon className="size-3.5" />
      </button>
    </li>
  );
}

// The web app's side of the server's notification channel: a toast per new notification (spec 9).
// The desktop app shows the same events as system notifications.
export function Toaster() {
  const rows = useTopic('notifications');
  const seconds = useSetting('scheduler.toastSeconds');
  const seen = useRef<Set<string>>(undefined);
  const [shown, setShown] = useState<readonly AppNotification[]>([]);

  useEffect(() => {
    if (rows === undefined) return;
    const fresh = freshNotifications(seen.current, rows);
    seen.current = new Set([...(seen.current ?? []), ...rows.map((row) => row.id)]);
    if (fresh.length > 0) setShown((current) => [...current, ...fresh]);
  }, [rows]);

  const close = useCallback(
    (id: string) => setShown((current) => current.filter((entry) => entry.id !== id)),
    [],
  );

  return (
    <ol
      aria-label="Notifications"
      aria-live="polite"
      className="pointer-events-auto fixed right-3 bottom-3 z-50 flex flex-col gap-2"
    >
      {shown.map((notification) => (
        <Toast
          key={notification.id}
          notification={notification}
          seconds={seconds}
          onClose={close}
        />
      ))}
    </ol>
  );
}
