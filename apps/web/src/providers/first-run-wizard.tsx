import {
  DetectedProvider,
  ProviderTestResult,
  providerSetup,
  type ProviderKind,
} from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useRuntime } from '@/app/runtime';
import { errorMessage, useTopic } from '@/chat/data';
import { emptyDraft, newInstanceId } from './model';
import { StatusBadge } from './status-badge';

type Outcome = { readonly kind: ProviderKind; readonly name: string; readonly error?: string };

// First run (spec 31, 32): finds the installed CLIs, creates one instance per chosen CLI and
// tests it. The badges show the stored test result, so they read from the instances topic.
export function FirstRunWizard({ onClose }: { onClose: () => void }) {
  const { connection } = useRuntime();
  const instances = useTopic('providerInstances');
  const [detected, setDetected] = useState<readonly DetectedProvider[]>();
  const [error, setError] = useState<string>();
  const [chosen, setChosen] = useState<ReadonlySet<ProviderKind>>(new Set());
  const [created, setCreated] = useState<readonly (Outcome & { readonly id: string })[]>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!connection) return undefined;
    let current = true;
    connection.request('provider.detect', {}).then(
      (result) => {
        if (!current) return;
        const found = DetectedProvider.array().parse(result);
        setDetected(found);
        setChosen(new Set(found.filter((entry) => entry.binaryPath).map((entry) => entry.kind)));
      },
      (reason: unknown) => current && setError(errorMessage(reason)),
    );
    return () => {
      current = false;
    };
  }, [connection]);

  const create = async () => {
    if (!connection || !detected) return;
    setBusy(true);
    const outcomes: (Outcome & { id: string })[] = [];
    const names = (instances ?? []).map((instance) => instance.name);
    for (const entry of detected) {
      if (!chosen.has(entry.kind)) continue;
      const id = newInstanceId(entry.kind);
      const { name } = emptyDraft(entry.kind, names);
      names.push(name);
      try {
        await dispatch(connection, {
          type: 'providerInstance.create',
          providerInstanceId: id,
          kind: entry.kind,
          name,
          binaryPath: entry.binaryPath ?? '',
          configDir: entry.configDir,
          env: {},
          launchArgs: [],
        });
        outcomes.push({ id, kind: entry.kind, name });
      } catch (reason) {
        outcomes.push({ id, kind: entry.kind, name, error: errorMessage(reason) });
      }
    }
    setCreated(outcomes);
    setBusy(false);
    // The server records each result on the instance; the badges below pick it up.
    await Promise.all(
      outcomes
        .filter((outcome) => outcome.error === undefined)
        .map((outcome) =>
          connection
            .request('provider.test', { providerInstanceId: outcome.id })
            .then((result) => ProviderTestResult.parse(result))
            .catch(() => undefined),
        ),
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Set up providers</DialogTitle>
          <DialogDescription>
            wow runs the Claude and Codex CLIs installed on this machine. Pick the ones to use; each
            becomes a provider instance you can change later in Settings → Providers.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {!detected && !error && <p className="text-sm text-muted-foreground">Looking…</p>}
        {detected && !created && (
          <ul aria-label="Detected providers" className="flex flex-col gap-2">
            {detected.map((entry) => {
              const setup = providerSetup[entry.kind];
              return (
                <li
                  key={entry.kind}
                  className="flex items-start gap-3 rounded-md border border-border p-3"
                >
                  <Checkbox
                    id={`wizard-${entry.kind}`}
                    checked={chosen.has(entry.kind)}
                    disabled={!entry.binaryPath}
                    onCheckedChange={(next) =>
                      setChosen((current) => {
                        const updated = new Set(current);
                        if (next === true) updated.add(entry.kind);
                        else updated.delete(entry.kind);
                        return updated;
                      })
                    }
                  />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <Label htmlFor={`wizard-${entry.kind}`}>{setup.label}</Label>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {entry.binaryPath ?? `${setup.binaryName} not found on PATH`}
                    </span>
                    {entry.binaryPath && (
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {setup.configDirEnv}={entry.configDir}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {created && (
          <ul aria-label="Created instances" className="flex flex-col gap-2">
            {created.map((outcome) => {
              const instance = instances?.find((candidate) => candidate.id === outcome.id);
              return (
                <li
                  key={outcome.id}
                  className="flex flex-col gap-1 rounded-md border border-border p-3"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{outcome.name}</span>
                    {instance && <StatusBadge instance={instance} />}
                  </div>
                  {(outcome.error ?? instance?.statusMessage) && (
                    <span className="text-xs text-destructive">
                      {outcome.error ?? instance?.statusMessage}
                    </span>
                  )}
                  {instance?.account && (
                    <span className="text-xs text-muted-foreground">
                      {instance.account}
                      {instance.version ? ` · ${instance.version}` : ''}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <DialogFooter>
          {created ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Not now
              </Button>
              <Button
                disabled={busy || !detected || chosen.size === 0}
                onClick={() => void create()}
              >
                Create and test
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
