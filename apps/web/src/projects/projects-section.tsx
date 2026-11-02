import type { Project } from '@wow/contracts';
import { PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRuntime } from '@/app/runtime';
import { useTopic } from '@/chat/data';

function ProjectRow({ project }: { project: Project }) {
  const { layout } = useRuntime();
  return (
    <li
      aria-label={project.name}
      className="flex flex-wrap items-center gap-2 border-b border-border py-3 last:border-b-0"
    >
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-medium">{project.name}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{project.cwd}</span>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            layout.setState({ projectDialog: { type: 'rename', projectId: project.id } })
          }
        >
          <PencilIcon />
          Rename
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            layout.setState({ projectDialog: { type: 'remove', projectId: project.id } })
          }
        >
          <Trash2Icon />
          Remove
        </Button>
      </div>
    </li>
  );
}

// Settings → Projects: the projects every picker offers, and the way to add, rename and remove
// them. The rows come from the server's projects topic.
export function ProjectsSection() {
  const { connection, layout } = useRuntime();
  const projects = useTopic('projects');

  return (
    <section aria-label="Projects" className="flex flex-col gap-2 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">
          A project is a name and a folder. Threads, cards and workflow runs work in its folder.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={!connection}
          onClick={() => layout.setState({ projectDialog: { type: 'create' } })}
        >
          <PlusIcon />
          New project
        </Button>
      </div>
      {!connection && (
        <p className="text-xs text-muted-foreground">
          Projects live on the wow server; this window is not connected to one.
        </p>
      )}
      {connection && projects?.length === 0 && (
        <p className="text-xs text-muted-foreground">No projects yet.</p>
      )}
      {projects && projects.length > 0 && (
        <ul className="flex flex-col">
          {projects.map((project) => (
            <ProjectRow key={project.id} project={project} />
          ))}
        </ul>
      )}
    </section>
  );
}
