import {
  providerChatOptions,
  type Project,
  type ProviderInstance,
  type ProviderModel,
  type SentImage,
  type SkillRef,
  type Thread,
} from '@wow/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  FolderOpenIcon,
  ListTodoIcon,
  MessagesSquareIcon,
  PlugIcon,
  SparklesIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useRuntime, useSetting } from '@/app/runtime';
import { ChoiceSelect } from '@/components/choice-select';
import { Combobox } from '@/components/combobox';
import { WithTooltip } from '@/components/hint';
import { PathText } from '@/components/path-text';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { lastUsedInstanceId } from '@/providers/model';
import { Composer, type ComposerHandle } from './composer';
import { useDispatch, useModels, useTopic } from './data';
import { effortOptions, threadTitle, titleFromMessage } from './model';
import { ModelBar, useModelBarKeys, type ModelBarHandle } from './model-bar';
import type { ThreadSettingsValue } from './thread-settings';
import { lastUsedThread, providerLabel, recentFolders, starterSkills } from './view-model';
import { DraftWorkingCopy, draftCopyOn, draftCopyStore, useWorkingCopyPlan } from './working-copy';

// What a new thread on this instance starts with: what its project names (agent workbench spec
// 97, when the project names this instance or none), else what the last thread on it used (owner
// decision F-5), else the instance defaults, else what the provider names as its default model
// and the model's default effort (agent workbench spec 7, 8), else the first model the provider
// lists and the first effort and permission mode offered for it.
export function threadDefaults(
  instance: ProviderInstance,
  models: readonly ProviderModel[],
  last: Pick<Thread, 'providerInstanceId' | 'model' | 'effort' | 'permissionMode'> | undefined,
  project?: ProjectDefaults,
): ThreadSettingsValue {
  const named =
    project &&
    (project.defaultProviderInstanceId ?? instance.id) === instance.id &&
    // A model the instance does not list (named for another kind of provider) is not used.
    (!project.defaultModel ||
      models.length === 0 ||
      models.some((model) => model.id === project.defaultModel))
      ? project
      : undefined;
  const fromLast = last?.providerInstanceId === instance.id ? last : undefined;
  const model =
    named?.defaultModel ||
    fromLast?.model ||
    instance.defaultModel ||
    models.find((candidate) => candidate.isDefault)?.id ||
    models[0]?.id ||
    '';
  const effort =
    named?.defaultEffort ||
    fromLast?.effort ||
    instance.defaultEffort ||
    models.find((candidate) => candidate.id === model)?.defaultEffort ||
    effortOptions(instance.kind, models, model, '')[0] ||
    'default';
  const permissionMode =
    named?.defaultPermissionMode ||
    fromLast?.permissionMode ||
    instance.defaultPermissionMode ||
    providerChatOptions[instance.kind].permissionModes[0]?.id ||
    'default';
  return { model, effort, permissionMode };
}

export type ProjectDefaults = Pick<
  Project,
  'defaultProviderInstanceId' | 'defaultModel' | 'defaultEffort' | 'defaultPermissionMode'
>;

const statusDot: Readonly<Record<ProviderInstance['status'], string>> = {
  ready: 'bg-state-done',
  error: 'bg-state-failed',
  unknown: 'bg-muted-foreground/50',
};

const statusText = (instance: ProviderInstance): string =>
  instance.status === 'ready'
    ? `Ready${instance.account ? ` · ${instance.account}` : ''}`
    : instance.status === 'error'
      ? `Last test failed${instance.statusMessage ? `: ${instance.statusMessage}` : ''}`
      : 'Not tested yet';

// Picker values: a project, a folder used before, or "Another folder…".
const OTHER = 'other';
const projectValue = (id: string) => `project:${id}`;
const folderValue = (path: string) => `folder:${path}`;
const baseName = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .at(-1) || path;

export function NewThreadView() {
  const { draft, pickFolder } = useRuntime();
  const send = useDispatch();
  const navigate = useNavigate();
  const instances = useTopic('providerInstances');
  const projects = useTopic('projects') ?? [];
  const threads = useTopic('threads') ?? [];
  const skills = useTopic('skills') ?? [];
  const backlog = useTopic('backlogItems') ?? [];
  const starterCount = useSetting('chat.starterCount');
  const skillTrigger = useSetting('chat.skillTrigger');
  const picked = useStore(draft);
  const composer = useRef<ComposerHandle>(null);
  const bar = useRef<ModelBarHandle>(null);
  const barKeys = useModelBarKeys(bar);
  const [typingFolder, setTypingFolder] = useState(false);
  // Picked before the first message so pasted images are stored for the thread they go with.
  const [pendingThreadId] = useState(() => globalThis.crypto.randomUUID());
  // The first line of what is typed, for the branch the working copy line names.
  const [typed, setTyped] = useState('');
  const [overrides, setOverrides] = useState<
    Partial<ThreadSettingsValue> & { readonly for?: string }
  >({});

  const last = lastUsedThread(threads);
  const lastInstanceId = lastUsedInstanceId(threads, instances);
  // Nothing picked yet: the last thread's project, or its folder when it had none.
  const untouched = picked.projectId === undefined && picked.cwd === undefined;
  const projectId = untouched ? (last?.projectId ?? undefined) : picked.projectId;
  const project = projects.find((candidate) => candidate.id === projectId);
  const instance =
    instances?.find((candidate) => candidate.id === picked.providerInstanceId) ??
    instances?.find((candidate) => candidate.id === project?.defaultProviderInstanceId) ??
    instances?.find((candidate) => candidate.id === lastInstanceId) ??
    instances?.find((candidate) => candidate.status === 'ready') ??
    instances?.[0];
  const { models } = useModels(instance?.id);
  const seeded =
    picked.settings && picked.settings.providerInstanceId === instance?.id
      ? picked.settings
      : undefined;
  const defaults =
    instance &&
    (seeded
      ? { model: seeded.model, effort: seeded.effort, permissionMode: seeded.permissionMode }
      : threadDefaults(instance, models, last, project));

  const cwd = (untouched && !project ? last?.cwd : picked.cwd) ?? project?.cwd ?? '';
  const copyPlan = useWorkingCopyPlan(project?.id);
  const ownCopy = project !== undefined && draftCopyOn(copyPlan, picked.ownWorkingCopy);
  const copyOffered = project !== undefined && copyPlan?.status === 'ok';
  useEffect(() => {
    draftCopyStore.setState({ offered: copyOffered, on: ownCopy });
    return () => draftCopyStore.setState({ offered: false, on: false });
  }, [copyOffered, ownCopy]);
  const folders = recentFolders(threads, projects);
  const { for: overridesFor, ...picks } = overrides;
  const settings: ThreadSettingsValue | undefined =
    defaults && (overridesFor === instance?.id ? { ...defaults, ...picks } : defaults);

  // The work starts in the composer (audit A-11).
  const ready = instances !== undefined && instances.length > 0;
  useEffect(() => {
    if (!ready) return;
    // Text handed over from elsewhere (the assistant's "Open in Chat") starts the message.
    const { text } = draft.getState();
    if (text !== undefined) {
      draft.setState({ text: undefined });
      composer.current?.setText(text);
      return;
    }
    // The providers can arrive after the user has opened a picker; the focus stays where it is.
    const focused = document.activeElement;
    if (focused === null || focused === document.body) composer.current?.focus();
  }, [ready, draft]);

  if (instances && instances.length === 0) {
    return (
      <EmptyState
        icon={PlugIcon}
        title="Set up a provider to start a thread"
        description="wow runs Claude Code and Codex on your machine. Add an instance and test it, then come back here."
        action={
          <Button asChild size="sm">
            <Link to="/settings/$group" params={{ group: 'providers' }}>
              Set up a provider
            </Link>
          </Button>
        }
      />
    );
  }

  const blockedReason = !instance
    ? 'Pick a provider first'
    : cwd.trim() === ''
      ? 'Pick a project or a folder first'
      : settings?.model === ''
        ? 'Pick a model first'
        : undefined;

  const start = async (
    text: string,
    chosen?: readonly SkillRef[],
    _files?: readonly string[],
    images?: readonly SentImage[],
  ) => {
    if (!instance || !settings || blockedReason) throw new Error(blockedReason);
    const threadId = pendingThreadId;
    // Made already when its first message was refused (an image no longer stored): only the
    // message goes again.
    const made = threads.some((thread) => thread.id === threadId);
    if (!made)
      await send({
        type: 'thread.create',
        threadId,
        providerInstanceId: instance.id,
        ...(project ? { projectId: project.id } : {}),
        ...(ownCopy ? { ownWorkingCopy: true } : {}),
        cwd: cwd.trim(),
        title:
          titleFromMessage(text) ||
          (chosen ?? []).map((skill) => skill.name).join(' ') ||
          ((images ?? []).length > 0 ? 'Image' : ''),
        ...settings,
      });
    await send({
      type: 'thread.sendMessage',
      threadId,
      text,
      ...(chosen ? { skills: [...chosen] } : {}),
      ...(images && images.length > 0
        ? { attachments: images.map(({ id, name }) => (name ? { id, name } : { id })) }
        : {}),
    });
    draft.setState({
      projectId: undefined,
      cwd: undefined,
      providerInstanceId: undefined,
      settings: undefined,
      ownWorkingCopy: undefined,
    });
    await navigate({ to: '/chat/$threadId', params: { threadId } });
  };

  const choose = async (value: string) => {
    setTypingFolder(false);
    if (value.startsWith('project:')) {
      draft.setState({
        projectId: value.slice('project:'.length),
        cwd: undefined,
        ownWorkingCopy: undefined,
      });
    } else if (value.startsWith('folder:')) {
      draft.setState({ projectId: undefined, cwd: value.slice('folder:'.length) });
    } else if (value === OTHER) {
      if (!pickFolder) {
        setTypingFolder(true);
        return;
      }
      const folder = await pickFolder();
      if (folder) draft.setState({ projectId: undefined, cwd: folder });
    }
    composer.current?.focus();
  };

  const pickerValue = project
    ? projectValue(project.id)
    : cwd !== ''
      ? folderValue(cwd)
      : typingFolder
        ? OTHER
        : '';
  const folderChoices = [
    ...folders,
    ...(cwd !== '' && !project && !folders.includes(cwd) ? [cwd] : []),
  ];
  const recentThread = threads
    .filter((thread) => thread.state !== 'done')
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const openItems = backlog.filter((item) => item.state === 'idea').slice(0, starterCount);
  const starters = starterSkills(skills, starterCount);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-3 px-4 py-6">
        <h2 className="text-base font-medium">New thread</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          {instance && (
            <WithTooltip label={statusText(instance)}>
              <span
                tabIndex={0}
                aria-label={`Provider status: ${statusText(instance)}`}
                data-testid="provider-status"
                className={cn('size-2 shrink-0 rounded-full', statusDot[instance.status])}
              />
            </WithTooltip>
          )}
          <ChoiceSelect
            label="Provider instance"
            size="sm"
            className="w-auto data-[size=sm]:h-7"
            value={instance?.id ?? ''}
            placeholder="Pick a provider"
            choices={(instances ?? []).map((candidate) => ({
              value: candidate.id,
              label: providerLabel(candidate, instances ?? []),
            }))}
            onValueChange={(providerInstanceId) => draft.setState({ providerInstanceId })}
          />
          <Combobox
            label="Project"
            size="sm"
            className="h-7 w-48"
            value={pickerValue}
            placeholder="Pick a project"
            searchPlaceholder="Search projects and folders…"
            emptyText="No matching project or folder."
            choices={[
              ...projects.map((candidate) => ({
                value: projectValue(candidate.id),
                label: candidate.name,
              })),
              ...folderChoices.map((folder) => ({
                value: folderValue(folder),
                label: baseName(folder),
                detail: 'Folder',
              })),
              { value: OTHER, label: 'Another folder…' },
            ]}
            onValueChange={(value) => void choose(value)}
          />
        </div>
        {typingFolder ? (
          <Input
            aria-label="Folder"
            autoFocus
            placeholder="Full path of the folder the agent works in"
            value={picked.cwd ?? ''}
            onChange={(event) => draft.setState({ projectId: undefined, cwd: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                setTypingFolder(false);
                composer.current?.focus();
              }
            }}
            className="h-8 max-w-xl font-mono text-xs placeholder:font-sans"
          />
        ) : (
          cwd !== '' && (
            <div
              data-testid="new-thread-folder"
              className="flex min-w-0 items-center gap-1.5 text-muted-foreground"
            >
              <FolderOpenIcon aria-hidden className="size-3.5 shrink-0" />
              <PathText path={cwd} />
            </div>
          )
        )}
        {project && (
          <DraftWorkingCopy
            plan={copyPlan}
            on={ownCopy}
            title={titleFromMessage(typed)}
            threadId={pendingThreadId}
            onChange={(ownWorkingCopy) => draft.setState({ ownWorkingCopy })}
          />
        )}
        <Composer
          ref={composer}
          onTextChange={setTyped}
          providerKind={instance?.kind}
          running={false}
          disabled={!instance}
          blockedReason={blockedReason}
          placeholder={`What should the agent do? Type ${skillTrigger} to pick a skill.`}
          onSend={start}
          // The lists open under the box, so the provider and project pickers stay in view.
          listsBelow
          // The new thread's id is picked now, so its images are stored where it will be.
          imageTarget={
            instance && settings
              ? {
                  threadId: pendingThreadId,
                  providerInstanceId: instance.id,
                  model: settings.model,
                }
              : undefined
          }
          onBarKey={barKeys}
          bar={
            instance &&
            settings && (
              // The draft's picks; the thread is created with them (agent workbench spec 5).
              <ModelBar
                ref={bar}
                providerInstanceId={instance.id}
                kind={instance.kind}
                value={settings}
                defaults={{ model: instance.defaultModel, effort: instance.defaultEffort }}
                returnFocus={() => composer.current?.focus()}
                onChange={(changes) =>
                  setOverrides((current) => ({
                    ...(current.for === instance.id ? current : {}),
                    ...changes,
                    for: instance.id,
                  }))
                }
              />
            )
          }
        />
        {(starters.length > 0 || recentThread || openItems.length > 0) && (
          <section aria-label="Starters" className="flex flex-col gap-2 pt-1">
            {starters.length > 0 && instance && (
              <div className="flex flex-wrap items-center gap-1.5">
                <SparklesIcon aria-hidden className="size-3.5 text-muted-foreground" />
                {starters.map((skill) => (
                  <WithTooltip key={skill.id} label={skill.description || skill.name}>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => composer.current?.addSkill(skill)}
                    >
                      {skill.name}
                    </Button>
                  </WithTooltip>
                ))}
              </div>
            )}
            {openItems.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <ListTodoIcon aria-hidden className="size-3.5 text-muted-foreground" />
                {openItems.map((item) => (
                  <Button
                    key={item.id}
                    size="xs"
                    variant="ghost"
                    className="max-w-64"
                    onClick={() =>
                      composer.current?.setText(
                        item.body.trim() === '' ? item.title : `${item.title}\n\n${item.body}`,
                      )
                    }
                  >
                    <span className="truncate">{item.title}</span>
                  </Button>
                ))}
              </div>
            )}
            {recentThread && (
              <div className="flex items-center gap-1.5">
                <MessagesSquareIcon aria-hidden className="size-3.5 text-muted-foreground" />
                <Button asChild size="xs" variant="ghost" className="max-w-full">
                  <Link to="/chat/$threadId" params={{ threadId: recentThread.id }}>
                    <span className="truncate">Continue “{threadTitle(recentThread)}”</span>
                  </Link>
                </Button>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
