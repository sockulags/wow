import {
  DetectedProvider,
  SecretRef,
  providerChatOptions,
  providerSetup,
  type ProviderInstance,
} from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import { PlusIcon, SearchIcon, XIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { ChoiceSelect } from '@/components/choice-select';
import { FormField } from '@/components/form-field';
import { IconButton } from '@/components/hint';
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
import { Textarea } from '@/components/ui/textarea';
import { useRuntime } from '@/app/runtime';
import { errorMessage, useModels } from '@/chat/data';
import { notify } from '@/lib/feedback';
import {
  defaultChoiceLabel,
  draftIssues,
  draftToCommand,
  effortChoices,
  newInstanceId,
  testInstance,
  type EnvRow,
  type InstanceDraft,
} from './model';

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
    <div role="group" aria-label="Environment variables" className="flex min-w-0 flex-col gap-1.5">
      <span className="text-sm leading-none font-medium">Environment variables</span>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <Input
            aria-label={`Variable ${index + 1} name`}
            placeholder="Name"
            className="font-mono"
            value={row.key}
            onChange={(event) => update(index, { key: event.target.value })}
          />
          <Input
            aria-label={`Variable ${index + 1} value`}
            type={row.secret ? 'password' : 'text'}
            placeholder={row.stored ? 'Stored. Type to replace.' : 'Value'}
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
          <IconButton
            label={`Remove variable ${index + 1}`}
            size="icon"
            onClick={() => onChange(rows.filter((_, at) => at !== index))}
          >
            <XIcon />
          </IconButton>
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

type Detectable = 'binaryPath' | 'configDir';

export function InstanceEditor({ instance, initial, onClose }: InstanceEditorProps) {
  const { connection } = useRuntime();
  const [providerInstanceId] = useState(() => instance?.id ?? newInstanceId(initial.kind));
  const [draft, setDraft] = useState(initial);
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [saving, setSaving] = useState(false);
  const [detectNote, setDetectNote] = useState<string>();
  // Fields that hold what detection found, marked "Detected" until the user edits them.
  const [detected, setDetected] = useState<ReadonlySet<Detectable>>(new Set());
  const { models, error: modelsError } = useModels(instance?.id);
  const id = useId();
  const setup = providerSetup[draft.kind];
  const options = providerChatOptions[draft.kind];
  const set = (patch: Partial<InstanceDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const edit = (field: Detectable, value: string) => {
    set({ [field]: value });
    setDetected((current) => new Set([...current].filter((entry) => entry !== field)));
  };

  // Fills empty fields with what the server finds; `overwrite` (the Detect button) also replaces
  // a typed binary path.
  const detect = async (overwrite: boolean) => {
    if (!connection) return;
    try {
      const found = DetectedProvider.array()
        .parse(await connection.request('provider.detect', {}))
        .find((entry) => entry.kind === draft.kind);
      const binaryPath = found?.binaryPath;
      if (!found || !binaryPath) {
        if (overwrite) {
          setDetectNote(`${setup.binaryName} is not on the server's PATH. Enter its full path.`);
        }
        return;
      }
      const filled = new Set<Detectable>();
      if (overwrite || draft.binaryPath === '') filled.add('binaryPath');
      if (draft.configDir === '') filled.add('configDir');
      setDraft((current) => ({
        ...current,
        ...(filled.has('binaryPath') ? { binaryPath } : {}),
        ...(filled.has('configDir') ? { configDir: found.configDir } : {}),
      }));
      setDetected((current) => new Set([...current, ...filled]));
      if (overwrite) setDetectNote(`Found ${binaryPath}.`);
    } catch (error) {
      if (overwrite) setDetectNote(errorMessage(error));
    }
  };

  // What the server can find is filled in as soon as the editor opens (audit E-03).
  const [detectOnOpen] = useState(() => initial.binaryPath === '' || initial.configDir === '');
  useEffect(() => {
    if (detectOnOpen) void detect(false);
    // Runs once per opened editor, against the draft it opened with.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [detectOnOpen]);

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
      // Test right away, so the row says Ready, or why not, without another click.
      const name = draft.name.trim();
      void testInstance(connection, providerInstanceId).then((result) => {
        if (!result.ok) {
          notify.error(`${name} did not pass its test`, {
            description: result.message ?? 'Open it in Settings → Providers to see why.',
          });
        }
      });
    } catch (error) {
      setIssues([errorMessage(error)]);
    } finally {
      setSaving(false);
    }
  };

  const modelChoices = [
    { value: '', label: defaultChoiceLabel(draft.kind) },
    ...models.map((model) => ({ value: model.id, label: model.label || model.id })),
    // A stored model the provider no longer lists stays selectable.
    ...(draft.defaultModel !== '' && !models.some((model) => model.id === draft.defaultModel)
      ? [{ value: draft.defaultModel, label: draft.defaultModel }]
      : []),
  ];
  const modelHelp = !instance
    ? 'More models are listed once the instance is saved and tested.'
    : modelsError
      ? `Models could not be listed: ${modelsError}`
      : undefined;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {instance ? `Edit ${instance.name}` : `Add ${setup.label} instance`}
          </DialogTitle>
          <DialogDescription>
            One {setup.binaryName} binary with its own config folder and environment. Add several to
            use different accounts.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <FormField id={`${id}-name`} label="Name">
            <Input value={draft.name} onChange={(event) => set({ name: event.target.value })} />
          </FormField>
          <div className="flex min-w-0 items-end gap-1.5">
            <FormField
              id={`${id}-binary`}
              label="Binary path"
              className="flex-1"
              source={detected.has('binaryPath') ? 'Detected' : undefined}
              help={detectNote ?? `Empty uses ${setup.binaryName} from the server's PATH.`}
            >
              <Input
                className="font-mono"
                placeholder={`${setup.binaryName} from PATH`}
                value={draft.binaryPath}
                onChange={(event) => edit('binaryPath', event.target.value)}
              />
            </FormField>
            <Button
              type="button"
              variant="outline"
              className="mb-5"
              onClick={() => void detect(true)}
            >
              <SearchIcon />
              Detect
            </Button>
          </div>
          <FormField
            id={`${id}-config`}
            label="Config folder"
            source={detected.has('configDir') ? 'Detected' : undefined}
            help={`Sets ${setup.configDirEnv}. Empty uses ~/${setup.defaultConfigDir}. Threads resume only on an instance with the same folder.`}
          >
            <Input
              className="font-mono"
              placeholder={`~/${setup.defaultConfigDir}`}
              value={draft.configDir}
              onChange={(event) => edit('configDir', event.target.value)}
            />
          </FormField>
          <EnvEditor rows={draft.env} onChange={(env) => set({ env })} />
          <FormField
            id={`${id}-args`}
            label="Launch arguments"
            help="One argument per line, for example --flag=value."
          >
            <Textarea
              rows={3}
              className="font-mono"
              value={draft.launchArgs}
              onChange={(event) => set({ launchArgs: event.target.value })}
            />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField id={`${id}-model`} label="Default model" help={modelHelp}>
              <ChoiceSelect
                value={draft.defaultModel}
                choices={modelChoices}
                onValueChange={(defaultModel) => set({ defaultModel, defaultEffort: '' })}
              />
            </FormField>
            <FormField id={`${id}-effort`} label="Default effort">
              <ChoiceSelect
                value={draft.defaultEffort}
                choices={effortChoices(
                  draft.kind,
                  models,
                  draft.defaultModel,
                  draft.defaultEffort,
                  options.defaultEffort,
                )}
                onValueChange={(defaultEffort) => set({ defaultEffort })}
              />
            </FormField>
            <FormField id={`${id}-permission`} label="Default permissions">
              <ChoiceSelect
                value={draft.defaultPermissionMode}
                choices={[
                  { value: '', label: defaultChoiceLabel(draft.kind) },
                  ...options.permissionModes.map((mode) => ({ value: mode.id, label: mode.label })),
                ]}
                onValueChange={(defaultPermissionMode) => set({ defaultPermissionMode })}
              />
            </FormField>
          </div>
          {issues.length > 0 && (
            <ul role="alert" className="text-xs text-destructive">
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
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
