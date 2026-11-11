import { DetectedProvider, ProviderKind, providerSetup } from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import { FileUpIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createStore, useStore } from 'zustand';
import { useRuntime } from '@/app/runtime';
import { errorMessage, useTopic } from '@/chat/data';
import { PathText } from '@/components/path-text';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/feedback';
import { readSetupFile, setupStore } from '@/settings/setup';
import { SetupPreviewDialog } from '@/settings/setup-section';
import { emptyDraft, newInstanceId, testInstance } from './model';
import { StatusBadge } from './status-badge';

// The one fixed step "Connect an agent" (app assistant spec 25, 27): Claude Code and Codex side
// by side, each with the binary found on this machine, Test and the test's error in words, and
// "Start from a setup file" below. It reuses the provider onboarding: the instance it makes is
// the one Settings → Providers shows. The first-start gate shows it over the whole window; the
// Assistant view shows it inline when its provider is gone.

// What the step's palette commands ask for; the step that is on screen takes it. `shown`
// counts the steps on screen, so the commands are offered only while one is.
export const connectStore = createStore<{
  readonly wanted: ProviderKind | undefined;
  readonly shown: number;
}>(() => ({ wanted: undefined, shown: 0 }));

// The names the step uses: the CLI's product, which is what someone installed.
export const agentNames: Readonly<Record<ProviderKind, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

function AgentCard({
  kind,
  detected,
  busy,
  error,
  onTest,
}: {
  kind: ProviderKind;
  detected: DetectedProvider | undefined;
  busy: boolean;
  error: string | undefined;
  onTest(): void;
}) {
  const instances = useTopic('providerInstances');
  const instance = instances?.find((candidate) => candidate.kind === kind);
  const setup = providerSetup[kind];
  const binary = instance?.binaryPath || detected?.binaryPath;
  const failure = error ?? (instance?.status === 'error' ? instance.statusMessage : null);
  return (
    <section
      aria-label={agentNames[kind]}
      data-testid={`connect-${kind}`}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{agentNames[kind]}</h3>
        {instance && <StatusBadge instance={instance} />}
      </div>
      {binary ? (
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0">Found</span>
          <PathText path={binary} />
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">
          {detected
            ? `${setup.binaryName} is not installed, or not on the PATH.`
            : `Looking for ${setup.binaryName}…`}
        </span>
      )}
      {instance?.status === 'ready' && instance.account && (
        <span className="text-xs text-muted-foreground">
          {instance.account}
          {instance.version ? ` · ${instance.version}` : ''}
        </span>
      )}
      {failure && (
        <p role="alert" className="text-xs break-words text-destructive">
          {failure}
        </p>
      )}
      <div className="mt-auto pt-1">
        <Button size="sm" disabled={busy} onClick={onTest}>
          {busy ? 'Testing…' : 'Test'}
        </Button>
      </div>
    </section>
  );
}

export function ConnectAgentStep({
  onConnected,
  className,
}: {
  onConnected?: (providerInstanceId: string) => void;
  className?: string;
}) {
  const { connection } = useRuntime();
  const instances = useTopic('providerInstances');
  const applications = useTopic('setupApplications');
  const [detected, setDetected] = useState<readonly DetectedProvider[]>();
  const [detectError, setDetectError] = useState<string>();
  const [busy, setBusy] = useState<ProviderKind>();
  const [errors, setErrors] = useState<Partial<Record<ProviderKind, string>>>({});
  const wanted = useStore(connectStore, (state) => state.wanted);
  const input = useRef<HTMLInputElement>(null);
  const pickWanted = useStore(setupStore, (state) => state.pickWanted);

  useEffect(() => {
    if (!connection) return undefined;
    let current = true;
    connection.request('provider.detect', {}).then(
      (result) => current && setDetected(DetectedProvider.array().parse(result)),
      (reason: unknown) => current && setDetectError(errorMessage(reason)),
    );
    return () => {
      current = false;
    };
  }, [connection]);

  // Test makes the instance from what detection found when there is none of that kind yet,
  // then runs the provider's own test; the result is also stored on the instance.
  const test = async (kind: ProviderKind) => {
    if (!connection || busy) return;
    setBusy(kind);
    setErrors((current) => ({ ...current, [kind]: undefined }));
    try {
      let id = instances?.find((candidate) => candidate.kind === kind)?.id;
      if (!id) {
        id = newInstanceId(kind);
        const entry = detected?.find((candidate) => candidate.kind === kind);
        const { name } = emptyDraft(
          kind,
          (instances ?? []).map((instance) => instance.name),
        );
        await dispatch(connection, {
          type: 'providerInstance.create',
          providerInstanceId: id,
          kind,
          name,
          binaryPath: entry?.binaryPath ?? '',
          configDir: entry?.configDir ?? '',
          env: {},
          launchArgs: [],
        });
      }
      const result = await testInstance(connection, id);
      if (result.ok) onConnected?.(id);
      else setErrors((current) => ({ ...current, [kind]: result.message ?? 'The test failed.' }));
    } catch (reason) {
      setErrors((current) => ({ ...current, [kind]: errorMessage(reason) }));
    } finally {
      setBusy(undefined);
    }
  };

  useEffect(() => {
    connectStore.setState((state) => ({ shown: state.shown + 1 }));
    return () => connectStore.setState((state) => ({ shown: state.shown - 1 }));
  }, []);

  useEffect(() => {
    if (!wanted) return;
    connectStore.setState({ wanted: undefined });
    void test(wanted);
    // Only a new ask runs a test; `test` is made anew on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

  // The palette's "Start from a setup file" opens the picker here while the step is up.
  useEffect(() => {
    if (!pickWanted) return;
    setupStore.setState({ pickWanted: false });
    input.current?.click();
  }, [pickWanted]);

  const applied = applications?.findLast((application) => application.state === 'applied');

  return (
    <div className={cn('flex w-full max-w-3xl flex-col gap-4', className)}>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Connect an agent</h2>
        <p className="text-sm text-muted-foreground">
          wow runs Claude Code or Codex, installed on this machine, with your own sign-in. Test one
          to connect it; the assistant then helps you set up the rest.
        </p>
      </div>
      {detectError && (
        <p role="alert" className="text-sm text-destructive">
          {detectError}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {ProviderKind.options.map((kind) => (
          <AgentCard
            key={kind}
            kind={kind}
            detected={detected?.find((entry) => entry.kind === kind)}
            busy={busy === kind}
            error={errors[kind]}
            onTest={() => void test(kind)}
          />
        ))}
      </div>
      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <p className="text-sm text-muted-foreground">
          A colleague sent you their setup? Start from it; its secrets are left for you to fill in.
        </p>
        <div>
          <Button variant="outline" disabled={!connection} onClick={() => input.current?.click()}>
            <FileUpIcon aria-hidden />
            Start from a setup file
          </Button>
        </div>
        <input
          ref={input}
          type="file"
          accept=".yaml,.yml,application/yaml,text/yaml"
          aria-label="Setup file to start from"
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file || !connection) return;
            readSetupFile(connection, file).catch((error: unknown) =>
              notify.error('The file could not be read', { description: errorMessage(error) }),
            );
          }}
        />
        {applied && (
          <p data-testid="connect-applied" className="text-xs text-muted-foreground">
            {applied.name} is applied: {applied.added.length} added, {applied.replaced.length}{' '}
            replaced. Once an agent is connected, the assistant goes through what it left to fill
            in.
          </p>
        )}
      </div>
      <SetupPreviewDialog />
    </div>
  );
}
