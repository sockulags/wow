import { TrackerTestResult, trackerConnectionLabels, type TrackerConnection } from '@wow/contracts';
import { CheckCircle2Icon, CircleAlertIcon, PlugZapIcon } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useRuntime, useSetting } from '@/app/runtime';
import type { SettingEntry } from '@/app/sections';
import { errorMessage, useTopic } from '@/chat/data';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { SettingsForm } from './setting-row';

export function TestConnection({
  service,
  projectId,
}: {
  service: TrackerConnection;
  // Tests the settings as they apply to this project instead of the defaults.
  projectId?: string | undefined;
}) {
  const { connection } = useRuntime();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const test = async () => {
    if (!connection) return;
    setBusy(true);
    try {
      const answer = TrackerTestResult.parse(
        await connection.request('trackers.test', projectId ? { service, projectId } : { service }),
      );
      setResult({ ok: answer.ok, message: answer.message });
    } catch (error) {
      setResult({ ok: false, message: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };
  const Icon = result?.ok ? CheckCircle2Icon : CircleAlertIcon;
  return (
    <div className="flex min-w-0 items-center gap-2">
      {result && (
        <p
          role="status"
          data-testid={
            projectId ? `tracker-${service}-status-${projectId}` : `tracker-${service}-status`
          }
          className={cn(
            'flex min-w-0 items-center gap-1.5 text-xs',
            result.ok ? 'text-muted-foreground' : 'text-destructive',
          )}
        >
          <Icon aria-hidden className={cn('size-3.5 shrink-0', result.ok && 'text-state-done')} />
          <span className="truncate">{result.message}</span>
        </p>
      )}
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        disabled={!connection || busy}
        onClick={() => void test()}
      >
        <PlugZapIcon />
        {busy ? 'Testing…' : 'Test connection'}
      </Button>
    </div>
  );
}

// Settings → Trackers in one section per host, each with its own "Test connection" (audit E-08).
// The Jira email shows only for Jira Cloud sign-in, where it is used.
export function TrackersSection({ entries }: { entries: readonly SettingEntry[] }) {
  const authMode = useSetting('trackers.jira.authMode');
  const jira = entries.filter(
    ([key]) =>
      key.startsWith('trackers.jira.') && !(key === 'trackers.jira.email' && authMode === 'pat'),
  );
  const github = entries.filter(([key]) => key.startsWith('trackers.github.'));
  const gitlab = entries.filter(([key]) => key.startsWith('trackers.gitlab.'));
  const other = entries.filter(
    ([key]) =>
      !key.startsWith('trackers.jira.') &&
      !key.startsWith('trackers.github.') &&
      !key.startsWith('trackers.gitlab.'),
  );
  const sections: [TrackerConnection, readonly SettingEntry[]][] = [
    ['jira', jira],
    ['github', github],
    ['gitlab', gitlab],
  ];
  const outlook = useTopic('outlookStatus')?.[0];
  const email = useSetting('trackers.jira.email');
  const address = outlook?.profile?.address ?? null;
  return (
    <div className="flex flex-col gap-6 pt-2">
      <p className="text-xs text-muted-foreground" data-testid="trackers-defaults-note">
        These are the defaults for every project. Tokens saved here are shared by all projects. A
        project can use its own values in{' '}
        <Link
          to="/settings/projects"
          className="rounded-sm underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Settings → Projects
        </Link>
        , where the GitHub repository or GitLab project is read from the project&apos;s git remote.
      </p>
      {sections.map(([service, rows]) => (
        <section key={service} aria-labelledby={`tracker-${service}`}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
            <h3 id={`tracker-${service}`} className="text-sm font-semibold">
              {trackerConnectionLabels[service]}
            </h3>
            <TestConnection service={service} />
          </div>
          {service === 'jira' && authMode === 'cloud-basic' && email === '' && address && (
            <p data-testid="jira-email-outlook" className="pt-2 text-xs text-muted-foreground">
              While Jira email is empty, wow signs in as {address}, the address Outlook uses.
            </p>
          )}
          <SettingsForm entries={rows} />
        </section>
      ))}
      {other.length > 0 && (
        <section aria-labelledby="tracker-both">
          <h3 id="tracker-both" className="border-b border-border pb-2 text-sm font-semibold">
            Every tracker
          </h3>
          <SettingsForm entries={other} />
        </section>
      )}
    </div>
  );
}
