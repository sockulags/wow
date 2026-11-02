import { Link, Outlet } from '@tanstack/react-router';
import { MessagesSquareIcon, PinIcon, PlusIcon } from 'lucide-react';
import { useConnectionState, useSetting } from '@/app/runtime';
import { formatBinding } from '@/app/keybindings';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTopic } from './data';
import { groupThreads, runLabel, threadTitle } from './model';
import { stateDotClass } from './thread-view';

function ThreadList() {
  const threads = useTopic('threads');
  const runs = useTopic('workflowRuns') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const newThreadBinding = useSetting('keybindings.newThread');
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
            {newThreadBinding !== '' && (
              <kbd className="ml-auto font-mono text-[11px] text-muted-foreground">
                {formatBinding(newThreadBinding)}
              </kbd>
            )}
          </Link>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {groupThreads(threads ?? []).map(([group, members]) =>
          members.length === 0 ? null : (
            <section key={group} aria-label={group} className="mt-2">
              <h3 className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">
                {group}
                <span className="ml-1 opacity-70">{members.length}</span>
              </h3>
              <ul className="flex flex-col gap-0.5">
                {members.map((thread) => {
                  const run = runLabel(thread, runs, workflows);
                  return (
                    <li key={thread.id}>
                      <Link
                        to="/chat/$threadId"
                        params={{ threadId: thread.id }}
                        className="flex flex-col rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent"
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
                          <span className="min-w-0 flex-1 truncate">{threadTitle(thread)}</span>
                          {thread.pinned && (
                            <PinIcon
                              aria-label="Pinned"
                              className="size-3 shrink-0 text-muted-foreground"
                            />
                          )}
                          {thread.state === 'failed' && (
                            <span className="shrink-0 text-[11px] text-state-failed">failed</span>
                          )}
                        </span>
                        {run && (
                          <span className="truncate pl-3.5 text-[11px] text-muted-foreground">
                            {run}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ),
        )}
      </div>
    </nav>
  );
}

export function ChatLayout() {
  const { configured } = useConnectionState();
  if (!configured) {
    return (
      <section className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <MessagesSquareIcon className="size-6 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-medium">No threads yet</h2>
        <p className="max-w-sm text-xs text-muted-foreground">
          Agent threads from Claude and Codex will appear here once the app is connected to the wow
          server.
        </p>
      </section>
    );
  }
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
  const newThreadBinding = useSetting('keybindings.newThread');
  return (
    <section className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <MessagesSquareIcon className="size-6 text-muted-foreground" aria-hidden />
      <h2 className="text-sm font-medium">
        {threads && threads.length > 0 ? 'Pick a thread' : 'No threads yet'}
      </h2>
      <p className="max-w-sm text-xs text-muted-foreground">
        Start a new thread
        {newThreadBinding !== '' ? ` with ${formatBinding(newThreadBinding)}` : ''} or pick one from
        the list.
      </p>
      <Button asChild size="sm" variant="outline">
        <Link to="/chat/new">
          <PlusIcon />
          New thread
        </Link>
      </Button>
    </section>
  );
}
