import { DetectedProvider, providerSetup, type ProviderKind } from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import { useNavigate } from '@tanstack/react-router';
import { CheckCircle2Icon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PathText } from '@/components/path-text';
import { LoadingState } from '@/components/states';
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
import { errorMessage, useDispatch, useTopic } from '@/chat/data';
import { importLabel } from '@/projects/import-dialog';
import { ImportList, importFolders, useDiscoveredProjects } from '@/projects/import-list';
import { emptyDraft, newInstanceId, testInstance } from './model';
import { StatusBadge } from './status-badge';

type Outcome = {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly name: string;
  readonly error?: string;
};

type Step = 'providers' | 'projects' | 'done';

const stepTitles: Readonly<Record<Step, string>> = {
  providers: 'Set up providers',
  projects: 'Add your projects',
  done: 'You are set up',
};

function StepDots({ step }: { step: Step }) {
  const steps: Step[] = ['providers', 'projects', 'done'];
  const at = steps.indexOf(step);
  return (
    <p className="text-xs text-muted-foreground" aria-label={`Step ${at + 1} of 3`}>
      Step {at + 1} of 3
    </p>
  );
}

function ProvidersStep({
  detected,
  error,
  chosen,
  setChosen,
  created,
}: {
  detected: readonly DetectedProvider[] | undefined;
  error: string | undefined;
  chosen: ReadonlySet<ProviderKind>;
  setChosen: (update: (current: ReadonlySet<ProviderKind>) => ReadonlySet<ProviderKind>) => void;
  created: readonly Outcome[] | undefined;
}) {
  const instances = useTopic('providerInstances');
  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (!detected) return <LoadingState rows={2} label="Looking for Claude and Codex" />;
  if (created) {
    return (
      <ul aria-label="Created instances" className="flex min-w-0 flex-col gap-2">
        {created.map((outcome) => {
          const instance = instances?.find((candidate) => candidate.id === outcome.id);
          return (
            <li
              key={outcome.id}
              className="flex min-w-0 flex-col gap-1 rounded-md border border-border p-3"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{outcome.name}</span>
                {instance && <StatusBadge instance={instance} />}
              </div>
              {(outcome.error ?? instance?.statusMessage) && (
                <span className="text-xs break-words text-destructive">
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
    );
  }
  return (
    <ul aria-label="Detected providers" className="flex min-w-0 flex-col gap-2">
      {detected.map((entry) => {
        const setup = providerSetup[entry.kind];
        return (
          <li
            key={entry.kind}
            className="flex min-w-0 items-start gap-3 rounded-md border border-border p-3"
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
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Label htmlFor={`wizard-${entry.kind}`}>{setup.label}</Label>
              {entry.binaryPath ? (
                <>
                  <PathText path={entry.binaryPath} className="text-muted-foreground" />
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="shrink-0">Config folder</span>
                    <PathText path={entry.configDir} />
                  </span>
                </>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {setup.binaryName} is not installed, or not on the PATH.
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// First run (spec 31, 32; owner decision F-10): providers, then projects (imported from the
// folders Claude and Codex worked in), then done. "Not now" is remembered in providers.offerSetup.
export function FirstRunWizard({ onClose }: { onClose: () => void }) {
  const { connection, settings } = useRuntime();
  const navigate = useNavigate();
  const send = useDispatch();
  const instances = useTopic('providerInstances');
  const projects = useTopic('projects') ?? [];
  const [step, setStep] = useState<Step>('providers');
  const [detected, setDetected] = useState<readonly DetectedProvider[]>();
  const [error, setError] = useState<string>();
  const [chosen, setChosen] = useState<ReadonlySet<ProviderKind>>(new Set());
  const [created, setCreated] = useState<readonly Outcome[]>();
  const [imported, setImported] = useState(0);
  const [failures, setFailures] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const primary = useRef<HTMLButtonElement>(null);

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

  // Each step puts focus on its primary action (audit A-11).
  useEffect(() => {
    primary.current?.focus();
  }, [step, created, detected]);

  const notNow = () => {
    void settings.write('providers.offerSetup', false);
    onClose();
  };

  const create = async () => {
    if (!connection || !detected) return;
    setBusy(true);
    const outcomes: Outcome[] = [];
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
    // The server records each result on the instance; the badges pick it up.
    await Promise.all(
      outcomes
        .filter((outcome) => outcome.error === undefined)
        .map((outcome) => testInstance(connection, outcome.id)),
    );
  };

  const discovered = useDiscoveredProjects(step === 'projects');
  const importChosen = async () => {
    setBusy(true);
    setFailures([]);
    const result = await importFolders(send, discovered.chosen, projects);
    setBusy(false);
    setImported((count) => count + result.imported.size);
    if (result.failed.length > 0) {
      setFailures(result.failed);
      discovered.keepOnly(discovered.offered.filter((entry) => !result.imported.has(entry.cwd)));
      return;
    }
    setStep('done');
  };

  const finish = (to?: '/chat/new') => {
    void settings.write('providers.offerSetup', false);
    onClose();
    if (to) void navigate({ to });
  };

  const descriptions: Readonly<Record<Step, string>> = {
    providers:
      'wow runs the Claude and Codex CLIs installed on this machine. Pick the ones to use; you can change them later in Settings → Providers.',
    projects:
      'A project is a folder wow works in. These are the folders Claude and Codex already worked in.',
    done: 'Start a thread, plan the day on the calendar, or build a workflow.',
  };

  return (
    <Dialog open onOpenChange={(open) => !open && (step === 'done' ? finish() : notNow())}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[90vh] overflow-y-auto sm:max-w-xl"
        onOpenAutoFocus={(event) => {
          // The primary action, not "Not now", takes focus.
          if (primary.current) {
            event.preventDefault();
            primary.current.focus();
          }
        }}
      >
        <DialogHeader>
          <StepDots step={step} />
          <DialogTitle>{stepTitles[step]}</DialogTitle>
          <DialogDescription>{descriptions[step]}</DialogDescription>
        </DialogHeader>
        {step === 'providers' && (
          <ProvidersStep
            detected={detected}
            error={error}
            chosen={chosen}
            setChosen={setChosen}
            created={created}
          />
        )}
        {step === 'projects' && <ImportList discovered={discovered} />}
        {step === 'done' && (
          <ul className="flex flex-col gap-1.5 text-sm">
            <li className="flex items-center gap-2">
              <CheckCircle2Icon className="size-4 text-state-done" aria-hidden />
              {instances?.length === 1 ? '1 provider' : `${instances?.length ?? 0} providers`} ready
              to use
            </li>
            <li className="flex items-center gap-2">
              <CheckCircle2Icon className="size-4 text-state-done" aria-hidden />
              {imported === 1 ? '1 project imported' : `${imported} projects imported`}
            </li>
          </ul>
        )}
        {failures.length > 0 && (
          <ul role="alert" className="text-xs break-all text-destructive">
            {failures.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        )}
        <DialogFooter>
          {step === 'providers' && !created && (
            <>
              <Button variant="outline" onClick={notNow}>
                Not now
              </Button>
              <Button
                ref={primary}
                disabled={busy || !detected || chosen.size === 0}
                onClick={() => void create()}
              >
                {chosen.size === 1 ? 'Set up 1 provider' : `Set up ${chosen.size} providers`}
              </Button>
            </>
          )}
          {step === 'providers' && created && (
            <Button ref={primary} onClick={() => setStep('projects')}>
              Continue
            </Button>
          )}
          {step === 'projects' && (
            <>
              <Button variant="outline" onClick={() => setStep('done')}>
                Skip
              </Button>
              {discovered.offered.length > 0 ? (
                <Button
                  ref={primary}
                  disabled={busy || discovered.chosen.length === 0}
                  onClick={() => void importChosen()}
                >
                  {importLabel(discovered.chosen.length)}
                </Button>
              ) : (
                <Button ref={primary} onClick={() => setStep('done')}>
                  Continue
                </Button>
              )}
            </>
          )}
          {step === 'done' && (
            <>
              <Button variant="outline" onClick={() => finish()}>
                Close
              </Button>
              <Button ref={primary} onClick={() => finish('/chat/new')}>
                Start a thread
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
