import type { Thread, ThreadListStatus } from '@wow/contracts';
import { settingValue } from '@wow/client-runtime';
import { Link, useRouterState } from '@tanstack/react-router';
import { MessagesSquareIcon, PinIcon, PlusIcon, SearchIcon, SparklesIcon } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { eventToBinding, normalizeBinding } from '@/app/keybindings';
import { openThreadOf } from '@/app/notifications';
import { useRuntime } from '@/app/runtime';
import { useTopicState } from '@/app/topic-state';
import { ShortcutHint } from '@/components/hint';
import { EmptyState, TopicPlaceholder } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { useDispatch, useTopic } from './data';
import { PickedBar, RowButtons, ThreadRowMenu } from './row-menu';
import {
  filteredThreads,
  isArchived,
  isUnread,
  pickedProject,
  projectChips,
  threadListStore,
} from './thread-commands';
import { threadRowPlace } from './thread-row';
import { useThreadSearch } from './thread-search';
import { isMainThread, listStatusOf, listStatusTitles, threadListOrder } from './thread-sections';
import { listTitle } from './view-model';

// The thread list on the left side of the app (orchestrator threads spec 30 to 32): main threads
// with their title, project and status, ordered by status. It keeps the filter, the project
// chips, pin, archive, mark done, the row menu and picking several rows.

// The open thread is read as soon as it is on screen in a focused window, and again whenever a
// turn ends or a request arrives while it is (agent workbench spec 70). A second request in a
// thread that already needs you turns it unread without moving `updatedAt`, so turning unread on
// screen counts as well. "Mark unread" leaves the thread, and leaving forgets what was handled, so
// opening it again reads it.
// The shell calls it, so it reads the thread whether or not the list is shown.
export function useMarkSeen(): void {
  const threads = useTopic('threads');
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

// The row's status mark: an exclamation mark in a ring of the attention colour while the thread
// waits for the user, a dot otherwise.
function StatusMark({ status }: { readonly status: ThreadListStatus }) {
  const label = listStatusTitles[status];
  if (status === 'waits_for_you') {
    return (
      <span
        role="img"
        aria-label={label}
        data-testid="thread-status"
        data-status={status}
        className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border border-state-needs-you text-[9px] leading-none font-bold text-state-needs-you-text"
      >
        !
      </span>
    );
  }
  return (
    <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
      <span
        role="img"
        aria-label={label}
        data-testid="thread-status"
        data-status={status}
        className={cn(
          'size-2 rounded-full',
          status === 'working' && 'animate-pulse bg-state-working',
          status === 'unread' && 'bg-primary',
          status === 'done' && 'border border-muted-foreground/50',
        )}
      />
    </span>
  );
}

const rowSelector = '[data-thread-row]';
const idOf = (row: HTMLElement | undefined) => row?.dataset['threadId'];
const togglePick = (threadId: string) =>
  threadListStore.setState((state) => ({
    picked: state.picked.includes(threadId)
      ? state.picked.filter((id) => id !== threadId)
      : [...state.picked, threadId],
    anchor: threadId,
  }));

export function ThreadList({ footer }: { readonly footer?: ReactNode }) {
  const { rows: threads, status } = useTopicState('threads');
  const runs = useTopic('workflowRuns') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const projects = useTopic('projects') ?? [];
  const pickedRows = useStore(threadListStore, (state) => state.picked);
  const { settings } = useRuntime();
  const filter = useStore(threadListStore, (state) => state.filter);
  const projectId = useStore(threadListStore, (state) => state.projectId);
  const focusRequest = useStore(threadListStore, (state) => state.focusRequest);
  const filterField = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const { hits, error: searchError } = useThreadSearch(filter);
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
  const mains = threads?.filter(isMainThread) ?? [];
  const chips = projectChips(mains, projects);
  const picked = pickedProject(mains, projects, projectId);
  const visible = threadListOrder(
    filteredThreads(mains, projects, { filter, projectId: picked, hits }),
  );
  const rows = () => [...(list.current?.querySelectorAll<HTMLElement>(rowSelector) ?? [])];
  const move = (by: number) => {
    const all = rows();
    const at = all.findIndex((row) => row === document.activeElement);
    const next = all[Math.max(0, Math.min(all.length - 1, at + by))];
    next?.focus();
    return next;
  };
  // Picking rows (chat overview spec 15): Ctrl+click and Space add or take out one, Shift+click
  // and Shift+arrows pick every row from the anchor to there, in the order the list shows them.
  const pickTo = (threadId: string) => {
    const ids = rows().flatMap((row) => idOf(row) ?? []);
    const { anchor } = threadListStore.getState();
    const from = ids.indexOf(anchor ?? threadId);
    const to = ids.indexOf(threadId);
    if (from === -1 || to === -1) return togglePick(threadId);
    const span = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
    threadListStore.setState((state) => ({
      picked: [...new Set([...state.picked, ...span])],
      anchor: state.anchor ?? threadId,
    }));
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
    if (!(event.target instanceof HTMLElement) || !event.target.matches(rowSelector)) return;
    const here = idOf(event.target);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      if (event.shiftKey && here !== undefined) {
        if (threadListStore.getState().anchor === undefined) {
          threadListStore.setState({ anchor: here });
        }
        const next = idOf(move(event.key === 'ArrowDown' ? 1 : -1));
        if (next !== undefined) pickTo(next);
        return;
      }
      move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === ' ' && here !== undefined) {
      event.preventDefault();
      togglePick(here);
      return;
    }
    if (event.key === 'Escape' && threadListStore.getState().picked.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      threadListStore.setState({ picked: [], anchor: undefined });
    }
  };

  const renderRow = (thread: Thread) => {
    const workflow = workflowName(thread.runId);
    const unread = isUnread(thread);
    const place = threadRowPlace(thread, projects);
    const isPicked = pickedRows.includes(thread.id);
    return (
      <li key={thread.id} className="group/row relative">
        <ThreadRowMenu thread={thread}>
          <Link
            to="/chat/$threadId"
            params={{ threadId: thread.id }}
            data-thread-row=""
            data-thread-id={thread.id}
            data-picked={isPicked || undefined}
            aria-description={isPicked ? 'Picked' : undefined}
            className={cn(
              'flex flex-col rounded-md px-2 py-1.5 text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring',
              isPicked && 'bg-primary/15 ring-1 ring-primary/40',
            )}
            activeProps={{ className: 'bg-sidebar-accent', 'aria-current': 'page' }}
            onClick={(event) => {
              if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                togglePick(thread.id);
              } else if (event.shiftKey) {
                event.preventDefault();
                pickTo(thread.id);
              }
            }}
          >
            <span className="flex items-center gap-2">
              <StatusMark status={listStatusOf(thread)} />
              <span
                data-testid="thread-row-title"
                className={cn('min-w-0 flex-1 truncate', unread && 'font-semibold')}
              >
                {listTitle(thread, workflow)}
              </span>
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
                <span className="shrink-0 text-2xs text-muted-foreground">Archived</span>
              )}
            </span>
            <span
              data-testid="thread-row-detail"
              title={place}
              className="truncate pl-5.5 text-2xs text-muted-foreground"
            >
              {place}
            </span>
          </Link>
        </ThreadRowMenu>
        <RowButtons thread={thread} />
      </li>
    );
  };

  return (
    <nav
      aria-label="Threads"
      className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
      onKeyDown={onListKey}
    >
      <div className="flex h-11 shrink-0 items-center gap-1 px-2">
        <Button asChild variant="ghost" size="sm" className="w-full justify-start">
          <Link to="/chat/new">
            <PlusIcon />
            New thread
            <ShortcutHint shortcut="keybindings.newThread" className="ml-auto" />
          </Link>
        </Button>
      </div>
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
      <PickedBar threads={threads ?? []} />
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {threads === undefined ? (
          <TopicPlaceholder status={status} compact rows={4} />
        ) : mains.length === 0 ? (
          <EmptyState
            compact
            icon={MessagesSquareIcon}
            title="No threads yet"
            description="Threads you start and the ones your scheduled cards start appear here."
          />
        ) : visible.length === 0 ? (
          <EmptyState
            compact
            icon={SearchIcon}
            title="No thread matches"
            description="The filter looks at titles, project names and what was said in each thread."
          />
        ) : (
          <ul className="flex flex-col gap-0.5" aria-label="Main threads">
            {visible.map(renderRow)}
          </ul>
        )}
      </div>
      {footer}
    </nav>
  );
}
