import { DiscoveredProject, providerSetup } from '@wow/contracts';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
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
import { Label } from '@/components/ui/label';
import { useRuntime } from '@/app/runtime';
import { errorMessage, useDispatch, useTopic } from '@/chat/data';
import { newProjectId, uniqueName } from './model';

const Answer = z.object({ projects: z.array(DiscoveredProject) });

type Found =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly message: string }
  | { readonly state: 'ready'; readonly projects: readonly DiscoveredProject[] };

const lastUsed = (at: string | null) => (at === null ? null : new Date(at).toLocaleDateString());

// "Import from Claude and Codex": the folders the configured provider instances worked in that
// are not projects yet, as a checklist. Each checked folder becomes a project named after it.
export function ImportProjects({ onClose }: { onClose: () => void }) {
  const { connection } = useRuntime();
  const send = useDispatch();
  const existing = useTopic('projects') ?? [];
  const [found, setFound] = useState<Found>({ state: 'loading' });
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!connection) {
      setFound({ state: 'failed', message: 'Not connected to the wow server' });
      return;
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
  }, [connection]);

  const offered = found.state === 'ready' ? found.projects : [];
  const chosen = offered.filter((project) => checked.has(project.cwd));

  const toggle = (cwd: string, on: boolean) =>
    setChecked((current) => {
      const next = new Set(current);
      if (on) next.add(cwd);
      else next.delete(cwd);
      return next;
    });

  const importChosen = async () => {
    setBusy(true);
    setFailures([]);
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
    setBusy(false);
    if (failed.length === 0) {
      onClose();
      return;
    }
    setFailures(failed);
    setFound({ state: 'ready', projects: offered.filter((entry) => !imported.has(entry.cwd)) });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import from Claude and Codex</DialogTitle>
          <DialogDescription>
            Folders your Claude and Codex instances have worked in that are not projects yet. Each
            one you keep checked becomes a project named after its folder.
          </DialogDescription>
        </DialogHeader>
        {found.state === 'loading' && (
          <p className="text-sm text-muted-foreground">Looking through the session history…</p>
        )}
        {found.state === 'failed' && (
          <p role="alert" className="text-xs text-destructive">
            {found.message}
          </p>
        )}
        {found.state === 'ready' && offered.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nothing new to import: every folder Claude and Codex worked in is a project already, or
            no longer exists.
          </p>
        )}
        {offered.length > 0 && (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                {chosen.length} of {offered.length} selected
              </span>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="ml-auto h-auto p-0 text-xs"
                onClick={() => setChecked(new Set(offered.map((project) => project.cwd)))}
              >
                Select all
              </Button>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => setChecked(new Set())}
              >
                Select none
              </Button>
            </div>
            <ul aria-label="Folders to import" className="flex flex-col">
              {offered.map((project, index) => {
                const id = `import-project-${index}`;
                const used = lastUsed(project.lastUsedAt);
                return (
                  <li
                    key={project.cwd}
                    className="flex items-start gap-3 border-b border-border py-2 last:border-b-0"
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
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {project.cwd}
                      </span>
                      <div className="flex flex-wrap items-center gap-1">
                        {project.sources.map((source) => (
                          <Badge key={source.providerInstanceId} variant="secondary">
                            {providerSetup[source.kind].label}: {source.providerInstanceName}
                          </Badge>
                        ))}
                        {used && (
                          <span className="text-xs text-muted-foreground">Last used {used}</span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {failures.length > 0 && (
          <ul role="alert" className="text-xs text-destructive">
            {failures.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || chosen.length === 0}
            onClick={() => void importChosen()}
          >
            {chosen.length === 1 ? 'Import 1 project' : `Import ${chosen.length} projects`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
