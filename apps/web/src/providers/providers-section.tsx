import {
  DetectedProvider,
  SecretRef,
  providerSetup,
  type ProviderInstance,
  type ProviderKind,
} from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import { BotIcon, PencilIcon, PlayIcon, PlusIcon, SearchIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PathText } from '@/components/path-text';
import { EmptyState, Stale, TopicPlaceholder } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useRuntime } from '@/app/runtime';
import { useTopicState } from '@/app/topic-state';
import { errorMessage, useTopic } from '@/chat/data';
import { notify, offerUndo } from '@/lib/feedback';
import { lastUsedInstanceId, newInstanceId, testInstance } from './model';
import { StatusBadge } from './status-badge';

const hasSecrets = (instance: ProviderInstance) =>
  Object.values(instance.env).some((value) => SecretRef.safeParse(value).success);

// The CLIs the server finds on its PATH, to show what an empty binary path resolves to.
function useDetected(): ReadonlyMap<ProviderKind, DetectedProvider> {
  const { connection } = useRuntime();
  const [found, setFound] = useState<ReadonlyMap<ProviderKind, DetectedProvider>>(new Map());
  useEffect(() => {
    if (!connection) return undefined;
    let current = true;
    connection.request('provider.detect', {}).then(
      (result) => {
        if (!current) return;
        const parsed = DetectedProvider.array().safeParse(result);
        if (parsed.success) setFound(new Map(parsed.data.map((entry) => [entry.kind, entry])));
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [connection]);
  return found;
}

function InstanceRow({
  instance,
  isDefault,
  detected,
}: {
  instance: ProviderInstance;
  isDefault: boolean;
  detected: DetectedProvider | undefined;
}) {
  const { connection, layout } = useRuntime();
  const [testing, setTesting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const setup = providerSetup[instance.kind];
  const untested = instance.status === 'unknown';

  const test = async () => {
    if (!connection) return;
    setTesting(true);
    setError(undefined);
    const result = await testInstance(connection, instance.id);
    if (!result.ok && result.message) setError(result.message);
    setTesting(false);
  };

  const remove = async () => {
    if (!connection) return;
    setError(undefined);
    try {
      await dispatch(connection, {
        type: 'providerInstance.delete',
        providerInstanceId: instance.id,
      });
    } catch (reason) {
      setError(errorMessage(reason));
      return;
    }
    // Without stored secrets the instance can come back as it was (owner decision F-9).
    if (!hasSecrets(instance)) {
      offerUndo({
        message: `${instance.name} removed`,
        undo: () =>
          dispatch(connection, {
            type: 'providerInstance.create',
            providerInstanceId: newInstanceId(instance.kind),
            kind: instance.kind,
            name: instance.name,
            binaryPath: instance.binaryPath,
            configDir: instance.configDir,
            env: instance.env,
            launchArgs: instance.launchArgs,
            defaultModel: instance.defaultModel,
            defaultEffort: instance.defaultEffort,
            defaultPermissionMode: instance.defaultPermissionMode,
          }),
      });
    } else {
      notify.success(`${instance.name} removed`);
    }
  };

  const binary = instance.binaryPath || detected?.binaryPath;
  const configDir = instance.configDir || detected?.configDir || `~/${setup.defaultConfigDir}`;

  return (
    <li
      aria-label={instance.name}
      data-testid={`provider-${instance.id}`}
      className="flex min-w-0 flex-col gap-2 border-b border-border py-3 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{instance.name}</span>
        {instance.name !== setup.label && <Badge variant="secondary">{setup.label}</Badge>}
        <StatusBadge instance={instance} />
        {isDefault && (
          <Badge variant="outline" data-testid="provider-default">
            Default for new threads
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant={untested ? 'default' : 'outline'}
            size="sm"
            disabled={testing || !connection}
            onClick={() => void test()}
          >
            <PlayIcon />
            {testing ? 'Testing…' : 'Test'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              layout.setState({
                providerDialog: { type: 'edit', providerInstanceId: instance.id },
              })
            }
          >
            <PencilIcon />
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => (hasSecrets(instance) ? setConfirming(true) : void remove())}
          >
            <Trash2Icon />
            Remove
          </Button>
        </div>
      </div>
      <dl className="grid min-w-0 grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Account</dt>
        <dd data-testid="provider-account">{instance.account ?? 'Not known yet'}</dd>
        <dt className="text-muted-foreground">Version</dt>
        <dd data-testid="provider-version">{instance.version ?? 'Not known yet'}</dd>
        <dt className="text-muted-foreground">Binary</dt>
        <dd className="flex min-w-0 items-center gap-1.5">
          {binary ? (
            <PathText path={binary} />
          ) : (
            <span className="text-muted-foreground">{setup.binaryName} not found on PATH</span>
          )}
          {!instance.binaryPath && binary && (
            <span className="shrink-0 text-2xs text-muted-foreground">from PATH</span>
          )}
        </dd>
        <dt className="text-muted-foreground">Config folder</dt>
        <dd className="min-w-0">
          <PathText path={configDir} />
        </dd>
      </dl>
      {untested && (
        <p className="text-xs text-warning">
          Not tested yet. Test it to see the account and models.
        </p>
      )}
      {instance.status === 'error' && instance.statusMessage && (
        <p className="text-xs text-destructive">{instance.statusMessage}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Remove ${instance.name}?`}
        description="Its stored secret values are deleted from the wow secret store and cannot be restored. The CLI and its config folder stay on disk."
        confirmLabel="Remove"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void remove();
        }}
      />
    </li>
  );
}

// Settings → Providers: the instances, their last test, and the way to add more (spec 31, 32).
export function ProvidersSection() {
  const { connection, layout } = useRuntime();
  const { rows: instances, status } = useTopicState('providerInstances');
  const threads = useTopic('threads');
  const offline = !connection || status === 'disconnected';
  const detected = useDetected();
  const defaultId = lastUsedInstanceId(threads, instances);
  const add = (kind: ProviderKind) => layout.setState({ providerDialog: { type: 'create', kind } });

  return (
    <section
      aria-label="Provider instances"
      className="flex min-w-0 flex-col gap-2 border-b border-border py-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">
          The Claude and Codex CLIs wow runs. New threads start on the one you used last.
        </p>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={offline} onClick={() => add('claude')}>
            <PlusIcon />
            Add Claude
          </Button>
          <Button variant="outline" size="sm" disabled={offline} onClick={() => add('codex')}>
            <PlusIcon />
            Add Codex
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={offline}
            onClick={() => layout.setState({ providerDialog: { type: 'wizard' } })}
          >
            <SearchIcon />
            Detect installed
          </Button>
        </div>
      </div>
      {instances === undefined ? (
        <TopicPlaceholder status={status} compact rows={2} />
      ) : instances.length === 0 ? (
        <EmptyState
          compact
          icon={BotIcon}
          title="No providers yet"
          description="wow finds the Claude and Codex CLIs on this machine and sets them up for you."
          action={
            <Button
              size="sm"
              onClick={() => layout.setState({ providerDialog: { type: 'wizard' } })}
            >
              <SearchIcon />
              Detect installed CLIs
            </Button>
          }
        />
      ) : (
        <Stale status={status}>
          <ul className="flex flex-col">
            {instances.map((instance) => (
              <InstanceRow
                key={instance.id}
                instance={instance}
                isDefault={instance.id === defaultId}
                detected={detected.get(instance.kind)}
              />
            ))}
          </ul>
        </Stale>
      )}
    </section>
  );
}
