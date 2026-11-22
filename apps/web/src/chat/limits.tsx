import type { ReportedLimit } from '@wow/contracts';
import { GaugeIcon } from 'lucide-react';
import { useSetting } from '@/app/runtime';
import { WithTooltip } from '@/components/hint';
import { useDateFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTopic } from './data';

// Plan limits as the providers reported them (chat overview spec 25 to 30): a chip in the
// composer bar once a window is at the warning, and the full list for Settings and Usage. Only
// what was reported is shown; a window whose reset time has passed says so instead of a share.

export function limitName(limit: Pick<ReportedLimit, 'window' | 'label'>): string {
  switch (limit.window) {
    case 'fiveHour':
      return '5 h';
    case 'week':
      return 'Week';
    case 'weekModel':
      return `Week, ${limit.label ?? 'model'}`;
    case 'other':
      return limit.label ?? 'Limit';
  }
}

// A window whose reset time has passed has not been reported since; its share says nothing now.
export const isStale = (limit: ReportedLimit, now: number): boolean =>
  limit.resetsAt !== null && Date.parse(limit.resetsAt) <= now;

// The window closest to its limit among those still current.
export function topLimit(limits: readonly ReportedLimit[], now: number): ReportedLimit | undefined {
  const rank = (limit: ReportedLimit) =>
    limit.state === 'reached' ? 101 : (limit.usedPercent ?? (limit.state === 'warning' ? 100 : 0));
  return limits.filter((limit) => !isStale(limit, now)).toSorted((a, b) => rank(b) - rank(a))[0];
}

export const useInstanceLimits = (providerInstanceId: string | undefined): ReportedLimit[] =>
  useTopic('providerLimits')?.find((row) => row.providerInstanceId === providerInstanceId)
    ?.limits ?? [];

function usedText(limit: ReportedLimit): string {
  if (limit.state === 'reached') return 'reached';
  return limit.usedPercent === null ? 'near its limit' : `${Math.round(limit.usedPercent)} %`;
}

// The composer bar's chip (spec 27): the instance's highest window from `chat.limitWarnPercent`,
// amber, and red once reached; hovering lists every window.
export function LimitChip({ providerInstanceId }: { readonly providerInstanceId: string }) {
  const limits = useInstanceLimits(providerInstanceId);
  const warnAt = useSetting('chat.limitWarnPercent');
  const { when } = useDateFormat();
  const now = Date.now();
  const top = topLimit(limits, now);
  if (!top || (top.state === 'ok' && (top.usedPercent === null || top.usedPercent < warnAt))) {
    return null;
  }
  const reached = top.state === 'reached';
  const all = limits
    .map((limit) =>
      isStale(limit, now)
        ? `${limitName(limit)}: reset, not reported since`
        : `${limitName(limit)}: ${usedText(limit)}${limit.resetsAt ? ` · resets ${when(limit.resetsAt)}` : ''}`,
    )
    .join('\n');
  return (
    <WithTooltip label={all}>
      <span
        role="status"
        data-testid="limit-chip"
        className={cn(
          'ml-1 inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs tabular-nums',
          reached ? 'bg-destructive/15 text-destructive' : 'bg-warning/15 text-warning',
        )}
      >
        <GaugeIcon aria-hidden className="size-3" />
        {limitName(top)}: {usedText(top)}
        {top.resetsAt && ` · resets ${when(top.resetsAt)}`}
      </span>
    </WithTooltip>
  );
}

// Every window an instance reported (spec 28), for Settings → Providers and Usage.
export function LimitList({ limits }: { readonly limits: readonly ReportedLimit[] }) {
  const { when, relative } = useDateFormat();
  const now = Date.now();
  if (limits.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="limits-none">
        No plan limits reported. Claude Code reports a claude.ai plan's limits as it works; an API
        key and Codex report none to wow.
      </p>
    );
  }
  return (
    <ul aria-label="Plan limits" data-testid="limit-list" className="flex flex-col gap-1.5">
      {limits.map((limit) => {
        const stale = isStale(limit, now);
        const used = limit.usedPercent ?? (limit.state === 'reached' ? 100 : 0);
        return (
          <li
            key={`${limit.window}:${limit.label ?? ''}`}
            className="flex flex-col gap-0.5 text-xs"
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{limitName(limit)}</span>
              <span className="text-muted-foreground tabular-nums">
                {stale
                  ? `reset at ${when(limit.resetsAt ?? '')}, not reported since`
                  : `${usedText(limit)}${limit.resetsAt ? ` · resets ${when(limit.resetsAt)}` : ''}`}
              </span>
            </span>
            {!stale && (
              <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-muted">
                <span
                  className={cn(
                    'block h-full rounded-full',
                    limit.state === 'reached'
                      ? 'bg-destructive'
                      : limit.state === 'warning'
                        ? 'bg-warning'
                        : 'bg-primary',
                  )}
                  style={{ width: `${Math.min(100, Math.max(0, used))}%` }}
                />
              </span>
            )}
            <span className="text-2xs text-muted-foreground">
              Reported {relative(limit.reportedAt)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
