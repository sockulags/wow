import { DiscoveredProject, providerSetup, type Command, type Project } from '@wow/contracts';
import { FolderSearchIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { PathText } from '@/components/path-text';
import { EmptyState, LoadingState } from '@/components/states';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useRuntime } from '@/app/runtime';
import { errorMessage } from '@/chat/data';
import { useDateFormat } from '@/lib/format';
import { newProjectId, uniqueName } from './model';

const Answer = z.object({ projects: z.array(DiscoveredProject) });

export type Discovered =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly message: string }
  | { readonly state: 'ready'; readonly projects: readonly DiscoveredProject[] };

// The folders Claude and Codex worked in that are not projects yet, all checked to start with.
// Asked when `enabled` turns true, so the first-run wizard asks after creating the providers.
export function useDiscoveredProjects(enabled = true) {
  const { connection } = useRuntime();
  const [found, setFound] = useState<Discovered>({ state: 'loading' });
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!enabled) return undefined;
    if (!connection) {
      setFound({ state: 'failed', message: 'Not connected to the wow server' });
      return undefined;
    }
    let current = true;
    connection
      .request('projects.discover', {})
      .then((answer) => {
        if (!current) return;
        const { projects } = Answer.parse(answer);
        setFound({ state: 'ready', projects });
        setChecked(new Set(projects.map((project) => project.cwd)));
      })
      .catch((error: unknown) => {
        if (current) setFound({ state: 'failed', message: errorMessage(error) });
      });
    return () => {
      current = false;
    };
  }, [connection, enabled]);

  const offered = found.state === 'ready' ? found.projects : [];
  const chosen = offered.filter((project) => checked.has(project.cwd));
  const toggle = (cwd: string, on: boolean) =>
    setChecked((current) => {
      const next = new Set(current);
      if (on) next.add(cwd);
      else next.delete(cwd);
      return next;
    });
  const setAll = (on: boolean) =>
    setChecked(on ? new Set(offered.map((project) => project.cwd)) : new Set());
  // After a partial import, only what is left stays on offer.
  const keepOnly = (left: readonly DiscoveredProject[]) =>
    setFound({ state: 'ready', projects: left });
  return { found, offered, chosen, checked, toggle, setAll, keepOnly };
}

// Creates one project per chosen folder, named after it. Answers what failed.
export async function importFolders(
  send: (command: Command) => Promise<unknown>,
  chosen: readonly DiscoveredProject[],
  existing: readonly Project[],
): Promise<{ readonly imported: ReadonlySet<string>; readonly failed: readonly string[] }> {
  const names = existing.map((project) => project.name);
  const failed: string[] = [];
  const imported = new Set<string>();
  for (const project of chosen) {
    const name = uniqueName(project.name, names);
    try {
      await send({ type: 'project.create', projectId: newProjectId(), name, cwd: project.cwd });
      names.push(name);
      imported.add(project.cwd);
    } catch (error) {
      failed.push(`${project.cwd}: ${errorMessage(error)}`);
    }
  }
  return { imported, failed };
}

// "Claude, Codex · last used 2 days ago" (audit E-13).
export function sourceLine(project: DiscoveredProject, lastUsed: string | undefined): string {
  const kinds = [...new Set(project.sources.map((source) => providerSetup[source.kind].label))];
  return [kinds.join(', '), lastUsed && `last used ${lastUsed}`].filter(Boolean).join(' · ');
}

export function ImportList({
  discovered,
}: {
  discovered: ReturnType<typeof useDiscoveredProjects>;
}) {
  const { relative } = useDateFormat();
  const { found, offered, chosen, checked, toggle, setAll } = discovered;
  if (found.state === 'loading')
    return <LoadingState rows={3} compact label="Looking for folders" />;
  if (found.state === 'failed') {
    return (
      <p role="alert" className="text-xs text-destructive">
        {found.message}
      </p>
    );
  }
  if (offered.length === 0) {
    return (
      <EmptyState
        compact
        icon={FolderSearchIcon}
        title="Nothing new to import"
        description="Every folder Claude and Codex worked in is a project already, or no longer exists."
      />
    );
  }
  const all = chosen.length === offered.length;
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border pb-2">
        <Checkbox
          id="import-all"
          checked={all ? true : chosen.length === 0 ? false : 'indeterminate'}
          onCheckedChange={(state) => setAll(state === true)}
        />
        <Label htmlFor="import-all" className="text-xs font-normal text-muted-foreground">
          {chosen.length} of {offered.length} selected
        </Label>
      </div>
      <ul aria-label="Folders to import" className="flex min-w-0 flex-col">
        {offered.map((project, index) => {
          const id = `import-project-${index}`;
          return (
            <li
              key={project.cwd}
              className="flex min-w-0 items-start gap-3 border-b border-border py-2 last:border-b-0"
            >
              <Checkbox
                id={id}
                className="mt-0.5"
                checked={checked.has(project.cwd)}
                onCheckedChange={(state) => toggle(project.cwd, state === true)}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Label htmlFor={id} className="font-medium">
                  {project.name}
                </Label>
                <PathText path={project.cwd} className="text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  {sourceLine(
                    project,
                    project.lastUsedAt === null ? undefined : relative(project.lastUsedAt),
                  )}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
