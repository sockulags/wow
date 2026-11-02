import { providerSetup, type ProviderInstance } from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import { PencilIcon, PlayIcon, PlusIcon, SearchIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useRuntime } from '@/app/runtime';
import { errorMessage, useTopic } from '@/chat/data';
import { StatusBadge } from './status-badge';

function InstanceRow({ instance }: { instance: ProviderInstance }) {
  const { connection, layout } = useRuntime();
  const [testing, setTesting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const setup = providerSetup[instance.kind];

  const test = async () => {
    if (!connection) return;
    setTesting(true);
    setError(undefined);
    try {
      // The result is stored on the instance and arrives through the subscription.
      await connection.request('provider.test', { providerInstanceId: instance.id });
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setTesting(false);
    }
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
      setConfirming(false);
    }
  };

  return (
    <li
      aria-label={instance.name}
      data-testid={`provider-${instance.id}`}
      className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{instance.name}</span>
        <Badge variant="secondary">{setup.label}</Badge>
        <StatusBadge instance={instance} />
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={testing} onClick={() => void test()}>
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
          {confirming ? (
            <>
              <Button variant="destructive" size="sm" onClick={() => void remove()}>
                Remove {instance.name}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
              <Trash2Icon />
              Remove
            </Button>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">Account</dt>
        <dd data-testid="provider-account">{instance.account ?? '–'}</dd>
        <dt className="text-muted-foreground">Version</dt>
        <dd data-testid="provider-version">{instance.version ?? '–'}</dd>
        <dt className="text-muted-foreground">Binary</dt>
        <dd className="truncate font-mono">{instance.binaryPath || setup.binaryName}</dd>
        <dt className="text-muted-foreground">{setup.configDirEnv}</dt>
        <dd className="truncate font-mono">
          {instance.configDir || `~/${setup.defaultConfigDir}`}
        </dd>
      </dl>
      {instance.status === 'error' && instance.statusMessage && (
        <p className="text-xs text-destructive">{instance.statusMessage}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

// Settings → Providers: the instances, their last test, and the way to add more (spec 31, 32).
export function ProvidersSection() {
  const { connection, layout } = useRuntime();
  const instances = useTopic('providerInstances');

  return (
    <section
      aria-label="Provider instances"
      className="flex flex-col gap-2 border-b border-border py-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Instances</h3>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={!connection}
            onClick={() => layout.setState({ providerDialog: { type: 'create', kind: 'claude' } })}
          >
            <PlusIcon />
            Add Claude
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!connection}
            onClick={() => layout.setState({ providerDialog: { type: 'create', kind: 'codex' } })}
          >
            <PlusIcon />
            Add Codex
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!connection}
            onClick={() => layout.setState({ providerDialog: { type: 'wizard' } })}
          >
            <SearchIcon />
            Detect installed
          </Button>
        </div>
      </div>
      {!connection && (
        <p className="text-xs text-muted-foreground">
          Provider instances live on the wow server; this window is not connected to one.
        </p>
      )}
      {connection && instances?.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No provider instances yet. Detect the installed CLIs or add one by hand.
        </p>
      )}
      {instances && instances.length > 0 && (
        <ul className="flex flex-col">
          {instances.map((instance) => (
            <InstanceRow key={instance.id} instance={instance} />
          ))}
        </ul>
      )}
    </section>
  );
}
