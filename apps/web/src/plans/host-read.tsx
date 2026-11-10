import type { ChangeRequest, HostRead, HostRefreshParams } from '@wow/contracts';
import { Link } from '@tanstack/react-router';
import { ExternalLinkIcon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { useRuntime } from '@/app/runtime';
import { errorMessage } from '@/chat/data';
import { Badge } from '@/components/ui/badge';
import { safeHref } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { useDateFormat } from '@/lib/format';
import { changeRequestStateLabel, checksLabel, lastFetchedLabel, settingLabel } from './model';

// What the Plans view and the run's Pull request tab share: when the host was last asked, what
// went wrong since, and "Refresh now" (review loop spec 26, 30, 31 and 32). The time is the
// server's; nothing here is worked out from this window's clock.

const stateVariants = {
  Open: 'info',
  Draft: 'outline',
  Merged: 'secondary',
  Closed: 'outline',
} as const;

export function ChangeRequestState({ request }: { readonly request: ChangeRequest }) {
  const label = changeRequestStateLabel(request);
  return (
    <Badge
      data-testid="change-request-state"
      variant={stateVariants[label as keyof typeof stateVariants] ?? 'outline'}
    >
      {label}
    </Badge>
  );
}

const checkVariants = {
  none: 'outline',
  pending: 'info',
  success: 'secondary',
  failure: 'destructive',
} as const;

export function ChecksBadge({ request }: { readonly request: ChangeRequest }) {
  return (
    <Badge data-testid="change-request-checks" variant={checkVariants[request.checkState]}>
      {checksLabel(request)}
    </Badge>
  );
}

// A link out to the host. The desktop shell opens http and https links in the system browser.
// The address came from the host, so one that is not a web or mail address shows as text.
export function HostLink({
  href,
  children,
  className,
}: {
  readonly href: string;
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  const safe = safeHref(href);
  if (safe === undefined) return <span className={className}>{children}</span>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noreferrer"
      className={
        className ??
        'inline-flex items-center gap-1 underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring'
      }
    >
      {children}
    </a>
  );
}

// Asks the host once (`hosts.refresh`), whatever the polling settings say.
export function useHostRefresh(params: HostRefreshParams) {
  const { connection } = useRuntime();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { planId, runId } = params;
  const refresh = async () => {
    if (!connection) return;
    setBusy(true);
    setError(undefined);
    try {
      await connection.request('hosts.refresh', {
        ...(planId === undefined ? {} : { planId }),
        ...(runId === undefined ? {} : { runId }),
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, refresh };
}

export function HostReadLine({
  read,
  refresh,
  openUrl,
}: {
  readonly read: HostRead | undefined;
  readonly refresh: ReturnType<typeof useHostRefresh>;
  // The pull request on the host, for "Open on host".
  readonly openUrl?: string | undefined;
}) {
  const { when } = useDateFormat();
  const failure = read?.error;
  const open = safeHref(openUrl);
  return (
    <div data-testid="host-read" className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span data-testid="host-fetched">{lastFetchedLabel(read, when)}</span>
        <Button
          variant="ghost"
          size="xs"
          disabled={refresh.busy}
          onClick={() => void refresh.refresh()}
        >
          <RefreshCwIcon />
          Refresh now
        </Button>
        {open && (
          <Button asChild variant="ghost" size="xs">
            <a href={open} target="_blank" rel="noreferrer">
              <ExternalLinkIcon />
              Open on host
            </a>
          </Button>
        )}
      </div>
      {failure && (
        <p role="alert" data-testid="host-error" className="text-xs text-destructive">
          {failure.message}
          {failure.kind === 'failed' ? ` (since ${when(failure.at)})` : ''}
          {failure.setting && (
            <>
              {' '}
              <Link
                to="/settings/$group"
                params={{ group: 'trackers' }}
                className="underline underline-offset-2"
              >
                Open {settingLabel(failure.setting)} in Settings
              </Link>
            </>
          )}
        </p>
      )}
      {refresh.error && (
        <p role="alert" className="text-xs text-destructive">
          {refresh.error}
        </p>
      )}
    </div>
  );
}
