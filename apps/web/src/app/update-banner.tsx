import type { UpdateState } from '@wow/contracts';
import { AlertTriangleIcon, DownloadIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useRuntime, useUpdateState } from './runtime';
import { describeUpdate } from './updates';

// Shown above every view once an update is downloaded ("Restart to update") or a check failed. The
// main process asks first when a turn or workflow run is running.
export function UpdateBanner() {
  const { updates } = useRuntime();
  const state = useUpdateState();
  // Dismissing hides this error only; the next failure shows again.
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  if (updates === undefined || state === undefined) return null;
  const errorKey = state.status === 'error' ? `${state.checkedAt}:${state.error}` : undefined;
  if (state.status !== 'ready' && (errorKey === undefined || errorKey === dismissed)) return null;
  const ready = state.status === 'ready';
  const Icon = ready ? DownloadIcon : AlertTriangleIcon;
  return (
    <div
      role="status"
      aria-label="Update"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs"
    >
      <Icon
        aria-hidden
        className={cn('size-3.5 shrink-0', ready ? 'text-state-done' : 'text-state-failed')}
      />
      <span className="min-w-0 flex-1 truncate">{describeUpdate(state)}</span>
      {ready ? (
        <Button size="sm" onClick={() => updates.install()}>
          Restart to update
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss"
          onClick={() => setDismissed(errorKey)}
        >
          <XIcon />
        </Button>
      )}
    </div>
  );
}

const busy = new Set<UpdateState['status']>(['checking', 'available', 'downloading']);

// Settings → Updates: the state and the two actions, above the registry fields.
export function UpdateStatusPanel() {
  const { updates } = useRuntime();
  const state = useUpdateState();
  if (updates === undefined || state === undefined)
    return (
      <p data-testid="update-status" className="mt-2 text-xs text-muted-foreground">
        Updates run in the installed desktop app only.
      </p>
    );
  return (
    <div
      data-testid="update-status"
      className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border p-3 text-xs"
    >
      <span className="min-w-0 flex-1">{describeUpdate(state)}</span>
      {state.enabled && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy.has(state.status) || state.status === 'ready'}
          onClick={() => updates.check()}
        >
          Check for updates
        </Button>
      )}
      {state.status === 'ready' && (
        <Button size="sm" onClick={() => updates.install()}>
          Restart to update
        </Button>
      )}
    </div>
  );
}
