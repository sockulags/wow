import type { Project } from '@wow/contracts';
import { useId, useState, type ReactNode } from 'react';
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
import { Label } from '@/components/ui/label';
import { useLayout, useRuntime } from '@/app/runtime';
import { errorMessage, useDispatch, useTopic } from '@/chat/data';

export const newProjectId = () => `project-${globalThis.crypto.randomUUID().slice(0, 8)}`;

function Issue({ text }: { text: string | undefined }) {
  if (!text) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {text}
    </p>
  );
}

function Row({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
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

function CreateProject({ onClose }: { onClose: () => void }) {
  const send = useDispatch();
  const id = useId();
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const { busy, issue, setIssue, submit } = useSubmit(onClose);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A name and a folder. Threads, cards and workflow runs in the project work in that
            folder.
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
          <Row label="Name" htmlFor={`${id}-name`}>
            <Input
              id={`${id}-name`}
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Row>
          <Row
            label="Folder"
            htmlFor={`${id}-folder`}
            hint="The full path of a folder on this computer, for example C:\Users\me\code\wow."
          >
            <Input
              id={`${id}-folder`}
              className="font-mono"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
            />
          </Row>
          <Issue text={issue} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
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
          <Row label="Name" htmlFor={`${id}-name`}>
            <Input
              id={`${id}-name`}
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Row>
          <Issue text={issue} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
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

function RemoveProject({ project, onClose }: { project: Project; onClose: () => void }) {
  const send = useDispatch();
  const { busy, issue, submit } = useSubmit(onClose);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {project.name}?</DialogTitle>
          <DialogDescription>
            The folder and its files stay. Threads keep working in the folder without a project.
            Cards lose the project, so their triggers will not fire. Finished runs keep their
            history. A project with a workflow run in progress cannot be removed.
          </DialogDescription>
        </DialogHeader>
        <Issue text={issue} />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Keep
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() =>
              void submit(() => send({ type: 'project.delete', projectId: project.id }))
            }
          >
            Remove project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const project = projects?.find((candidate) => candidate.id === dialog.projectId);
  if (!project) return null;
  return dialog.type === 'rename' ? (
    <RenameProject key={project.id} project={project} onClose={close} />
  ) : (
    <RemoveProject key={project.id} project={project} onClose={close} />
  );
}
