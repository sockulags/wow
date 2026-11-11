import type { Command, Project, Thread } from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import { createStore } from 'zustand';
import type { AppCommand, CommandContext } from '@/app/commands';
import { notify } from '@/lib/feedback';
import { errorMessage } from './data';
import { groupThreads, threadTitle } from './model';

// The thread list's filter, project chip and rename state (agent workbench spec 66 to 70). It is
// UI state only: archive and unread come from the server's rows.

export interface ThreadListState {
  readonly filter: string;
  // The project chip that narrows the list, if one is picked.
  readonly projectId: string | undefined;
  // The thread whose title is being edited in the header.
  readonly renaming: string | undefined;
  // Raised by the filter command; the list focuses its filter field when it changes.
  readonly focusRequest: number;
}

export const threadListStore = createStore<ThreadListState>(() => ({
  filter: '',
  projectId: undefined,
  renaming: undefined,
  focusRequest: 0,
}));

// The server's message-text hits for what is typed in the palette (spec 69), written by
// `usePaletteThreadSearch`; `query` is empty while there are none.
export const paletteThreadHits = createStore<{
  readonly query: string;
  readonly ids: ReadonlySet<string>;
}>(() => ({ query: '', ids: new Set() }));

export const isArchived = (thread: Pick<Thread, 'archived'>): boolean => thread.archived ?? false;
export const isUnread = (thread: Pick<Thread, 'seen'>): boolean => thread.seen === false;

const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);

export const projectNameOf = (
  thread: Pick<Thread, 'projectId'>,
  projects: readonly Pick<Project, 'id' | 'name'>[],
): string | undefined => projects.find((project) => project.id === thread.projectId)?.name;

// Title and project match at once in the list; a word only in a message comes from the server's
// `threads.search`, whose answer for the same filter is `hits`.
export function filteredThreads(
  threads: readonly Thread[],
  projects: readonly Pick<Project, 'id' | 'name'>[],
  {
    filter,
    projectId,
    hits,
  }: { filter: string; projectId: string | undefined; hits: ReadonlySet<string> | undefined },
): Thread[] {
  const typed = words(filter);
  return threads.filter((thread) => {
    if (projectId !== undefined && thread.projectId !== projectId) return false;
    // Archived threads only show up for a filter (spec 68).
    if (typed.length === 0) return !isArchived(thread);
    if (hits?.has(thread.id)) return true;
    const named = `${threadTitle(thread)} ${projectNameOf(thread, projects) ?? ''}`.toLowerCase();
    return typed.every((word) => named.includes(word));
  });
}

// The order the list shows the threads in, top to bottom.
export const listOrder = (threads: readonly Thread[]): Thread[] =>
  groupThreads(threads).flatMap(([, members]) => members);

// The unread thread after the open one in list order, wrapping around (spec 70).
export function nextUnread(
  ordered: readonly Thread[],
  openId: string | undefined,
): Thread | undefined {
  const start = ordered.findIndex((thread) => thread.id === openId);
  for (let step = 1; step <= ordered.length; step += 1) {
    const thread = ordered[(start + step + ordered.length) % ordered.length];
    if (thread && thread.id !== openId && isUnread(thread) && !isArchived(thread)) return thread;
  }
  return undefined;
}

const send = (context: CommandContext, command: Command) => {
  if (!context.connection) return;
  // A refusal (a step's thread cannot be archived) has no other place to show.
  void dispatch(context.connection, command).catch((error: unknown) =>
    notify.error(errorMessage(error)),
  );
};

export const startRename = (threadId: string) => threadListStore.setState({ renaming: threadId });

export interface ThreadCommandData {
  readonly threads: readonly Thread[];
  readonly projects: readonly Pick<Project, 'id' | 'name'>[];
  readonly openThread: Thread | undefined;
  // The chat view is open, so the list is on screen.
  readonly inChat: boolean;
  // The project chip picked in the list.
  readonly projectId?: string | undefined;
  // The threads the server found for the palette's text by what was said in them.
  readonly found?: { readonly query: string; readonly ids: ReadonlySet<string> } | undefined;
}

// Palette commands of the thread list: filter, rename, archive, mark unread, next unread, and
// the project chips, and every thread by title, project and (from the server) message text,
// archived ones included.
export function threadListCommands({
  threads,
  projects,
  openThread,
  inChat,
  projectId,
  found,
}: ThreadCommandData): AppCommand[] {
  const commands: AppCommand[] = [
    {
      id: 'chat.filterThreads',
      title: 'Filter threads',
      group: 'Chat',
      keywords: ['search', 'find', 'thread list'],
      keybinding: 'keybindings.threadFilter',
      run: ({ navigate }) => {
        if (!inChat) void navigate({ to: '/chat' });
        threadListStore.setState((state) => ({ focusRequest: state.focusRequest + 1 }));
      },
    },
  ];
  // The same projects the list has chips for.
  const chips = projects.filter((project) =>
    threads.some((thread) => thread.projectId === project.id),
  );
  if (chips.length > 1) {
    const showProject =
      (id: string | undefined): AppCommand['run'] =>
      ({ navigate }) => {
        if (!inChat) void navigate({ to: '/chat' });
        threadListStore.setState({ projectId: id });
      };
    for (const project of chips) {
      if (project.id === projectId) continue;
      commands.push({
        id: `chat.threadsOf.${project.id}`,
        title: `Show threads of ${project.name}`,
        group: 'Chat',
        keywords: ['project', 'chip', 'thread list', 'narrow'],
        run: showProject(project.id),
      });
    }
    if (projectId !== undefined) {
      commands.push({
        id: 'chat.threadsOfAll',
        title: 'Show threads of all projects',
        group: 'Chat',
        keywords: ['project', 'chip', 'thread list'],
        run: showProject(undefined),
      });
    }
  }
  const next = nextUnread(listOrder(threads), openThread?.id);
  if (next) {
    commands.push({
      id: 'chat.nextUnread',
      title: 'Next unread thread',
      group: 'Chat',
      keywords: ['unread', 'bold', 'new'],
      keybinding: 'keybindings.nextBoldThread',
      detail: threadTitle(next),
      run: ({ navigate }) =>
        void navigate({ to: '/chat/$threadId', params: { threadId: next.id } }),
    });
  }
  if (openThread) {
    const threadId = openThread.id;
    commands.push({
      id: 'chat.renameThread',
      title: 'Rename thread',
      group: 'Chat',
      keywords: ['title', 'name'],
      keybinding: 'keybindings.renameThread',
      run: () => startRename(threadId),
    });
    commands.push(
      isArchived(openThread)
        ? {
            id: 'chat.unarchiveThread',
            title: 'Unarchive thread',
            group: 'Chat',
            keywords: ['archive', 'restore', 'back'],
            run: (context) =>
              send(context, { type: 'thread.setArchived', threadId, archived: false }),
          }
        : {
            id: 'chat.archiveThread',
            title: 'Archive thread',
            group: 'Chat',
            keywords: ['archive', 'hide', 'remove', 'delete'],
            run: (context) =>
              send(context, { type: 'thread.setArchived', threadId, archived: true }),
          },
    );
    if (!isUnread(openThread)) {
      commands.push({
        id: 'chat.markUnread',
        title: 'Mark unread',
        group: 'Chat',
        keywords: ['unread', 'bold', 'later'],
        run: (context) => {
          send(context, { type: 'thread.markUnread', threadId });
          // Staying on the thread would mark it read again; the list is where unread shows.
          void context.navigate({ to: '/chat' });
        },
      });
    }
  }
  for (const thread of threads) {
    const project = projectNameOf(thread, projects);
    const state =
      thread.state === 'needs_you'
        ? 'Needs you'
        : thread.state[0]?.toUpperCase() + thread.state.slice(1);
    commands.push({
      id: `thread.${thread.id}`,
      title: threadTitle(thread),
      value: `${threadTitle(thread)} ${thread.id}`,
      group: 'Threads',
      keywords: [
        'thread',
        thread.state.replace('_', ' '),
        thread.model,
        ...(project ? [project] : []),
      ],
      detail: `Thread · ${isArchived(thread) ? 'Archived' : state}`,
      needsYou: thread.state === 'needs_you' && !isArchived(thread),
      recentAt: thread.updatedAt,
      ...(found && found.query !== '' && found.ids.has(thread.id) ? { foundBy: found.query } : {}),
      run: ({ navigate }) =>
        void navigate({ to: '/chat/$threadId', params: { threadId: thread.id } }),
    });
  }
  return commands;
}
