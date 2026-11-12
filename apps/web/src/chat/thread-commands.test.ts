import type { Thread } from '@wow/contracts';
import type { Connection } from '@wow/client-runtime';
import { describe, expect, it, vi } from 'vitest';
import type { AppCommand, CommandContext } from '@/app/commands';
import { worksInTextFields } from '@/app/keybindings';
import { paletteScore, startList } from '@/app/palette-model';
import { onScreen, openThreadOf } from '@/app/notifications';
import {
  filteredThreads,
  listOrder,
  nextUnread,
  pickedProject,
  projectChips,
  threadListCommands,
  threadListStore,
} from './thread-commands';

// Agent workbench U2 in the web app: the filter, unread order, the palette's thread commands and
// when a chat notification stays quiet. All invented.

const thread = (id: string, overrides: Partial<Thread> = {}): Thread => ({
  id,
  projectId: null,
  cwd: '/work/kettle',
  branch: null,
  providerInstanceId: 'claude',
  providerSessionId: null,
  title: id,
  model: 'opus',
  effort: 'high',
  permissionMode: 'default',
  state: 'idle',
  pinned: false,
  runId: null,
  stepId: null,
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
  ...overrides,
});

const projects = [{ id: 'p-garden', name: 'Garden' }];
const threads = [
  thread('Kettle timer', { updatedAt: '2026-11-02T08:03:00.000Z' }),
  thread('Water the plants', { projectId: 'p-garden', updatedAt: '2026-11-02T08:02:00.000Z' }),
  thread('Old musings', { archived: true, updatedAt: '2026-11-02T08:01:00.000Z' }),
];
const ids = (list: readonly Thread[]) => list.map((entry) => entry.id);

function context() {
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>(
    (_method: string, params: unknown) =>
      Promise.resolve({
        commandId: (params as { commandId: string }).commandId,
        seqs: [],
        duplicate: false,
      }),
  );
  const navigate = vi.fn<(options: unknown) => void>();
  return {
    request,
    navigate,
    context: {
      navigate,
      connection: { request } as unknown as Connection,
    } as unknown as CommandContext,
  };
}

describe('thread filter (spec 66, 68)', () => {
  it('hides archived threads until a filter finds them', () => {
    const none = { filter: '', projectId: undefined, hits: undefined };
    expect(ids(filteredThreads(threads, projects, none))).toEqual([
      'Kettle timer',
      'Water the plants',
    ]);
    expect(ids(filteredThreads(threads, projects, { ...none, filter: 'musings' }))).toEqual([
      'Old musings',
    ]);
  });

  it('matches title and project at once, a word only in a message from the server, and narrows by chip', () => {
    const none = { filter: '', projectId: undefined, hits: undefined };
    expect(ids(filteredThreads(threads, projects, { ...none, filter: 'garden' }))).toEqual([
      'Water the plants',
    ]);
    expect(
      ids(
        filteredThreads(threads, projects, {
          ...none,
          filter: 'teapot',
          hits: new Set(['Kettle timer']),
        }),
      ),
    ).toEqual(['Kettle timer']);
    expect(ids(filteredThreads(threads, projects, { ...none, projectId: 'p-garden' }))).toEqual([
      'Water the plants',
    ]);
  });
});

describe('unread threads (spec 70)', () => {
  it('goes to the next unread thread in list order, wrapping, never an archived one', () => {
    const list = listOrder([
      thread('a', { seen: false, updatedAt: '2026-11-02T08:03:00.000Z' }),
      thread('b', { updatedAt: '2026-11-02T08:02:00.000Z' }),
      thread('c', { seen: false, updatedAt: '2026-11-02T08:01:00.000Z' }),
      thread('d', { seen: false, archived: true }),
    ]);
    expect(nextUnread(list, 'a')?.id).toBe('c');
    expect(nextUnread(list, 'c')?.id).toBe('a');
    expect(nextUnread(list, undefined)?.id).toBe('a');
    expect(nextUnread([thread('a')], undefined)).toBeUndefined();
  });

  it('marks the open thread unread and leaves it, so it stays bold', () => {
    const { request, navigate, context: ctx } = context();
    const open = thread('Kettle timer');
    const commands = threadListCommands({
      threads: [open],
      projects,
      openThread: open,
      inChat: true,
    });
    commands.find((command) => command.id === 'chat.markUnread')?.run(ctx);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      command: { type: 'thread.markUnread', threadId: 'Kettle timer' },
    });
    expect(navigate).toHaveBeenCalledWith({ to: '/chat' });
    const unread = threadListCommands({
      threads: [{ ...open, seen: false }],
      projects,
      openThread: { ...open, seen: false },
      inChat: true,
    });
    expect(unread.some((command) => command.id === 'chat.markUnread')).toBe(false);
  });

  it('offers "Next unread thread" on its key', () => {
    const commands = threadListCommands({
      threads: [thread('a'), thread('b', { seen: false })],
      projects,
      openThread: thread('a'),
      inChat: true,
    });
    expect(commands.find((command) => command.id === 'chat.nextUnread')).toMatchObject({
      keybinding: 'keybindings.nextBoldThread',
      detail: 'b',
    });
  });
});

describe('palette commands of the thread list (spec 67 to 69)', () => {
  it('finds a thread by its project and an archived one, and says it is archived', () => {
    const commands = threadListCommands({
      threads,
      projects,
      openThread: undefined,
      inChat: false,
    });
    expect(
      commands.find((command) => command.id === 'thread.Water the plants')?.keywords,
    ).toContain('Garden');
    expect(commands.find((command) => command.id === 'thread.Old musings')?.detail).toBe(
      'Thread · Archived',
    );
  });

  it('lists an archived thread only once something is typed', () => {
    const commands = threadListCommands({ threads, projects, openThread: undefined, inChat: true });
    const before = startList(commands, 'Chat', 10).flatMap(([, listed]) =>
      listed.map((command) => command.id),
    );
    expect(before).toContain('thread.Kettle timer');
    expect(before).not.toContain('thread.Old musings');
    const archived = commands.find((command) => command.id === 'thread.Old musings');
    expect(archived?.searchOnly).toBe(true);
    expect(paletteScore(archived as AppCommand, 'musings')).toBeGreaterThan(0);
  });

  it('renames on F2, which works while the composer has the keyboard', () => {
    const open = thread('Kettle timer');
    const { context: ctx } = context();
    const rename = threadListCommands({
      threads: [open],
      projects,
      openThread: open,
      inChat: true,
    }).find((command) => command.id === 'chat.renameThread');
    expect(rename?.keybinding).toBe('keybindings.renameThread');
    rename?.run(ctx);
    expect(threadListStore.getState().renaming).toBe('Kettle timer');
    threadListStore.setState({ renaming: undefined });
    expect(worksInTextFields('F2')).toBe(true);
    expect(worksInTextFields('Alt+Shift+ArrowDown')).toBe(true);
    expect(worksInTextFields('A')).toBe(false);
    expect(worksInTextFields('/')).toBe(false);
  });

  it('archives the open thread and offers Unarchive for an archived one', () => {
    const { request, context: ctx } = context();
    const open = thread('Kettle timer');
    threadListCommands({ threads: [open], projects, openThread: open, inChat: true })
      .find((command) => command.id === 'chat.archiveThread')
      ?.run(ctx);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      command: { type: 'thread.setArchived', threadId: 'Kettle timer', archived: true },
    });
    const archived = { ...open, archived: true };
    expect(
      threadListCommands({ threads: [archived], projects, openThread: archived, inChat: true }).map(
        (command) => command.id,
      ),
    ).toContain('chat.unarchiveThread');
  });

  it('narrows the list to a project from the palette, and back to all projects', () => {
    const { navigate, context: ctx } = context();
    const twoProjects = [
      ...projects,
      { id: 'p-tea', name: 'Tea' },
      { id: 'p-empty', name: 'Empty' },
    ];
    const listed = [...threads, thread('Steep', { projectId: 'p-tea' })];
    const first = threadListCommands({
      threads: listed,
      projects: twoProjects,
      openThread: undefined,
      inChat: false,
    });
    // A project without a thread has no chip, so no command either.
    expect(
      first.filter((command) => command.id.startsWith('chat.threadsOf')).map((c) => c.title),
    ).toEqual(['Show threads of Garden', 'Show threads of Tea']);
    first.find((command) => command.id === 'chat.threadsOf.p-tea')?.run(ctx);
    expect(navigate).toHaveBeenCalledWith({ to: '/chat' });
    expect(threadListStore.getState().projectId).toBe('p-tea');
    const narrowed = threadListCommands({
      threads: listed,
      projects: twoProjects,
      openThread: undefined,
      inChat: true,
      projectId: 'p-tea',
    });
    expect(narrowed.map((command) => command.id)).not.toContain('chat.threadsOf.p-tea');
    narrowed.find((command) => command.id === 'chat.threadsOfAll')?.run(ctx);
    expect(threadListStore.getState().projectId).toBeUndefined();
    expect(
      threadListCommands({ threads, projects, openThread: undefined, inChat: true }).map(
        (command) => command.id,
      ),
    ).not.toContain('chat.threadsOfAll');
  });

  it('reads a pick whose chip is gone as no pick, and offers all projects for a pick', () => {
    const twoProjects = [...projects, { id: 'p-tea', name: 'Tea' }];
    const listed = [...threads, thread('Steep', { projectId: 'p-tea' })];
    const chipCommands = (list: readonly Thread[], projectId: string | undefined) =>
      threadListCommands({
        threads: list,
        projects: twoProjects,
        openThread: undefined,
        inChat: true,
        projectId,
      })
        .map((command) => command.id)
        .filter((id) => id.startsWith('chat.threadsOf'));
    expect(chipCommands(listed, 'p-tea')).toEqual(['chat.threadsOf.p-garden', 'chat.threadsOfAll']);
    // Tea has no thread any more, so there are no chips and nothing is narrowed.
    expect(chipCommands(threads, 'p-tea')).toEqual([]);
    expect(pickedProject(threads, twoProjects, 'p-tea')).toBeUndefined();
    expect(pickedProject(listed, twoProjects, 'p-tea')).toBe('p-tea');
    expect(pickedProject(listed, twoProjects, 'p-gone')).toBeUndefined();
    expect(projectChips(threads, twoProjects)).toEqual([]);
  });

  it('finds a thread by a word only in its messages for the text the server searched', () => {
    const commands = threadListCommands({
      threads,
      projects,
      openThread: undefined,
      inChat: false,
      found: { query: 'teapot dawn', ids: new Set(['Old musings']) },
    });
    const musings = commands.find((command) => command.id === 'thread.Old musings');
    const kettle = commands.find((command) => command.id === 'thread.Kettle timer');
    expect(musings && paletteScore(musings, ' Teapot  dawn ')).toBeGreaterThan(0);
    expect(musings && paletteScore(musings, 'teapot')).toBe(0);
    expect(kettle && paletteScore(kettle, 'teapot dawn')).toBe(0);
    // A match in the command's own words still ranks above one found in messages.
    expect(musings && paletteScore(musings, 'old')).toBeGreaterThan(
      (musings && paletteScore(musings, 'teapot dawn')) ?? 1,
    );
  });

  it('focuses the filter from anywhere, opening the chat first', () => {
    const { navigate, context: ctx } = context();
    const before = threadListStore.getState().focusRequest;
    threadListCommands({ threads, projects, openThread: undefined, inChat: false })
      .find((command) => command.id === 'chat.filterThreads')
      ?.run(ctx);
    expect(navigate).toHaveBeenCalledWith({ to: '/chat' });
    expect(threadListStore.getState().focusRequest).toBe(before + 1);
  });
});

describe('chat notifications in the window (spec 64)', () => {
  it('stays quiet for the thread on screen in a focused window only', () => {
    const row = { threadId: 'Kettle timer' };
    const open = openThreadOf('/chat/Kettle timer');
    expect(onScreen(row, open, true)).toBe(true);
    expect(onScreen(row, open, false)).toBe(false);
    expect(onScreen(row, openThreadOf('/chat/other'), true)).toBe(false);
    expect(onScreen({ threadId: null }, open, true)).toBe(false);
    expect(openThreadOf('/chat/new')).toBeUndefined();
  });
});
