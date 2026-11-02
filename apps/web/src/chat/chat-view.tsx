import { Link, Outlet } from '@tanstack/react-router';
import { MessagesSquareIcon, PinIcon, PlusIcon } from 'lucide-react';
import { useConnectionState } from '@/app/runtime';
import { useTopicState } from '@/app/topic-state';
import { ShortcutHint } from '@/components/hint';
import { DisconnectedState, EmptyState, TopicPlaceholder } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useDateFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTopic } from './data';
import { groupThreads } from './model';
import { stateDotClass } from './thread-view';
import { listTitle } from './view-model';

const baseName = (path: string) =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .at(-1) || path;

function ThreadList() {
  const { rows: threads, status } = useTopicState('threads');
  const runs = useTopic('workflowRuns') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const projects = useTopic('projects') ?? [];
  const { relative } = useDateFormat();
  const workflowName = (runId: string | null) => {
    if (runId === null) return undefined;
    const run = runs.find((candidate) => candidate.id === runId);
    return workflows.find((candidate) => candidate.id === run?.workflowId)?.name ?? 'Workflow run';
  };
  return (
    <nav
      aria-label="Threads"
      className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar/50"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 px-2">
        <Button asChild variant="ghost" size="sm" className="w-full justify-start">
          <Link to="/chat/new">
            <PlusIcon />
            New thread
            <ShortcutHint shortcut="keybindings.newThread" className="ml-auto" />
          </Link>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {threads === undefined ? (
          <TopicPlaceholder status={status} compact rows={4} />
        ) : threads.length === 0 ? (
          <EmptyState
            compact
            icon={MessagesSquareIcon}
            title="No threads yet"
            description="Threads you start and the steps of workflow runs appear here."
          />
        ) : (
          groupThreads(threads).map(([group, members]) =>
            members.length === 0 ? null : (
              <section key={group} aria-label={group} className="mt-2">
                <h3 className="px-2 pb-1 text-2xs font-medium text-muted-foreground">
                  {group}
                  <span className="ml-1 tabular-nums opacity-70">{members.length}</span>
                </h3>
                <ul className="flex flex-col gap-0.5">
                  {members.map((thread) => {
                    const workflow = workflowName(thread.runId);
                    const place =
                      projects.find((candidate) => candidate.id === thread.projectId)?.name ??
                      baseName(thread.cwd);
                    const detail = [workflow, place, relative(thread.updatedAt)]
                      .filter(Boolean)
                      .join(' · ');
                    return (
                      <li key={thread.id}>
                        <Link
                          to="/chat/$threadId"
                          params={{ threadId: thread.id }}
                          className="flex flex-col rounded-md px-2 py-1.5 text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"
                          activeProps={{ className: 'bg-sidebar-accent', 'aria-current': 'page' }}
                        >
                          <span className="flex items-center gap-2">
                            <span
                              aria-hidden
                              className={cn(
                                'size-1.5 shrink-0 rounded-full',
                                stateDotClass[thread.state],
                              )}
                            />
                            <span className="min-w-0 flex-1 truncate">
                              {listTitle(thread, workflow)}
                            </span>
                            {thread.pinned && (
                              <PinIcon
                                aria-label="Pinned"
                                className="size-3.5 shrink-0 fill-current text-muted-foreground"
                              />
                            )}
                            {thread.state === 'failed' && (
                              <span className="shrink-0 text-2xs text-state-failed">Failed</span>
                            )}
                          </span>
                          <span
                            data-testid="thread-row-detail"
                            className="truncate pl-3.5 text-2xs text-muted-foreground"
                          >
                            {detail}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ),
          )
        )}
      </div>
    </nav>
  );
}

export function ChatLayout() {
  const { configured } = useConnectionState();
  if (!configured) return <DisconnectedState offline />;
  return (
    <div className="flex h-full min-h-0">
      <ThreadList />
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

export function ChatHome() {
  const threads = useTopic('threads');
  const instances = useTopic('providerInstances');
  const any = threads !== undefined && threads.length > 0;
  if (instances !== undefined && instances.length === 0) {
    return (
      <EmptyState
        icon={MessagesSquareIcon}
        title="Set up a provider to start a thread"
        description="wow runs Claude Code and Codex on your machine. Add an instance and test it first."
        action={
          <Button asChild size="sm">
            <Link to="/settings/$group" params={{ group: 'providers' }}>
              Set up a provider
            </Link>
          </Button>
        }
      />
    );
  }
  return (
    <EmptyState
      icon={MessagesSquareIcon}
      title={any ? 'Pick a thread' : 'No threads yet'}
      description={
        any
          ? 'Pick a thread from the list, or start a new one.'
          : 'Start a thread to give an agent a task in one of your projects.'
      }
      action={
        <Button asChild size="sm">
          <Link to="/chat/new">
            <PlusIcon />
            New thread
            <ShortcutHint shortcut="keybindings.newThread" />
          </Link>
        </Button>
      }
    />
  );
}
