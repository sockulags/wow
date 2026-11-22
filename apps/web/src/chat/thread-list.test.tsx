import type { Project, Thread } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { renderApp } from '@/test/render';
import { createDraftStore } from './draft';
import { threadListStore } from './thread-commands';

// Agent workbench U2: the thread list as rendered, with a fake connection. All invented.

const project = (id: string, name: string): Project => ({
  id,
  name,
  cwd: `/work/${id}`,
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: '2026-11-02T08:00:00.000Z',
});

const thread = (id: string, title: string, overrides: Partial<Thread> = {}): Thread => ({
  id,
  projectId: null,
  cwd: '/work/kettle',
  branch: null,
  providerInstanceId: 'claude',
  providerSessionId: null,
  title,
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

interface Fake {
  readonly runtime: Runtime;
  readonly request: ReturnType<typeof vi.fn<(method: string, params: unknown) => Promise<unknown>>>;
  push(topic: string, rows: unknown[]): void;
  // Resolves when the app dispatches the next command of this type: the test waits on the event,
  // not on a poll.
  next(type: string): Promise<unknown>;
}

function fake(topics: Record<string, unknown[]>, searchHits: readonly string[] = []): Fake {
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const waiting: { type: string; resolve: (command: unknown) => void }[] = [];
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>(
    (method: string, params: unknown) => {
      if (method === 'threads.search') return Promise.resolve({ threadIds: searchHits });
      if (method === 'dispatch') {
        const { command } = params as { command: { type: string } };
        const at = waiting.findIndex((entry) => entry.type === command.type);
        if (at !== -1) waiting.splice(at, 1)[0]?.resolve(command);
        return Promise.resolve({
          commandId: (params as { commandId: string }).commandId,
          seqs: [],
          duplicate: false,
        });
      }
      return Promise.resolve([]);
    },
  );
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request,
    subscribe(topic, _params, onData) {
      listeners.set(topic, [...(listeners.get(topic) ?? []), onData]);
      onData(topics[topic] ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  return {
    request,
    next: (type) => new Promise((resolve) => waiting.push({ type, resolve })),
    push(topic, rows) {
      topics[topic] = rows;
      act(() => {
        for (const listener of listeners.get(topic) ?? []) listener(rows);
      });
    },
    runtime: {
      connection,
      layout: createLayoutStore(),
      draft: createDraftStore(),
      settings: createSettingsStore(
        createMemorySettingsSource(undefined, { 'providers.offerSetup': false }),
      ),
    },
  };
}

const sentCommands = (request: Fake['request']) =>
  request.mock.calls
    .filter(([method]) => method === 'dispatch')
    .map(([, params]) => (params as { command: { type: string; threadId?: string } }).command);

const rowTitles = () =>
  within(screen.getByRole('navigation', { name: 'Threads' }))
    .queryAllByTestId('thread-row-title')
    .map((element) => element.textContent);

// The rows once the list has drawn them.
const listed = async () =>
  (
    await within(await screen.findByRole('navigation', { name: 'Threads' })).findAllByTestId(
      'thread-row-title',
    )
  ).map((element) => element.textContent);

// Resolves once the router has settled on `path`.
const settledAt = (
  router: {
    state: { location: { pathname: string } };
    subscribe: (event: 'onResolved', listener: () => void) => () => void;
  },
  path: string,
) =>
  new Promise<void>((resolve) => {
    if (router.state.location.pathname === path) {
      resolve();
      return;
    }
    const stop = router.subscribe('onResolved', () => {
      if (router.state.location.pathname !== path) return;
      stop();
      resolve();
    });
  });

afterEach(() => {
  threadListStore.setState({ filter: '', projectId: undefined, renaming: undefined });
});

describe('the thread list (spec 66, 69, 70)', () => {
  it('narrows to a project with its chip and back', async () => {
    const { runtime } = fake({
      projects: [project('p-garden', 'Garden'), project('p-tea', 'Tea')],
      threads: [
        thread('t1', 'Water the plants', { projectId: 'p-garden' }),
        thread('t2', 'Steep the leaves', { projectId: 'p-tea' }),
      ],
    });
    await renderApp('/chat', runtime);
    const user = userEvent.setup();
    expect(await listed()).toHaveLength(2);
    const chips = screen.getByRole('radiogroup', { name: 'Project' });
    await user.click(within(chips).getByRole('radio', { name: 'Tea' }));
    expect(rowTitles()).toEqual(['Steep the leaves']);
    await user.click(within(chips).getByRole('radio', { name: 'Tea' }));
    expect(rowTitles()).toHaveLength(2);
  });

  it('lists every thread again when the picked chip goes with the chips', async () => {
    const garden = thread('t1', 'Water the plants', { projectId: 'p-garden' });
    const { runtime, push } = fake({
      projects: [project('p-garden', 'Garden'), project('p-tea', 'Tea')],
      threads: [garden, thread('t2', 'Steep the leaves', { projectId: 'p-tea' })],
    });
    await renderApp('/chat', runtime);
    const user = userEvent.setup();
    expect(await listed()).toHaveLength(2);
    const chips = screen.getByRole('radiogroup', { name: 'Project' });
    await user.click(within(chips).getByRole('radio', { name: 'Tea' }));
    expect(rowTitles()).toEqual(['Steep the leaves']);
    // Tea's only thread moves elsewhere: one project is left, so the chips go, and with them the
    // pick.
    push('threads', [garden, thread('t3', 'Steep the leaves', { cwd: '/work/loose' })]);
    expect(screen.queryByRole('radiogroup', { name: 'Project' })).toBeNull();
    expect(rowTitles()).toHaveLength(2);
  });

  it('shows no chips while every thread is in one project', async () => {
    const { runtime } = fake({
      projects: [project('p-garden', 'Garden'), project('p-tea', 'Tea')],
      threads: [thread('t1', 'Water the plants', { projectId: 'p-garden' })],
    });
    await renderApp('/chat', runtime);
    expect(await listed()).toHaveLength(1);
    expect(screen.queryByRole('radiogroup', { name: 'Project' })).toBeNull();
  });

  it('reads a thread marked unread when it is opened again', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const seen = thread('t1', 'Kettle timer');
    const { runtime, request, push, next } = fake({ projects: [], threads: [seen] });
    const { router } = await renderApp('/chat/t1', runtime);
    const user = userEvent.setup();
    expect(await listed()).toEqual(['Kettle timer']);
    const markSeen = () => sentCommands(request).filter((c) => c.type === 'thread.markSeen');
    // Mark unread leaves the thread, so it stays unread in the list.
    act(() => runtime.layout.setState({ paletteOpen: true }));
    await user.type(await screen.findByPlaceholderText('Type a command or search…'), 'Mark unread');
    const left = settledAt(router, '/chat');
    await user.click(await screen.findByRole('option', { name: /Mark unread/ }));
    await left;
    push('threads', [{ ...seen, seen: false }]);
    expect(markSeen()).toEqual([]);
    expect(sentCommands(request)).toContainEqual({ type: 'thread.markUnread', threadId: 't1' });
    const read = next('thread.markSeen');
    await user.click(screen.getByRole('link', { name: /Kettle timer/ }));
    expect(await read).toEqual({ type: 'thread.markSeen', threadId: 't1' });
    expect(markSeen()).toHaveLength(1);
    hasFocus.mockRestore();
  });

  it('reads the open thread again when a second request turns it unread', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const waiting = thread('t1', 'Kettle timer', {
      state: 'needs_you',
      updatedAt: '2026-11-02T08:05:00.000Z',
    });
    const { runtime, request, push, next } = fake({ projects: [], threads: [waiting] });
    await renderApp('/chat/t1', runtime);
    expect(await listed()).toEqual(['Kettle timer']);
    const markSeen = () => sentCommands(request).filter((c) => c.type === 'thread.markSeen');
    expect(markSeen()).toEqual([]);
    // The first request was read on screen; the second arrives while it still needs you, so
    // the server stores it unread and its updatedAt does not move.
    const first = next('thread.markSeen');
    push('threads', [{ ...waiting, seen: false }]);
    expect(await first).toEqual({ type: 'thread.markSeen', threadId: 't1' });
    const second = next('thread.markSeen');
    push('threads', [{ ...waiting, seen: true }]);
    push('threads', [{ ...waiting, seen: false }]);
    await second;
    expect(markSeen()).toHaveLength(2);
    hasFocus.mockRestore();
  });

  it('finds a thread in the palette by a word only in its messages', async () => {
    const { runtime, request } = fake(
      { projects: [], threads: [thread('t1', 'Untitled musings'), thread('t2', 'Kettle timer')] },
      ['t1'],
    );
    await renderApp('/chat', runtime);
    const user = userEvent.setup();
    act(() => runtime.layout.setState({ paletteOpen: true }));
    await user.type(await screen.findByPlaceholderText('Type a command or search…'), 'teapot');
    expect(await screen.findByRole('option', { name: /Untitled musings/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Kettle timer/ })).toBeNull();
    expect(request).toHaveBeenCalledWith('threads.search', { query: 'teapot' });
  });
});

const detail = (title: string) => {
  const row = screen
    .getAllByTestId('thread-row-title')
    .find((element) => element.textContent === title)
    ?.closest('a');
  const line = row ? within(row).getByTestId('thread-row-detail') : undefined;
  return [...(line?.querySelectorAll('[data-part]') ?? [])].map((part) => [
    part.getAttribute('data-part'),
    part.textContent?.replace(/^ · /, ''),
  ]);
};

describe('rows that say where a thread stands (chat overview spec 6, 7)', () => {
  const working = thread('t1', 'Ring the bell', {
    state: 'working',
    projectId: 'p-tea',
    branch: 'wow/ring-the-bell-t1',
    workingCopy: {
      path: '/work/copies/tea-t1',
      state: 'ready',
      startSha: 'a'.repeat(40),
      defaultBranch: null,
      note: null,
      unpushed: null,
      error: null,
      branch: 'wow/ring-the-bell-t1',
    },
    tasks: { done: 3, total: 7 },
    changeCount: { files: 5, added: 42, removed: 7 },
  });
  const waiting = thread('t2', 'Clean the build', { state: 'needs_you', projectId: 'p-tea' });
  const topics = () => ({
    projects: [project('p-tea', 'Tea')],
    threads: [working, waiting],
    threadActivity: [
      {
        threadId: 't1',
        turnId: 't1:turn:0',
        turnState: 'running',
        startedAt: '2026-11-02T08:00:00.000Z',
        endedAt: null,
        toolCalls: 4,
        runningTool: {
          name: 'Bash',
          input: {},
          output: '',
          status: 'running',
          kind: 'command',
          command: 'pnpm test',
        },
        lastText: null,
      },
    ],
    decisions: [
      {
        id: 'approval:a1',
        kind: 'approval',
        at: '2026-11-02T08:00:00.000Z',
        title: 'Wants to run rm -rf build',
        where: 'Tea',
        path: '/chat/t2',
        threadId: 't2',
        runId: null,
        proposalId: null,
        approvalId: 'a1',
        questionId: null,
        cardId: null,
        holdsTurn: true,
        cardStart: null,
        fixed: [],
        brief: null,
        briefPending: false,
      },
    ],
  });

  it('says what it runs or waits for, its tasks, its changes, its branch and when', async () => {
    const { runtime } = fake(topics());
    await renderApp('/chat', runtime);
    await listed();
    expect(detail('Ring the bell')).toEqual([
      ['activity', 'Running pnpm test'],
      ['tasks', '3/7'],
      ['changes', '+42 −7'],
      ['place', 'wow/ring-the-bell-t1'],
      ['time', expect.any(String)],
    ]);
    expect(detail('Clean the build')).toEqual([
      ['activity', 'Wants to run rm -rf build'],
      ['place', 'Tea'],
      ['time', expect.any(String)],
    ]);
  });

  it('leaves out the parts the setting turns off', async () => {
    const { runtime } = fake(topics());
    await renderApp('/chat', {
      ...runtime,
      settings: createSettingsStore(
        createMemorySettingsSource(undefined, {
          'providers.offerSetup': false,
          'chat.threadRowDetail': ['activity', 'place'],
        }),
      ),
    });
    await listed();
    expect(detail('Ring the bell')).toEqual([
      ['activity', 'Running pnpm test'],
      ['place', 'wow/ring-the-bell-t1'],
    ]);
  });
});
