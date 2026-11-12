import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import type { ItemContext } from '../items';
import { commandOutcome, formatDuration, toolDuration, type ToolPayload } from './facts';

// One redraw a second while something runs, for its clock.
const second = 1000;

export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), second);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

// How a call stands, in words: waiting for an approval, not finished when its turn ended
// without it, or running.
export function runningLabel(payload: ToolPayload, context: ItemContext): string | undefined {
  if (payload.status !== 'running') return undefined;
  if (context.awaitingApproval) return 'waiting for approval';
  if (context.turnEnded) return 'not finished';
  return 'running';
}

// The right end of a row: "exit 1 · 4.2 s", "failed · 0.8 s", or a running call's time counting
// up from the start the server stored (spec 27, 30). `outcome` false leaves out the result word,
// for rows whose line already says enough.
export function ToolTime({
  payload,
  context,
  command = false,
}: {
  payload: ToolPayload;
  context: ItemContext;
  command?: boolean;
}) {
  const running = runningLabel(payload, context);
  const counting = running === 'running' || running === 'waiting for approval';
  const now = useNow(counting && payload.startedAt !== undefined);
  const duration = running === 'not finished' ? undefined : toolDuration(payload, now);
  const outcome =
    running ?? (command ? commandOutcome(payload) : payload.status === 'error' ? 'failed' : 'done');
  const parts = [outcome, ...(duration === undefined ? [] : [formatDuration(duration)])];
  return (
    <span
      data-testid="tool-time"
      data-started-at={payload.startedAt}
      className={cn(
        'shrink-0 tabular-nums',
        payload.status === 'error'
          ? 'text-state-failed'
          : running === 'waiting for approval'
            ? 'text-state-needs-you-text'
            : running === 'running'
              ? 'text-state-working'
              : 'text-muted-foreground',
      )}
    >
      {parts.join(' · ')}
    </span>
  );
}
