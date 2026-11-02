import type { AppNotification } from '@wow/contracts';
import { useNavigate } from '@tanstack/react-router';
import { AlertTriangleIcon, BellIcon, PlayIcon } from 'lucide-react';
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

const icons = { started: PlayIcon, waiting: BellIcon, failed: AlertTriangleIcon } as const;
const iconClass = {
  started: 'text-state-working',
  waiting: 'text-state-needs-you',
  failed: 'text-state-failed',
} as const;

// The web app's side of the server's notification channel: a toast per new notification (spec 9),
// with "Open" to go where it points. The desktop app shows the same events as system
// notifications. The same toaster carries the feedback toasts of `lib/feedback`.
export function AppToaster() {
  const rows = useTopic('notifications');
  const seconds = useSetting('scheduler.toastSeconds');
  const theme = useSetting('appearance.theme');
  const navigate = useNavigate();
  const seen = useRef<Set<string>>(undefined);

  useEffect(() => {
    if (rows === undefined) return;
    const fresh = freshNotifications(seen.current, rows);
    seen.current = new Set([...(seen.current ?? []), ...rows.map((row) => row.id)]);
    for (const notification of fresh) {
      const Icon = icons[notification.kind];
      toast(notification.title, {
        id: notification.id,
        icon: <Icon aria-hidden className={cn('size-4', iconClass[notification.kind])} />,
        ...(notification.body !== '' ? { description: notification.body } : {}),
        action: { label: 'Open', onClick: () => void navigate({ to: notification.path }) },
      });
    }
  }, [rows, navigate]);

  return <Toaster theme={theme} duration={seconds * 1000} />;
}
