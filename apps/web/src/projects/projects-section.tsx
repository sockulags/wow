import type { Project, ProjectGit } from '@wow/contracts';
import { useLocation } from '@tanstack/react-router';
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DownloadIcon,
  FolderIcon,
  GitBranchIcon,
  InfoIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { PathText } from '@/components/path-text';
import { EmptyState, Stale, TopicPlaceholder } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useRuntime } from '@/app/runtime';
import { useTopicState } from '@/app/topic-state';
import { useTopic } from '@/chat/data';
import { cn } from '@/lib/utils';
import { gitProblems, primaryOf, remoteLabel, useProjectsGit } from './project-git';
import { ProjectTrackersPanel } from './project-trackers';

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

// The row's git line: the remote issues go to, or why there is none (audit E-12).
function GitLine({ projectId, git }: { projectId: string; git: ProjectGit | undefined }) {
  if (!git) return null;
  if (git.status !== 'ok') {
    const problem = gitProblems[git.status];
    const Icon = problem.tone === 'warning' ? AlertTriangleIcon : InfoIcon;
    return (
      <p
        data-testid={`project-git-${projectId}`}
        data-status={git.status}
        className={cn(
          'flex min-w-0 items-center gap-1.5 text-xs',
          problem.tone === 'warning' ? 'text-warning' : 'text-muted-foreground',
        )}
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium whitespace-nowrap">{problem.title}.</span>
        <span className="min-w-0 truncate text-muted-foreground">
          {git.message ?? problem.detail}
        </span>
      </p>
    );
  }
  const remote = primaryOf(git);
  const others = git.remotes.length - 1;
  return (
    <p
      data-testid={`project-git-${projectId}`}
      data-status={git.status}
      className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
    >
      <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
      {remote && (
        <span className="max-w-[70%] min-w-0 shrink-0 truncate">
          <span className="text-foreground">{remote.name}</span> ·{' '}
          <span className="font-mono">{remoteLabel(remote)}</span>
        </span>
      )}
      {git.branch && <span className="min-w-0 truncate">· {git.branch}</span>}
      {others > 0 && (
        <span className="shrink-0">
          · {others} more {others === 1 ? 'remote' : 'remotes'}
        </span>
      )}
    </p>
  );
}

function ProjectRow({
  project,
  usage,
  git,
  initiallyOpen,
}: {
  project: Project;
  usage: string | undefined;
  git: ProjectGit | undefined;
  initiallyOpen: boolean;
}) {
  const { layout } = useRuntime();
  const [open, setOpen] = useState(initiallyOpen);
  const panelId = `project-${project.id}-trackers`;
  return (
    <li
      aria-label={project.name}
      id={`trackers-${project.id}`}
      className="flex min-w-0 flex-col gap-3 border-b border-border py-3 last:border-b-0"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium">{project.name}</span>
          <PathText path={project.cwd} copy className="text-muted-foreground" />
          <GitLine projectId={project.id} git={git} />
          {usage && <span className="text-xs text-muted-foreground">{usage}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen(!open)}
          >
            {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
            Trackers
          </Button>
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
      </div>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label={`Trackers for ${project.name}`}
          className="ml-0 rounded-md border border-border p-4"
        >
          <ProjectTrackersPanel project={project} />
        </div>
      )}
    </li>
  );
}

// Settings → Projects: the projects every picker offers, and the way to add, rename and remove
// them. The rows come from the server's projects topic. Same header pattern as Providers.
export function ProjectsSection() {
  const { connection, layout } = useRuntime();
  const { rows: projects, status } = useTopicState('projects');
  const threads = useTopic('threads');
  const offline = !connection || status === 'disconnected';
  const items = useTopic('calendarItems');
  const git = useProjectsGit(projects);
  // "#trackers-<id>" (the palette's "Trackers for project …") opens that project's trackers.
  const hash = useLocation({ select: (location) => location.hash });
  const open = (type: 'create' | 'import') => layout.setState({ projectDialog: { type } });

  return (
    <section aria-label="Projects" className="flex min-w-0 flex-col gap-2 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">
          A project is a folder. Threads, cards and workflow runs work in it.
        </p>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={offline} onClick={() => open('create')}>
            <PlusIcon />
            Add project
          </Button>
          <Button variant="ghost" size="sm" disabled={offline} onClick={() => open('import')}>
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
                key={`${project.id}${hash === `trackers-${project.id}` ? '-open' : ''}`}
                project={project}
                usage={projectUsage(project.id, threads, items)}
                git={git?.get(project.id)}
                initiallyOpen={hash === `trackers-${project.id}`}
              />
            ))}
          </ul>
        </Stale>
      )}
    </section>
  );
}
