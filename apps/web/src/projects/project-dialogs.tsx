import type { Project } from '@wow/contracts';
import { FolderOpenIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { ChoiceSelect } from '@/components/choice-select';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormField } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useLayout, useRuntime } from '@/app/runtime';
import { errorMessage, useDispatch, useTopic } from '@/chat/data';
import { ThreadSettings, type ThreadSettingsValue } from '@/chat/thread-settings';
import { providerLabel } from '@/chat/view-model';
import { ImportProjects } from './import-dialog';
import { notify } from '@/lib/feedback';
import { folderName, newProjectId } from './model';

function Issue({ text }: { text: string | undefined }) {
  if (!text) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {text}
    </p>
  );
}

// The server answers whether the folder exists; the dialog stays open with its message if not.
function useSubmit(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string>();
  const submit = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setIssue(undefined);
    try {
      await action();
      onDone();
    } catch (error) {
      setIssue(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return { busy, issue, setIssue, submit };
}

// In the desktop app the folder comes from the system dialog, so it is always one that exists;
// the browser build has no such dialog and takes a typed path.
function FolderField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (cwd: string) => void;
}) {
  const { pickFolder } = useRuntime();
  if (!pickFolder) {
    return (
      <FormField
        id={id}
        label="Folder"
        help="The full path of a folder on this computer, for example C:\Users\me\code\wow."
      >
        <Input
          autoFocus
          className="font-mono"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </FormField>
    );
  }
  return (
    <div className="flex min-w-0 items-end gap-1.5">
      <FormField id={id} label="Folder" className="flex-1">
        <Input
          readOnly
          className="font-mono"
          placeholder="No folder chosen"
          value={value}
          onClick={() => void pickFolder().then((picked) => picked && onChange(picked))}
        />
      </FormField>
      <Button
        type="button"
        variant="outline"
        autoFocus
        onClick={() => void pickFolder().then((picked) => picked && onChange(picked))}
      >
        <FolderOpenIcon />
        Choose folder…
      </Button>
    </div>
  );
}

function CreateProject({ onClose }: { onClose: () => void }) {
  const send = useDispatch();
  const id = useId();
  const [name, setName] = useState('');
  // The name follows the folder until the user types one (audit E-12).
  const [named, setNamed] = useState(false);
  const [cwd, setCwd] = useState('');
  const { busy, issue, setIssue, submit } = useSubmit(onClose);
  const chooseFolder = (folder: string) => {
    setCwd(folder);
    if (!named) setName(folderName(folder));
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A folder on this computer. Threads, cards and workflow runs in the project work in it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() === '' || cwd.trim() === '') {
              setIssue('Give the project a name and a folder');
              return;
            }
            void submit(() =>
              send({
                type: 'project.create',
                projectId: newProjectId(),
                name: name.trim(),
                cwd: cwd.trim(),
              }),
            );
          }}
        >
          <FolderField id={`${id}-folder`} value={cwd} onChange={chooseFolder} />
          <FormField
            id={`${id}-name`}
            label="Name"
            help={named ? undefined : 'Taken from the folder. Change it if you like.'}
          >
            <Input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setNamed(true);
              }}
            />
          </FormField>
          <Issue text={issue} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Add project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameProject({ project, onClose }: { project: Project; onClose: () => void }) {
  const send = useDispatch();
  const id = useId();
  const [name, setName] = useState(project.name);
  const { busy, issue, setIssue, submit } = useSubmit(onClose);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename {project.name}</DialogTitle>
          <DialogDescription>
            Threads, cards and runs follow the project, so they show the new name.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() === '') {
              setIssue('Give the project a name');
              return;
            }
            void submit(() =>
              send({ type: 'project.update', projectId: project.id, name: name.trim() }),
            );
          }}
        >
          <FormField id={`${id}-name`} label="Name">
            <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
          </FormField>
          <Issue text={issue} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// What a new thread in the project starts from (agent workbench spec 97): a provider instance
// and, for it, a model, an effort and a mode. Left empty, a new thread starts as the last one did.
function ProjectDefaults({ project, onClose }: { project: Project; onClose: () => void }) {
  const send = useDispatch();
  const id = useId();
  const loaded = useTopic('providerInstances');
  const instances = loaded ?? [];
  const [chosen, setInstanceId] = useState(project.defaultProviderInstanceId ?? '');
  // An instance removed since reads as none, so Save does not write its id back.
  const instanceId =
    loaded === undefined || instances.some((candidate) => candidate.id === chosen) ? chosen : '';
  const [value, setValue] = useState<ThreadSettingsValue>({
    model: project.defaultModel ?? '',
    effort: project.defaultEffort ?? '',
    permissionMode: project.defaultPermissionMode ?? '',
  });
  const { busy, issue, submit } = useSubmit(onClose);
  const instance = instances.find((candidate) => candidate.id === instanceId);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New thread defaults for {project.name}</DialogTitle>
          <DialogDescription>
            A new thread in this project starts with these. Without them it starts as your last
            thread did.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(() =>
              send({
                type: 'project.update',
                projectId: project.id,
                defaultProviderInstanceId: orNull(instanceId),
                defaultModel: instance ? orNull(value.model) : null,
                defaultEffort: instance ? orNull(value.effort) : null,
                defaultPermissionMode: instance ? orNull(value.permissionMode) : null,
              }),
            );
          }}
        >
          <FormField id={`${id}-agent`} label="Agent" group>
            <div className="flex flex-wrap items-center gap-1.5">
              <ChoiceSelect
                label="Default provider instance"
                size="sm"
                className="w-auto data-[size=sm]:h-7"
                value={instanceId === '' ? noInstance : instanceId}
                choices={[
                  { value: noInstance, label: 'As the last thread' },
                  ...instances.map((candidate) => ({
                    value: candidate.id,
                    label: providerLabel(candidate, instances),
                  })),
                ]}
                onValueChange={(picked) => {
                  setInstanceId(picked === noInstance ? '' : picked);
                  setValue({ model: '', effort: '', permissionMode: '' });
                }}
              />
              {instance && (
                <ThreadSettings
                  providerInstanceId={instance.id}
                  kind={instance.kind}
                  defaults={{ model: instance.defaultModel, effort: instance.defaultEffort }}
                  value={value}
                  onChange={(changes) => setValue((current) => ({ ...current, ...changes }))}
                />
              )}
            </div>
          </FormField>
          <Issue text={issue} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const noInstance = 'none';
const orNull = (text: string) => (text === '' ? null : text);

// Removing a project unlinks its cards and threads, which Undo could not link again, so it asks
// first (owner decision F-9: confirm only what cannot be undone).
function RemoveProject({ project, onClose }: { project: Project; onClose: () => void }) {
  const send = useDispatch();
  return (
    <ConfirmDialog
      open
      title={`Remove ${project.name}?`}
      description="The folder and its files stay. Threads keep working in the folder without a project, cards lose the project so their triggers will not fire, and finished runs keep their history."
      confirmLabel="Remove"
      onCancel={onClose}
      onConfirm={() => {
        onClose();
        send({ type: 'project.delete', projectId: project.id }).then(
          () => notify.success(`${project.name} removed`),
          (error: unknown) =>
            notify.error(`${project.name} was not removed`, { description: errorMessage(error) }),
        );
      }}
    />
  );
}

// Renders whichever project dialog Settings → Projects or a palette command asked for.
export function ProjectDialogs() {
  const { layout } = useRuntime();
  const dialog = useLayout((state) => state.projectDialog);
  const projects = useTopic('projects');
  const close = () => layout.setState({ projectDialog: undefined });
  if (!dialog) return null;
  if (dialog.type === 'create') return <CreateProject onClose={close} />;
  if (dialog.type === 'import') return <ImportProjects onClose={close} />;
  const project = projects?.find((candidate) => candidate.id === dialog.projectId);
  if (!project) return null;
  if (dialog.type === 'defaults')
    return <ProjectDefaults key={project.id} project={project} onClose={close} />;
  return dialog.type === 'rename' ? (
    <RenameProject key={project.id} project={project} onClose={close} />
  ) : (
    <RemoveProject key={project.id} project={project} onClose={close} />
  );
}
