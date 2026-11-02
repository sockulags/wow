import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type { LucideIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { formatBinding } from '@/app/keybindings';
import { cn } from '@/lib/utils';

// Stand-ins for shared pieces the design-system unit adds to components/ (Tooltip, Kbd,
// EmptyState, PathText). Chat, workflows and backlog use these until the shared ones land; then
// each import moves to the shared component and this file goes.

export function LocalKbd({ binding, className }: { binding: string; className?: string }) {
  if (binding === '') return null;
  return (
    <kbd
      className={cn(
        'inline-flex h-5 items-center rounded border border-border bg-muted px-1 font-sans text-[11px] font-medium text-muted-foreground tabular-nums',
        className,
      )}
    >
      {formatBinding(binding)}
    </kbd>
  );
}

// A label (and its key) shown on hover and on keyboard focus. The trigger keeps its own
// aria-label; the tooltip is a visual hint.
export function LocalTooltip({
  label,
  binding = '',
  children,
  side = 'top',
}: {
  label: ReactNode;
  binding?: string;
  children: ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={4}
            className="z-50 flex max-w-xs items-center gap-1.5 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          >
            <span>{label}</span>
            <LocalKbd binding={binding} />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export function LocalEmptyState({
  icon: Icon,
  title,
  children,
  action,
  compact = false,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        'flex flex-col items-center text-center',
        compact ? 'gap-1.5 px-3 py-6' : 'h-full justify-center gap-2 p-8',
      )}
    >
      <Icon
        aria-hidden
        className={cn('text-muted-foreground', compact ? 'size-4' : 'size-6')}
      />
      <h2 className={cn('font-medium', compact ? 'text-xs' : 'text-sm')}>{title}</h2>
      {children && <div className="max-w-sm text-xs text-muted-foreground">{children}</div>}
      {action && <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div>}
    </section>
  );
}

// The middle of a long path gives way first, so the drive and the folder name stay readable.
export function shortenPath(path: string, max: number): string {
  if (path.length <= max) return path;
  const keep = Math.max(4, max - 1);
  const head = Math.ceil(keep / 3);
  return `${path.slice(0, head)}…${path.slice(path.length - (keep - head))}`;
}

export function LocalPathText({
  path,
  max = 48,
  className,
}: {
  path: string;
  max?: number;
  className?: string;
}) {
  return (
    <LocalTooltip label={<span className="font-mono break-all">{path}</span>}>
      <span tabIndex={0} className={cn('min-w-0 truncate font-mono', className)}>
        {shortenPath(path, max)}
      </span>
    </LocalTooltip>
  );
}
