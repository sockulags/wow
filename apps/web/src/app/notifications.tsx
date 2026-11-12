import type { AppNotification } from '@wow/contracts';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import {
  AlertTriangleIcon,
  BellIcon,
  CircleCheckIcon,
  PlayIcon,
  SkipForwardIcon,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useTopic } from '@/chat/data';
import { Toaster } from '@/components/ui/sonner';
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

// A chat thread's notification is not shown while that thread is on screen in a focused window
// (agent workbench spec 64); the user is already looking at it.
export const onScreen = (
  notification: Pick<AppNotification, 'threadId'>,
  openThreadId: string | undefined,
  focused: boolean,
): boolean => focused && openThreadId !== undefined && notification.threadId === openThreadId;

export const openThreadOf = (pathname: string): string | undefined =>
  /^\/chat\/(?!new$)([^/]+)$/.exec(pathname)?.[1];

const icons = {
  started: PlayIcon,
  waiting: BellIcon,
  failed: AlertTriangleIcon,
  skipped: SkipForwardIcon,
  finished: CircleCheckIcon,
} as const;
const iconClass = {
  started: 'text-state-working',
  waiting: 'text-state-needs-you',
  failed: 'text-state-failed',
  skipped: 'text-muted-foreground',
  finished: 'text-state-done',
} as const;

// The web app's side of the server's notification channel: a toast per new notification (spec 9),
// with "Open" to go where it points. The desktop app shows the same events as system
// notifications. The same toaster carries the feedback toasts of `lib/feedback`.
export function AppToaster() {
  const rows = useTopic('notifications');
  const seconds = useSetting('scheduler.toastSeconds');
  const theme = useSetting('appearance.theme');
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const openThread = useRef<string | undefined>(undefined);
  openThread.current = openThreadOf(pathname);
  const seen = useRef<Set<string>>(undefined);

  useEffect(() => {
    if (rows === undefined) return;
    const fresh = freshNotifications(seen.current, rows);
    seen.current = new Set([...(seen.current ?? []), ...rows.map((row) => row.id)]);
    for (const notification of fresh) {
      if (onScreen(notification, openThread.current, document.hasFocus())) continue;
      const Icon = icons[notification.kind];
      toast(notification.title, {
        id: notification.id,
        icon: <Icon aria-hidden className={cn('size-4', iconClass[notification.kind])} />,
        ...(notification.body !== '' ? { description: notification.body } : {}),
        action: { label: 'Open', onClick: () => void navigate({ to: notification.path }) },
      });
    }
  }, [rows, navigate]);

  // Listed, not stacked: a later notification must not cover an earlier toast's Undo.
  return <Toaster theme={theme} duration={seconds * 1000} expand />;
}
