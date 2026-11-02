import type { UpdateState } from '@wow/contracts';
import { DownloadIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { formatTime } from '@/calendar/time';
import { Banner } from '@/components/banner';
import { IconButton } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { useDateFormat } from '@/lib/format';
import { useRuntime, useSetting, useUpdateState } from './runtime';
import { describeUpdate, describeUpdateError, releaseNotesUrl } from './updates';

// Shown above every view once an update is downloaded ("Restart to update", "Later", "What's
// new") or a check failed. The main process asks first when a turn or workflow run is running.
export function UpdateBanner() {
  const { updates } = useRuntime();
  const state = useUpdateState();
  const interval = useSetting('updates.checkIntervalMinutes');
  const { zone } = useDateFormat();
  // "Later" hides this version and "Dismiss" this error, for this session; the next one shows.
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  if (updates === undefined || state === undefined) return null;
  const key =
    state.status === 'ready'
      ? `ready:${state.version ?? ''}`
      : state.status === 'error'
        ? `error:${state.checkedAt}:${state.error}`
        : undefined;
  if (key === undefined || key === dismissed) return null;
  if (state.status === 'ready') {
    const version = state.version;
    return (
      <Banner
        tone="info"
        icon={DownloadIcon}
        label="Update"
        actions={
          <>
            {version && (
              <Button size="xs" variant="ghost" asChild>
                <a href={releaseNotesUrl(version)} target="_blank" rel="noreferrer">
                  What&apos;s new
                </a>
              </Button>
            )}
            <Button size="xs" variant="outline" onClick={() => setDismissed(key)}>
              Later
            </Button>
            <Button size="xs" onClick={() => updates.install()}>
              Restart to update
            </Button>
          </>
        }
      >
        {describeUpdate(state)}
      </Banner>
    );
  }
  const retryAt =
    state.enabled && state.checkedAt
      ? formatTime(new Date(Date.parse(state.checkedAt) + interval * 60_000), zone)
      : undefined;
  return (
    <Banner
      tone="warning"
      label="Update"
      actions={
        <IconButton label="Dismiss" size="icon-xs" onClick={() => setDismissed(key)}>
          <XIcon />
        </IconButton>
      }
    >
      {describeUpdateError(state.error, retryAt)}
    </Banner>
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
