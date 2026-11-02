import { AlertTriangleIcon, InfoIcon, XCircleIcon, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type BannerTone = 'info' | 'warning' | 'error';

const tones: Readonly<
  Record<BannerTone, { icon: LucideIcon; className: string; iconClass: string }>
> = {
  info: { icon: InfoIcon, className: 'bg-info/10 border-info/30', iconClass: 'text-info' },
  warning: {
    icon: AlertTriangleIcon,
    className: 'bg-warning/10 border-warning/30',
    iconClass: 'text-warning',
  },
  error: {
    icon: XCircleIcon,
    className: 'bg-destructive/10 border-destructive/30',
    iconClass: 'text-destructive',
  },
};

// One bar for lasting conditions only (design rules): Outlook down, not connected, update ready.
// One 36px row; the message truncates instead of wrapping, actions stay on the right.
export function Banner({
  tone,
  icon,
  children,
  actions,
  className,
  testId,
}: {
  readonly tone: BannerTone;
  readonly icon?: LucideIcon | undefined;
  // The message: one short sentence that says what is wrong and what happens next.
  readonly children: ReactNode;
  // Buttons, size="xs" or "sm"; the primary one last.
  readonly actions?: ReactNode | undefined;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
}) {
  const style = tones[tone];
  const Icon = icon ?? style.icon;
  return (
    <div
      role={tone === 'info' ? 'status' : 'alert'}
      data-testid={testId}
      data-tone={tone}
      className={cn(
        'flex min-h-9 shrink-0 items-center gap-2 border-b px-3 py-1 text-xs text-foreground',
        style.className,
        className,
      )}
    >
      <Icon aria-hidden className={cn('size-3.5 shrink-0', style.iconClass)} />
      <div className="min-w-0 flex-1 truncate">{children}</div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
