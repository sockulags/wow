import type { LucideIcon } from 'lucide-react';
import { UnplugIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import type { TopicStatus } from '@/app/topic-state';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// Shared empty, loading and not-connected states (design rules, "Empty, loading and error").

export interface EmptyStateProps {
  readonly icon: LucideIcon;
  readonly title: string;
  // One sentence that says what to do next.
  readonly description?: ReactNode | undefined;
  // Same as description, for call sites that pass the sentence as children.
  readonly children?: ReactNode | undefined;
  // The one primary action, usually a <Button>.
  readonly action?: ReactNode | undefined;
  // Further actions, outline or ghost buttons.
  readonly secondary?: ReactNode | undefined;
  // For side lists: smaller, top-aligned, no full-height centering.
  readonly compact?: boolean | undefined;
  readonly className?: string | undefined;
}

export function EmptyState({
  icon: Icon,
  title,
  description: descriptionProp,
  children,
  action,
  secondary,
  compact = false,
  className,
}: EmptyStateProps) {
  const titleId = useId();
  const description = descriptionProp ?? children;
  return (
    <section
      aria-labelledby={titleId}
      data-testid="empty-state"
      className={cn(
        'flex flex-col items-center text-center',
        compact ? 'gap-1.5 px-2 py-6' : 'h-full justify-center gap-2 p-8',
        className,
      )}
    >
      <Icon className={cn('text-muted-foreground', compact ? 'size-4' : 'size-6')} aria-hidden />
      <h2 id={titleId} className={cn('font-medium', compact ? 'text-xs' : 'text-sm')}>
        {title}
      </h2>
      {description !== undefined && (
        <p className={cn('max-w-sm text-muted-foreground', compact ? 'text-2xs' : 'text-xs')}>
          {description}
        </p>
      )}
      {(action !== undefined || secondary !== undefined) && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondary}
        </div>
      )}
    </section>
  );
}

// Placeholder rows while a topic's first snapshot is on its way. They fade in only after a short
// delay, so a fast answer never flashes them.
export function LoadingState({
  rows,
  compact = false,
  label = 'Loading',
  className,
}: {
  readonly rows?: number | undefined;
  readonly compact?: boolean | undefined;
  readonly label?: string | undefined;
  readonly className?: string | undefined;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      data-testid="loading-state"
      className={cn(
        'wow-delayed-appear flex flex-col',
        compact ? 'gap-1.5 p-2' : 'gap-3 p-4',
        className,
      )}
    >
      {Array.from({ length: rows ?? 3 }, (_, index) => (
        <Skeleton key={index} className={compact ? 'h-7' : 'h-10'} />
      ))}
    </div>
  );
}

// Shown where data would be when there is none yet and the server cannot be reached. The shell's
// banner says the same with a retry action, so this one stays quiet.
export function DisconnectedState({
  compact = false,
  offline = false,
  className,
}: {
  readonly compact?: boolean | undefined;
  // No server is configured at all (development), rather than a dropped connection.
  readonly offline?: boolean | undefined;
  readonly className?: string | undefined;
}) {
  return (
    <EmptyState
      icon={UnplugIcon}
      compact={compact}
      className={className}
      title="Not connected to the wow server"
      description={
        offline
          ? 'Start the wow server to see this.'
          : 'This shows up again as soon as the connection is back.'
      }
    />
  );
}

// What to render for a topic that has no rows to show yet: loading or not connected. Returns null
// once rows are there, so `TopicPlaceholder ?? list` reads naturally:
//   if (rows === undefined) return <TopicPlaceholder status={status} />;
export function TopicPlaceholder({
  status,
  compact = false,
  rows,
  className,
}: {
  readonly status: TopicStatus;
  readonly compact?: boolean | undefined;
  readonly rows?: number | undefined;
  readonly className?: string | undefined;
}) {
  if (status === 'disconnected' || status === 'offline') {
    return (
      <DisconnectedState compact={compact} offline={status === 'offline'} className={className} />
    );
  }
  return <LoadingState compact={compact} rows={rows} className={className} />;
}

// Keeps the last rows visible but dimmed and inert while the connection is down.
export function Stale({
  status,
  children,
  className,
}: {
  readonly status: TopicStatus;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}) {
  const stale = status === 'disconnected';
  return (
    <div
      data-stale={stale || undefined}
      aria-busy={stale || undefined}
      className={cn(stale && 'pointer-events-none opacity-60 transition-opacity', className)}
    >
      {children}
    </div>
  );
}
