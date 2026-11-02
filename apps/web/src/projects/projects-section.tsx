import type { Project } from '@wow/contracts';
import { DownloadIcon, FolderIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { PathText } from '@/components/path-text';
import { EmptyState, Stale, TopicPlaceholder } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useRuntime } from '@/app/runtime';
import { useTopicState } from '@/app/topic-state';
import { useTopic } from '@/chat/data';

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// "3 threads · 1 card", from the server's rows (audit E-12).
export function projectUsage(
  projectId: string,
  threads: readonly { projectId: string | null }[] | undefined,
  items: readonly { projectId: string | null; source: string }[] | undefined,
): string | undefined {
  if (!threads || !items) return undefined;
  const threadCount = threads.filter((thread) => thread.projectId === projectId).length;
  const cardCount = items.filter(
    (item) => item.source === 'local' && item.projectId === projectId,
  ).length;
  return `${plural(threadCount, 'thread', 'threads')} · ${plural(cardCount, 'card', 'cards')}`;
}

function ProjectRow({ project, usage }: { project: Project; usage: string | undefined }) {
  const { layout } = useRuntime();
  return (
    <li
      aria-label={project.name}
      className="flex min-w-0 items-center gap-3 border-b border-border py-3 last:border-b-0"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{project.name}</span>
        <PathText path={project.cwd} copy className="text-muted-foreground" />
        {usage && <span className="text-xs text-muted-foreground">{usage}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
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
          className="text-destructive hover:text-destructive"
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
// them. The rows come from the server's projects topic. Same header pattern as Providers.
export function ProjectsSection() {
  const { connection, layout } = useRuntime();
  const { rows: projects, status } = useTopicState('projects');
  const threads = useTopic('threads');
  const items = useTopic('calendarItems');
  const open = (type: 'create' | 'import') => layout.setState({ projectDialog: { type } });

  return (
    <section aria-label="Projects" className="flex min-w-0 flex-col gap-2 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">
          A project is a folder. Threads, cards and workflow runs work in it.
        </p>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={!connection} onClick={() => open('create')}>
            <PlusIcon />
            Add project
          </Button>
          <Button variant="ghost" size="sm" disabled={!connection} onClick={() => open('import')}>
            <DownloadIcon />
            Import from Claude and Codex
          </Button>
        </div>
      </div>
      {projects === undefined ? (
        <TopicPlaceholder status={status} compact rows={2} />
      ) : projects.length === 0 ? (
        <EmptyState
          compact
          icon={FolderIcon}
          title="No projects yet"
          description="Import the folders Claude and Codex already worked in, or add one."
          action={
            <Button size="sm" onClick={() => open('import')}>
              <DownloadIcon />
              Import from Claude and Codex
            </Button>
          }
          secondary={
            <Button size="sm" variant="outline" onClick={() => open('create')}>
              <PlusIcon />
              Add project
            </Button>
          }
        />
      ) : (
        <Stale status={status}>
          <ul className="flex flex-col">
            {projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                usage={projectUsage(project.id, threads, items)}
              />
            ))}
          </ul>
        </Stale>
      )}
    </section>
  );
}
