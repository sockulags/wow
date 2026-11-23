import { localDate, type Thread } from '@wow/contracts';
import { settingValue } from '@wow/client-runtime';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { nestHelpers, type Nested } from './helpers';
import {
  ActivityIcon,
  BarChart3Icon,
  ChevronRightIcon,
  MessagesSquareIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
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
import { useCalendarPrefs } from '@/calendar/prefs';
import { useDateFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useDispatch, useTopic } from './data';
import { threadSections, type ThreadSection } from './thread-sections';
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
import { PickedBar, RowButtons, ThreadRowMenu } from './row-menu';
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

const idOf = (row: HTMLElement | undefined) => row?.dataset['threadId'];
const togglePick = (threadId: string) =>
  threadListStore.setState((state) => ({
    picked: state.picked.includes(threadId)
      ? state.picked.filter((id) => id !== threadId)
      : [...state.picked, threadId],
    anchor: threadId,
  }));
const flatThreads = (section: ThreadSection): Thread[] => [
  ...section.threads,
  ...section.sections.flatMap(flatThreads),
];

function ThreadList() {
  const { rows: threads, status } = useTopicState('threads');
  const runs = useTopic('workflowRuns') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const projects = useTopic('projects') ?? [];
  const activity = useTopic('threadActivity') ?? [];
  const decisions = useTopic('decisions') ?? [];
  const rowParts = useSetting('chat.threadRowDetail');
  const pickedRows = useStore(threadListStore, (state) => state.picked);
  const openThreadId = useRouterState({
    select: (state) => /^\/chat\/([^/]+)$/.exec(state.location.pathname)?.[1],
  });
  const groupBy = useSetting('chat.threadListGroupBy');
  const folded = useSetting('chat.threadListFolded');
  const { firstDayOfWeek } = useCalendarPrefs();
  const { settings } = useRuntime();
  const { relative, zone } = useDateFormat();
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

  const renderRow = (nested: Nested<Thread>) => {
    const { entry: thread } = nested;
    const workflow = workflowName(thread.runId);
    // What the row says under its title (chat overview spec 6, 7).
    const parts = threadRowParts(
      {
        thread,
        activity: activity.find((entry) => entry.threadId === thread.id),
        waitsFor: decisions.find((decision) => decision.threadId === thread.id)?.title,
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
      <li key={thread.id} className={cn('group/row relative', nested.depth === 1 && 'ml-4')}>
        <ThreadRowMenu thread={thread}>
          <Link
            to="/chat/$threadId"
            params={{ threadId: thread.id }}
            data-thread-row=""
            data-thread-id={thread.id}
            data-picked={pickedRows.includes(thread.id) || undefined}
            aria-description={pickedRows.includes(thread.id) ? 'Picked' : undefined}
            className={cn(
              'flex flex-col rounded-md px-2 py-1.5 text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring',
              pickedRows.includes(thread.id) && 'bg-primary/15 ring-1 ring-primary/40',
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
              <span
                aria-hidden
                className={cn('size-1.5 shrink-0 rounded-full', stateDotClass[thread.state])}
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
                <span className="shrink-0 text-2xs text-muted-foreground">Archived</span>
              )}
            </span>
            <span
              data-testid="thread-row-detail"
              title={detail}
              className="truncate pl-3.5 text-2xs text-muted-foreground"
            >
              {[...lead.map((text) => ({ part: 'lead', text })), ...parts].map((part, index) => (
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
              ))}
            </span>
          </Link>
        </ThreadRowMenu>
        <RowButtons thread={thread} />
      </li>
    );
  };

  // A group heading folds its group (chat overview spec 10); while the filter has text every
  // group is open, so a match is never hidden.
  const fold = (key: string, close: boolean) =>
    void settings.write(
      'chat.threadListFolded',
      close ? [...folded.filter((other) => other !== key), key] : folded.filter((o) => o !== key),
    );
  const renderSection = (section: ThreadSection, depth: number): ReactNode => {
    if (section.count === 0) return null;
    const isFolded = filter.trim() === '' && folded.includes(section.key);
    // A folded group still shows the thread on screen, so it never disappears from the list.
    const onScreen = isFolded
      ? flatThreads(section).filter((thread) => thread.id === openThreadId)
      : [];
    return (
      <section
        key={section.key}
        aria-label={section.title}
        data-group={section.key}
        className={depth === 0 ? 'mt-2' : 'mt-1'}
      >
        <h3 className={cn('pb-1 text-2xs font-medium text-muted-foreground', depth > 0 && 'pl-2')}>
          <button
            type="button"
            data-testid="thread-group-toggle"
            aria-expanded={!isFolded}
            className="flex w-full items-center gap-1 rounded-sm px-2 text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => fold(section.key, !isFolded)}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn('size-3 transition-transform', !isFolded && 'rotate-90')}
            />
            {section.title}
            <span className="tabular-nums opacity-70">{section.count}</span>
          </button>
        </h3>
        {onScreen.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {nestHelpers(onScreen, (member) => member, threads ?? []).map(renderRow)}
          </ul>
        )}
        {!isFolded && (
          <>
            {section.threads.length > 0 && (
              <ul className="flex flex-col gap-0.5">
                {nestHelpers(section.threads, (member) => member, threads ?? []).map(renderRow)}
              </ul>
            )}
            {section.sections.map((inner) => renderSection(inner, depth + 1))}
          </>
        )}
      </section>
    );
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
      <PickedBar threads={threads ?? []} />
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
          threadSections(visible, {
            groupBy,
            projects,
            today: localDate(new Date(), zone),
            zone,
            firstDay: firstDayOfWeek,
          }).map((section) => renderSection(section, 0))
        )}
      </div>
      <div className="flex shrink-0 border-t border-border px-2 py-1">
        <Button asChild variant="ghost" size="sm" className="w-full justify-start">
          <Link to="/chat/usage" data-testid="usage-link">
            <BarChart3Icon />
            Usage
          </Link>
        </Button>
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
