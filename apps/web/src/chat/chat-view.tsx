import type { Thread } from '@wow/contracts';
import { settingValue } from '@wow/client-runtime';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { nestHelpers } from './helpers';
import {
  ActivityIcon,
  MessagesSquareIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';
import { eventToBinding, normalizeBinding } from '@/app/keybindings';
import { openThreadOf } from '@/app/notifications';
import { useConnectionState, useRuntime, useSetting } from '@/app/runtime';
import { useTopicState } from '@/app/topic-state';
import { ShortcutHint } from '@/components/hint';
import { DisconnectedState, EmptyState, TopicPlaceholder } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useDateFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useDispatch, useTopic } from './data';
import { groupThreads } from './model';
import {
  filteredThreads,
  isArchived,
  isUnread,
  pickedProject,
  projectChips,
  threadListStore,
} from './thread-commands';
import { useThreadSearch } from './thread-search';
import { stateDotClass } from './thread-view';
import { threadRowParts } from './thread-row';
import { listTitle } from './view-model';

// The open thread is read as soon as it is on screen in a focused window, and again whenever a
// turn ends or a request arrives while it is (spec 70). A second request in a thread that
// already needs you turns it unread without moving `updatedAt`, so turning unread on screen
// counts as well. "Mark unread" leaves the thread, and leaving forgets what was handled, so
// opening it again reads it.
function useMarkSeen(threads: readonly Thread[] | undefined) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const send = useDispatch();
  const [focused, setFocused] = useState(() => document.hasFocus());
  const handled = useRef<string>(undefined);
  const wasUnread = useRef<boolean>(undefined);
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  const openId = openThreadOf(pathname);
  const thread = threads?.find((candidate) => candidate.id === openId);
  const mark = thread ? `${thread.id}@${thread.updatedAt}` : undefined;
  const unread = thread !== undefined && isUnread(thread);
  useEffect(() => {
    if (mark === undefined) {
      handled.current = undefined;
      wasUnread.current = undefined;
      return;
    }
    if (wasUnread.current === false && unread) handled.current = undefined;
    wasUnread.current = unread;
    if (!focused || handled.current === mark) return;
    handled.current = mark;
    if (unread && openId)
      void send({ type: 'thread.markSeen', threadId: openId }).catch(() => undefined);
  }, [focused, mark, unread, openId, send]);
}

const rowSelector = '[data-thread-row]';

// "At work · 3" above the list (parallel threads spec 11).
function AtWorkLink() {
  const count = useTopic('threadActivity')?.length ?? 0;
  return (
    <div className="flex shrink-0 px-2 pb-1">
      <Button asChild variant="ghost" size="sm" className="w-full justify-start">
        <Link to="/chat/work" data-testid="at-work-link">
          <ActivityIcon />
          At work{count > 0 ? ` · ${count}` : ''}
          <ShortcutHint shortcut="keybindings.threadsAtWork" className="ml-auto" />
        </Link>
      </Button>
    </div>
  );
}

function ThreadList() {
  const { rows: threads, status } = useTopicState('threads');
  const runs = useTopic('workflowRuns') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const projects = useTopic('projects') ?? [];
  const activity = useTopic('threadActivity') ?? [];
  const decisions = useTopic('decisions') ?? [];
  const rowParts = useSetting('chat.threadRowDetail');
  const { settings } = useRuntime();
  const { relative } = useDateFormat();
  const filter = useStore(threadListStore, (state) => state.filter);
  const projectId = useStore(threadListStore, (state) => state.projectId);
  const focusRequest = useStore(threadListStore, (state) => state.focusRequest);
  const filterField = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const { hits, error: searchError } = useThreadSearch(filter);
  useMarkSeen(threads);
  useEffect(() => {
    if (focusRequest === 0) return;
    filterField.current?.focus();
    filterField.current?.select();
  }, [focusRequest]);

  const workflowName = (runId: string | null) => {
    if (runId === null) return undefined;
    const run = runs.find((candidate) => candidate.id === runId);
    return workflows.find((candidate) => candidate.id === run?.workflowId)?.name ?? 'Workflow run';
  };
  const chips = projectChips(threads ?? [], projects);
  const picked = pickedProject(threads ?? [], projects, projectId);
  const visible = threads
    ? filteredThreads(threads, projects, { filter, projectId: picked, hits })
    : [];
  const rows = () => [...(list.current?.querySelectorAll<HTMLElement>(rowSelector) ?? [])];
  const move = (by: number) => {
    const all = rows();
    const at = all.findIndex((row) => row === document.activeElement);
    all[Math.max(0, Math.min(all.length - 1, at + by))]?.focus();
  };
  const onListKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target === filterField.current) return;
    const pressed = eventToBinding(event);
    const binding = settingValue(settings.getState().values, 'keybindings.threadFilterInList');
    if (pressed && binding !== '' && normalizeBinding(binding) === pressed) {
      event.preventDefault();
      filterField.current?.focus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!(event.target instanceof HTMLElement) || !event.target.matches(rowSelector)) return;
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    }
  };

  return (
    <nav
      aria-label="Threads"
      className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar/50"
      onKeyDown={onListKey}
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
      <AtWorkLink />
      <div className="flex shrink-0 flex-col gap-1.5 px-2 pb-1">
        <div className="relative">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={filterField}
            type="search"
            aria-label="Filter threads"
            placeholder="Filter threads"
            value={filter}
            onChange={(event) => threadListStore.setState({ filter: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                rows()[0]?.focus();
              } else if (event.key === 'Enter') {
                event.preventDefault();
                rows()[0]?.click();
              } else if (event.key === 'Escape' && filter !== '') {
                event.preventDefault();
                event.stopPropagation();
                threadListStore.setState({ filter: '' });
              }
            }}
            className="h-7 pl-7 text-xs"
          />
          <ShortcutHint
            shortcut="keybindings.threadFilter"
            className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2"
          />
        </div>
        {searchError && (
          <p
            role="alert"
            data-testid="thread-search-error"
            className="px-1 text-2xs text-state-failed"
          >
            Messages could not be searched: {searchError}
          </p>
        )}
        {chips.length > 0 && (
          <ToggleGroup
            type="single"
            aria-label="Project"
            value={picked ?? ''}
            onValueChange={(value) =>
              threadListStore.setState({ projectId: value === '' ? undefined : value })
            }
            className="flex w-full flex-wrap gap-1"
          >
            {chips.map((project) => (
              <ToggleGroupItem
                key={project.id}
                value={project.id}
                className="h-6 min-w-0 px-2 text-2xs"
              >
                {project.name}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </div>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {threads === undefined ? (
          <TopicPlaceholder status={status} compact rows={4} />
        ) : threads.length === 0 ? (
          <EmptyState
            compact
            icon={MessagesSquareIcon}
            title="No threads yet"
            description="Threads you start and the steps of workflow runs appear here."
          />
        ) : visible.length === 0 ? (
          <EmptyState
            compact
            icon={SearchIcon}
            title="No thread matches"
            description="The filter looks at titles, project names and what was said in each thread."
          />
        ) : (
          groupThreads(visible).map(([group, members]) =>
            members.length === 0 ? null : (
              <section key={group} aria-label={group} className="mt-2">
                <h3 className="px-2 pb-1 text-2xs font-medium text-muted-foreground">
                  {group}
                  <span className="ml-1 tabular-nums opacity-70">{members.length}</span>
                </h3>
                <ul className="flex flex-col gap-0.5">
                  {nestHelpers(members, (member) => member, threads).map((nested) => {
                    const { entry: thread } = nested;
                    const workflow = workflowName(thread.runId);
                    // What the row says under its title (chat overview spec 6, 7).
                    const parts = threadRowParts(
                      {
                        thread,
                        activity: activity.find((entry) => entry.threadId === thread.id),
                        waitsFor: decisions.find((decision) => decision.threadId === thread.id)
                          ?.title,
                        projects,
                        relative,
                      },
                      rowParts,
                    );
                    const lead = [
                      nested.helperOf === undefined ? undefined : `Helper of ${nested.helperOf}`,
                      workflow,
                    ].filter((part) => part !== undefined);
                    const detail = [...lead, ...parts.map((part) => part.text)].join(' · ');
                    const unread = isUnread(thread);
                    return (
                      <li key={thread.id} className={cn(nested.depth === 1 && 'ml-4')}>
                        <Link
                          to="/chat/$threadId"
                          params={{ threadId: thread.id }}
                          data-thread-row=""
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
                            <span
                              data-testid="thread-row-title"
                              className={cn('min-w-0 flex-1 truncate', unread && 'font-semibold')}
                            >
                              {listTitle(thread, workflow)}
                            </span>
                            {unread && (
                              <span
                                role="img"
                                aria-label="Unread"
                                data-testid="thread-unread"
                                className="size-2 shrink-0 rounded-full bg-primary"
                              />
                            )}
                            {thread.startedBy === 'assistant' && (
                              <SparklesIcon
                                aria-label="Started by the assistant"
                                data-testid="thread-row-assistant"
                                className="size-3.5 shrink-0 text-muted-foreground"
                              />
                            )}
                            {thread.pinned && (
                              <PinIcon
                                aria-label="Pinned"
                                className="size-3.5 shrink-0 fill-current text-muted-foreground"
                              />
                            )}
                            {thread.state === 'failed' && (
                              <span className="shrink-0 text-2xs text-state-failed">Failed</span>
                            )}
                            {isArchived(thread) && (
                              <span className="shrink-0 text-2xs text-muted-foreground">
                                Archived
                              </span>
                            )}
                          </span>
                          <span
                            data-testid="thread-row-detail"
                            title={detail}
                            className="truncate pl-3.5 text-2xs text-muted-foreground"
                          >
                            {[...lead.map((text) => ({ part: 'lead', text })), ...parts].map(
                              (part, index) => (
                                <span
                                  key={`${part.part}-${index}`}
                                  data-part={part.part}
                                  className={cn(
                                    part.part === 'activity' &&
                                      (thread.state === 'needs_you'
                                        ? 'text-state-needs-you-text'
                                        : 'text-foreground/80'),
                                  )}
                                >
                                  {index > 0 && ' · '}
                                  {part.text}
                                </span>
                              ),
                            )}
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
