import { providerChatOptions, type ProviderInstance } from '@wow/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useStore } from 'zustand';
import { useRuntime } from '@/app/runtime';
import { Input } from '@/components/ui/input';
import { Composer } from './composer';
import { useDispatch, useModels, useTopic } from './data';
import { effortOptions, titleFromMessage } from './model';
import { ThreadSettings, type ThreadSettingsValue } from './thread-settings';

const fieldClass =
  'h-8 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30';

// What a new thread on this instance starts with: the instance defaults, else the first model
// the provider lists and the first effort and permission mode offered for it.
function useDefaults(instance: ProviderInstance | undefined): ThreadSettingsValue | undefined {
  const { models } = useModels(instance?.id);
  if (!instance) return undefined;
  const model = instance.defaultModel ?? models[0]?.id ?? '';
  const effort =
    instance.defaultEffort ?? effortOptions(instance.kind, models, model, '')[0] ?? 'default';
  const permissionMode =
    instance.defaultPermissionMode ?? providerChatOptions[instance.kind].permissionModes[0]?.id;
  return { model, effort, permissionMode: permissionMode ?? 'default' };
}

export function NewThreadView() {
  const { draft } = useRuntime();
  const send = useDispatch();
  const navigate = useNavigate();
  const instances = useTopic('providerInstances');
  const projects = useTopic('projects') ?? [];
  const picked = useStore(draft);
  const [overrides, setOverrides] = useState<
    Partial<ThreadSettingsValue> & { readonly for?: string }
  >({});

  const instance =
    instances?.find((candidate) => candidate.id === picked.providerInstanceId) ?? instances?.[0];
  const defaults = useDefaults(instance);
  const project = projects.find((candidate) => candidate.id === picked.projectId);
  const cwd = picked.cwd ?? project?.cwd ?? '';
  const { for: overridesFor, ...picks } = overrides;
  const settings: ThreadSettingsValue | undefined =
    defaults && (overridesFor === instance?.id ? { ...defaults, ...picks } : defaults);

  if (instances && instances.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <h2 className="text-sm font-medium">No provider instances yet</h2>
        <p className="max-w-sm text-xs text-muted-foreground">
          Add a Claude or Codex instance in{' '}
          <Link to="/settings/$group" params={{ group: 'providers' }} className="underline">
            Settings → Providers
          </Link>{' '}
          to start a thread.
        </p>
      </div>
    );
  }

  const start = async (text: string) => {
    if (!instance || !settings) throw new Error('Pick a provider instance first');
    if (cwd.trim() === '') throw new Error('Pick a project or enter a working directory');
    if (settings.model === '') throw new Error('Pick a model first');
    const threadId = globalThis.crypto.randomUUID();
    await send({
      type: 'thread.create',
      threadId,
      providerInstanceId: instance.id,
      ...(project ? { projectId: project.id } : {}),
      cwd: cwd.trim(),
      title: titleFromMessage(text),
      ...settings,
    });
    await send({ type: 'thread.sendMessage', threadId, text });
    draft.setState({ projectId: undefined, cwd: undefined });
    await navigate({ to: '/chat/$threadId', params: { threadId } });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2">
        <h2 className="text-sm font-medium">New thread</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            aria-label="Provider instance"
            className={fieldClass}
            value={instance?.id ?? ''}
            onChange={(event) => draft.setState({ providerInstanceId: event.target.value })}
          >
            {(instances ?? []).map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name} ({candidate.kind})
              </option>
            ))}
          </select>
          <select
            aria-label="Project"
            className={fieldClass}
            value={project?.id ?? ''}
            onChange={(event) =>
              draft.setState({
                projectId: event.target.value === '' ? undefined : event.target.value,
                cwd: undefined,
              })
            }
          >
            <option value="">No project</option>
            {projects.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
          <Input
            aria-label="Working directory"
            placeholder="Working directory"
            value={cwd}
            onChange={(event) => draft.setState({ cwd: event.target.value })}
            className="h-8 w-72 font-mono text-xs"
          />
        </div>
        {instance && settings && (
          <ThreadSettings
            providerInstanceId={instance.id}
            kind={instance.kind}
            value={settings}
            onChange={(changes) =>
              setOverrides((current) => ({
                ...(current.for === instance.id ? current : {}),
                ...changes,
                for: instance.id,
              }))
            }
          />
        )}
      </header>
      <div className="flex-1" />
      <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4">
        <Composer
          providerKind={instance?.kind}
          running={false}
          disabled={!instance}
          placeholder="What should the agent do? Type $ to pick a skill."
          onSend={start}
        />
      </div>
    </div>
  );
}
