import { npmInstallCommand, providerSetup, type ProviderInstance } from '@wow/contracts';
import { DownloadIcon, LoaderCircleIcon } from 'lucide-react';
import { useState } from 'react';
import { Banner } from '@/components/banner';
import { CodeBlock } from '@/components/code-block';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { useRuntime } from '@/app/runtime';
import { errorMessage } from '@/chat/data';
import { notify } from '@/lib/feedback';

// "Update Codex to <version>" under an instance whose last test found it incompatible or older
// than the tested version (spec 31). The server runs npm and stores the run on the instance
// (`updateRun`), so this only renders that row and sends `provider.update`.
export function UpdateOffer({ instance }: { instance: ProviderInstance }) {
  const { connection } = useRuntime();
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const { update, updateRun: run } = instance;
  const label = providerSetup[instance.kind].label;
  const running = run?.state === 'running';

  const start = async () => {
    if (!connection) return;
    setStarting(true);
    try {
      await connection.request('provider.update', { providerInstanceId: instance.id });
    } catch (reason) {
      notify.error(`Could not update ${label}`, { description: errorMessage(reason) });
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="provider-update">
      {run && (
        <Banner
          tone={run.state === 'failed' ? 'error' : 'info'}
          icon={running ? LoaderCircleIcon : undefined}
          label="Update"
          testId="provider-update-run"
          className="rounded-md border"
        >
          {run.state === 'running'
            ? `Updating ${label} to ${run.targetVersion}…`
            : run.state === 'succeeded'
              ? `${label} ${run.targetVersion} installed. wow tested it again.`
              : (run.message ?? `The update to ${run.targetVersion} failed.`)}
        </Banner>
      )}
      {run && (run.output !== '' || running) && (
        <CodeBlock
          code={run.output === '' ? `$ ${run.command}` : `$ ${run.command}\n${run.output}`}
          className="max-h-48 overflow-y-auto"
        />
      )}
      {update?.method === 'npm' && !running && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={starting || !connection}
            onClick={() => setConfirming(true)}
            data-testid="provider-update-button"
          >
            <DownloadIcon />
            {`Update ${label} to ${update.targetVersion}`}
          </Button>
          <span className="text-xs text-muted-foreground">
            {update.reason === 'older'
              ? `Works, but older than the tested ${update.targetVersion}.`
              : `wow is tested with ${label} ${update.targetVersion}.`}
          </span>
        </div>
      )}
      {update?.method === 'manual' && (
        <p className="text-xs text-muted-foreground" data-testid="provider-update-instruction">
          {update.instruction}
        </p>
      )}
      {update?.method === 'npm' && (
        <ConfirmDialog
          open={confirming}
          title={`Update ${label} to ${update.targetVersion}?`}
          description={
            <span className="flex flex-col gap-2">
              <span>wow runs this command on this computer, then tests the instance again:</span>
              <code
                className="rounded bg-muted px-2 py-1 font-mono text-xs text-foreground"
                data-testid="provider-update-command"
              >
                {npmInstallCommand(update)}
              </code>
            </span>
          }
          confirmLabel="Update"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void start();
          }}
        />
      )}
    </div>
  );
}
