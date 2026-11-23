import { WorkflowFileResult, type Skill } from '@wow/contracts';
import { FileTextIcon } from 'lucide-react';
import { useState } from 'react';
import { useRuntime } from '@/app/runtime';
import { errorMessage, useTopic } from '@/chat/data';
import { PathText } from '@/components/path-text';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { notify } from '@/lib/feedback';

// Settings › Workflows (orchestrator threads spec 23): the workflow files wow reads, where each
// is, a way to open one in your editor, and "New workflow" from `workflows.newTemplate`.

const none: Skill[] = [];

export const workflowFiles = (skills: readonly Skill[]): Skill[] =>
  skills
    .filter((skill) => skill.source === 'workflow' || skill.source === 'project-workflow')
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

export function WorkflowFilesSection() {
  const { connection } = useRuntime();
  const files = workflowFiles(useTopic('skills') ?? none);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const open = (path: string) => {
    if (!connection) return;
    connection
      .request('workflowFiles.open', { path })
      .catch((failure: unknown) =>
        notify.error('Not opened in your editor', { description: errorMessage(failure) }),
      );
  };
  const create = async () => {
    if (!connection || name.trim() === '') return;
    setBusy(true);
    try {
      const made = WorkflowFileResult.parse(
        await connection.request('workflowFiles.create', { name: name.trim() }),
      );
      setName('');
      open(made.path);
    } catch (failure) {
      notify.error('No workflow was made', { description: errorMessage(failure) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Workflow files" className="mt-4 flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        A workflow is a Markdown file the main agent follows when you start it with /name in a
        thread. Yours are in wow&apos;s workflows folder; a project&apos;s in its .wow/workflows,
        and one there replaces yours of the same name in that project&apos;s threads.
      </p>
      {files.length === 0 ? (
        <p className="text-xs text-muted-foreground">No workflow files yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {files.map((file) => (
            <li key={file.id} className="flex min-w-0 items-center gap-2 text-sm">
              <FileTextIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="font-medium">{file.name}</span>
              <span className="text-xs text-muted-foreground">
                {file.source === 'workflow' ? 'Yours' : 'Project'}
              </span>
              <PathText path={file.id} className="min-w-0 flex-1 truncate text-xs" />
              <Button size="xs" variant="ghost" onClick={() => open(file.id)}>
                Open in editor
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <Input
          aria-label="New workflow name"
          placeholder="Name of a new workflow"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="max-w-xs"
        />
        <Button type="submit" size="sm" disabled={!connection || busy || name.trim() === ''}>
          New workflow
        </Button>
      </form>
    </section>
  );
}
