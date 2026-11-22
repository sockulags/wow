import type { Decision, Project, Thread, ThreadActivity } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { panelTabsOf } from '@/panel/viewer';
import { renderApp } from '@/test/render';
import { atWorkCommands, atWorkRows } from './at-work';
import { createDraftStore } from './draft';

// Threads at work (parallel threads spec 11 to 13) and a thread in the side panel (spec 15, 16),
// as rendered with a fake connection. All invented.

const project: Project = {
  id: 'tea',
  name: 'Tea',
  cwd: '/work/tea',
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: '2026-11-22T08:00:00.000Z',
};

const thread = (id: string, title: string, overrides: Partial<Thread> = {}): Thread => ({
  id,
  projectId: 'tea',
  cwd: '/work/tea',
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
  createdAt: '2026-11-22T08:00:00.000Z',
  updatedAt: '2026-11-22T08:00:00.000Z',
  ...overrides,
});

const activity = (threadId: string, overrides: Partial<ThreadActivity> = {}): ThreadActivity => ({
  threadId,
  turnId: `${threadId}:turn:0`,
  turnState: 'running',
  startedAt: '2026-11-22T09:00:00.000Z',
  endedAt: null,
  toolCalls: 0,
  runningTool: null,
  lastText: null,
  ...overrides,
});

const waiting: Decision = {
  id: 'approval:mug:1',
  kind: 'approval',
  at: '2026-11-22T09:01:00.000Z',
  title: 'Wants to run rm -rf build',
  where: 'Mug handle',
  path: '/chat/mug',
  threadId: 'mug',
  runId: null,
  proposalId: null,
  approvalId: 'mug:1',
  questionId: null,
  cardId: null,
  holdsTurn: true,
  cardStart: null,
  fixed: [],
  brief: null,
  briefPending: false,
};

const threads = [
  thread('notes', 'Tea notes', {
    state: 'idle',
    seen: false,
    stateSince: '2026-11-22T08:30:00.000Z',
  }),
  thread('kettle', 'Kettle timer', {
    state: 'working',
    branch: 'wow/kettle-timer-1a2b3c',
    stateSince: '2026-11-22T09:00:00.000Z',
  }),
  thread('mug', 'Mug handle', { state: 'needs_you', stateSince: '2026-11-22T09:01:00.000Z' }),
];

const rows = [
  activity('kettle', {
    toolCalls: 6,
    runningTool: {
      name: 'Bash',
      input: {},
      output: '',
      kind: 'command',
      command: 'pnpm test',
      status: 'running',
    },
  }),
  activity('mug'),
  activity('notes', {
    turnState: 'completed',
    endedAt: '2026-11-22T08:30:00.000Z',
    lastText: 'They are in docs/notes.md.',
  }),
];

function fakeRuntime(): Runtime {
  const topics: Record<string, unknown[]> = {
    threads,
    threadActivity: rows,
    decisions: [waiting],
    projects: [project],
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: vi.fn<() => Promise<unknown>>(() => Promise.resolve([])) as Connection['request'],
    subscribe(topic, _params, onData) {
      onData(topics[topic] ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  return {
    connection,
    layout: createLayoutStore(),
    draft: createDraftStore(),
    settings: createSettingsStore(
      createMemorySettingsSource(undefined, { 'providers.offerSetup': false }),
    ),
  };
}

describe('Threads at work (spec 11 to 13)', () => {
  it('orders the threads by group: needs you, working, finished not read', () => {
    expect(atWorkRows(threads, rows, [waiting]).map((row) => [row.thread.id, row.group])).toEqual([
      ['mug', 'needs'],
      ['kettle', 'working'],
      ['notes', 'finished'],
    ]);
  });

  it('shows what each does, waits for or last said, and opens a thread with Enter', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/chat/work', fakeRuntime());
    const view = await screen.findByTestId('threads-at-work');
    expect(
      within(view)
        .getAllByTestId('at-work-group')
        .map((group) => group.textContent),
    ).toEqual(['Needs you', 'Working', 'Finished, not read']);
    const [mug, kettle, notes] = within(view).getAllByTestId('at-work-row');
    expect(mug?.textContent).toContain('Wants to run rm -rf build');
    expect(kettle?.textContent).toContain('Tea · wow/kettle-timer-1a2b3c');
    expect(kettle?.textContent).toContain('Running pnpm test');
    expect(kettle?.textContent).toContain('6 tool calls');
    expect(notes?.textContent).toContain('They are in docs/notes.md.');
    expect(screen.getByTestId('at-work-link').textContent).toContain('At work · 3');
    act(() => mug?.focus());
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(kettle);
    await user.keyboard('{Enter}');
    expect(router.state.location.pathname).toBe('/chat/kettle');
  });

  it('opens the thread that has the keyboard in a tab of the side panel with P (spec 13, 15)', async () => {
    const user = userEvent.setup();
    const runtime = fakeRuntime();
    await renderApp('/chat/work', runtime);
    const [, kettle] = await screen.findAllByTestId('at-work-row');
    act(() => kettle?.focus());
    await user.keyboard('p');
    expect(panelTabsOf(runtime.layout.getState(), '/chat/work')).toMatchObject({
      selected: 'thread:kettle',
      tabs: [{ kind: 'thread', thread: { threadId: 'kettle', title: 'Kettle timer' } }],
    });
    const tab = await screen.findByTestId('panel-thread-tab');
    expect(within(tab).getByRole('link', { name: 'Open thread' }).getAttribute('href')).toBe(
      '/chat/kettle',
    );
    expect(screen.getAllByTestId('panel-tab').map((element) => element.textContent)).toContain(
      'Kettle timer',
    );
  });
});

describe('Open thread in panel… (spec 15, 16)', () => {
  it('opens the palette on the threads and leaves out the thread on screen', () => {
    const commands = atWorkCommands({ threads, openThreadId: 'kettle', route: '/chat/kettle' });
    expect(
      commands.filter((command) => command.searchOnly).map((command) => command.title),
    ).toEqual(['In panel: Tea notes', 'In panel: Mug handle']);
    const layout = createLayoutStore();
    commands.find((command) => command.id === 'chat.openThreadInPanel')?.run({ layout } as never);
    expect(layout.getState()).toMatchObject({ paletteOpen: true, paletteSearch: 'In panel: ' });
  });
});
