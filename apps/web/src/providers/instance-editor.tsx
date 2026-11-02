import {
  DetectedProvider,
  SecretRef,
  providerChatOptions,
  providerSetup,
  type ProviderInstance,
} from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import { PlusIcon, SearchIcon, XIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { ChoiceSelect } from '@/components/choice-select';
import { SuggestInput } from '@/components/combobox';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRuntime } from '@/app/runtime';
import { errorMessage, useModels } from '@/chat/data';
import {
  draftIssues,
  draftToCommand,
  newInstanceId,
  type EnvRow,
  type InstanceDraft,
} from './model';

function FormRow({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function EnvEditor({
  rows,
  onChange,
}: {
  rows: readonly EnvRow[];
  onChange: (rows: EnvRow[]) => void;
}) {
  const update = (index: number, patch: Partial<EnvRow>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <div role="group" aria-label="Environment variables" className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">Environment variables</span>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <Input
            aria-label={`Variable ${index + 1} name`}
            placeholder="NAME"
            className="font-mono"
            value={row.key}
            onChange={(event) => update(index, { key: event.target.value })}
          />
          <Input
            aria-label={`Variable ${index + 1} value`}
            type={row.secret ? 'password' : 'text'}
            placeholder={row.stored ? 'Stored. Type to replace.' : 'value'}
            className="font-mono"
            value={row.value}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <Label className="shrink-0 font-normal">
            <Checkbox
              aria-label={`Variable ${index + 1} secret`}
              checked={row.secret}
              onCheckedChange={(next) => update(index, { secret: next === true })}
            />
            Secret
          </Label>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove variable ${index + 1}`}
            onClick={() => onChange(rows.filter((_, at) => at !== index))}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() =>
          onChange([...rows, { key: '', value: '', secret: false, stored: undefined }])
        }
      >
        <PlusIcon />
        Add variable
      </Button>
      <p className="text-xs text-muted-foreground">
        Secret values are encrypted in the wow secret store and never shown again.
      </p>
    </div>
  );
}

export interface InstanceEditorProps {
  // Absent when adding a new instance.
  readonly instance: ProviderInstance | undefined;
  readonly initial: InstanceDraft;
  readonly onClose: () => void;
}

export function InstanceEditor({ instance, initial, onClose }: InstanceEditorProps) {
  const { connection } = useRuntime();
  const [providerInstanceId] = useState(() => instance?.id ?? newInstanceId(initial.kind));
  const [draft, setDraft] = useState(initial);
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [saving, setSaving] = useState(false);
  const [detectNote, setDetectNote] = useState<string>();
  const { models } = useModels(instance?.id);
  const id = useId();
  const setup = providerSetup[draft.kind];
  const options = providerChatOptions[draft.kind];
  const efforts = models.find((model) => model.id === draft.defaultModel)?.efforts ?? [];
  const set = (patch: Partial<InstanceDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const detect = async () => {
    if (!connection) return;
    setDetectNote(undefined);
    try {
      const found = DetectedProvider.array()
        .parse(await connection.request('provider.detect', {}))
        .find((entry) => entry.kind === draft.kind);
      if (found?.binaryPath) {
        set({
          binaryPath: found.binaryPath,
          configDir: draft.configDir === '' ? found.configDir : draft.configDir,
        });
        setDetectNote(`Found ${found.binaryPath}`);
      } else {
        setDetectNote(`${setup.binaryName} is not on the server's PATH.`);
      }
    } catch (error) {
      setDetectNote(errorMessage(error));
    }
  };

  const save = async () => {
    const local = draftIssues(draft);
    setIssues(local);
    if (local.length > 0 || !connection) return;
    setSaving(true);
    try {
      const command = await draftToCommand(
        draft,
        providerInstanceId,
        instance,
        async (name, value) =>
          SecretRef.parse(await connection.request('secrets.set', { name, value })),
      );
      await dispatch(connection, command);
      onClose();
    } catch (error) {
      setIssues([errorMessage(error)]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {instance ? `Edit ${instance.name}` : `Add ${setup.label} instance`}
          </DialogTitle>
          <DialogDescription>
            One {setup.binaryName} binary with its own config directory and environment. Add several
            to use different accounts.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <FormRow label="Name" htmlFor={`${id}-name`}>
            <Input
              id={`${id}-name`}
              value={draft.name}
              onChange={(event) => set({ name: event.target.value })}
            />
          </FormRow>
          <FormRow
            label="Binary path"
            htmlFor={`${id}-binary`}
            hint={detectNote ?? `Empty uses ${setup.binaryName} from the server's PATH.`}
          >
            <div className="flex gap-1.5">
              <Input
                id={`${id}-binary`}
                className="font-mono"
                placeholder={setup.binaryName}
                value={draft.binaryPath}
                onChange={(event) => set({ binaryPath: event.target.value })}
              />
              <Button type="button" variant="outline" onClick={() => void detect()}>
                <SearchIcon />
                Detect
              </Button>
            </div>
          </FormRow>
          <FormRow
            label={`Config directory (${setup.configDirEnv})`}
            htmlFor={`${id}-config`}
            hint={`Empty uses ~/${setup.defaultConfigDir}. Threads resume only on an instance with the same directory.`}
          >
            <Input
              id={`${id}-config`}
              className="font-mono"
              value={draft.configDir}
              onChange={(event) => set({ configDir: event.target.value })}
            />
          </FormRow>
          <EnvEditor rows={draft.env} onChange={(env) => set({ env })} />
          <FormRow
            label="Launch arguments"
            htmlFor={`${id}-args`}
            hint="One argument per line, for example --flag=value."
          >
            <textarea
              id={`${id}-args`}
              aria-label="Launch arguments"
              rows={3}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
              value={draft.launchArgs}
              onChange={(event) => set({ launchArgs: event.target.value })}
            />
          </FormRow>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormRow
              label="Default model"
              htmlFor={`${id}-model`}
              hint={instance ? undefined : 'Models are listed after the first test.'}
            >
              <SuggestInput
                id={`${id}-model`}
                label="Default model"
                value={draft.defaultModel}
                emptyText="No models listed yet."
                suggestions={models.map((model) => ({
                  value: model.id,
                  label: model.label || model.id,
                }))}
                onValueChange={(defaultModel) => set({ defaultModel })}
              />
            </FormRow>
            <FormRow label="Default effort" htmlFor={`${id}-effort`}>
              <SuggestInput
                id={`${id}-effort`}
                label="Default effort"
                value={draft.defaultEffort}
                suggestions={[
                  ...new Set([
                    ...(options.defaultEffort ? [options.defaultEffort] : []),
                    ...efforts,
                  ]),
                ].map((effort) => ({ value: effort, label: effort }))}
                onValueChange={(defaultEffort) => set({ defaultEffort })}
              />
            </FormRow>
            <FormRow label="Default permission mode" htmlFor={`${id}-permission`}>
              <ChoiceSelect
                id={`${id}-permission`}
                label="Default permission mode"
                value={draft.defaultPermissionMode}
                choices={[
                  { value: '', label: 'Provider default' },
                  ...options.permissionModes.map((mode) => ({ value: mode.id, label: mode.label })),
                ]}
                onValueChange={(defaultPermissionMode) => set({ defaultPermissionMode })}
              />
            </FormRow>
          </div>
          {issues.length > 0 && (
            <ul role="alert" className="text-xs text-destructive">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !connection}>
              {instance ? 'Save' : 'Add instance'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
