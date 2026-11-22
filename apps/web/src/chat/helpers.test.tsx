import type {
  Command,
  ProviderInstance,
  Thread,
  ThreadActivity,
  ThreadItem,
  Turn,
} from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore } from 'zustand';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLayoutStore, RuntimeProvider } from '@/app/runtime';
import { panelTabsOf } from '@/panel/viewer';
import { atWorkRows } from './at-work';
import { createDraftStore } from './draft';
import { nestHelpers } from './helpers';
import { ThreadConversation } from './thread-view';

// Seeing helpers (agent orchestration spec 10 to 12): the helper row in its main thread, and
// helpers under their main thread in lists. All invented.

const thread: Thread = {
  id: 'bell',
  projectId: 'tea',
  cwd: '/home/wow/workspaces/tea-t1',
  branch: 'wow/ring-the-bell-t1',
  providerInstanceId: 'claude',
  providerSessionId: 'session-1',
  title: 'Ring the bell',
  model: 'sonnet',
  effort: 'high',
  permissionMode: 'acceptEdits',
  state: 'idle',
  pinned: false,
  runId: null,
  stepId: null,
  createdAt: '2026-11-13T08:00:00.000Z',
  updatedAt: '2026-11-13T08:00:00.000Z',
};

const claude: ProviderInstance = {
  id: 'claude',
  kind: 'claude',
  name: 'Claude',
  binaryPath: 'claude',
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: 'sonnet',
  defaultEffort: null,
  defaultPermissionMode: null,
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
};

const turnId = (index: number) => `bell:turn:${index}`;
const turn = (index: number, overrides: Partial<Turn> = {}): Turn => ({
  id: turnId(index),
  threadId: thread.id,
  index,
  state: 'completed',
  startedAt: `2026-11-13T08:0${index}:00.000Z`,
  endedAt: `2026-11-13T08:0${index}:30.000Z`,
  usage: null,
  resumable: true,
  restorable: true,
  ...overrides,
});

let nextIndex = 0;
const item = (turnIndex: number, kind: ThreadItem['kind'], payload: unknown, id?: string) => {
  nextIndex += 1;
  return {
    id: id ?? `${turnId(turnIndex)}:${kind === 'user' ? 'user' : `${kind}-${nextIndex}`}`,
    threadId: thread.id,
    turnId: turnId(turnIndex),
    index: nextIndex,
    kind,
    payload,
    streaming: false,
  } satisfies ThreadItem;
};

const helper: Thread = {
  ...thread,
  id: 'helper-1',
  title: 'Review the timer change',
  providerInstanceId: 'codex',
  state: 'working',
  startedBy: 'helper',
  parentThreadId: thread.id,
};

const working: ThreadActivity = {
  threadId: 'helper-1',
  turnId: 'helper-1:turn:0',
  turnState: 'running',
  startedAt: '2026-11-13T08:00:00.000Z',
  endedAt: null,
  toolCalls: 4,
  runningTool: {
    name: 'Bash',
    input: {},
    output: '',
    kind: 'command',
    command: 'pnpm test',
    status: 'running',
  },
  lastText: null,
};

const started = () =>
  item(0, 'helper_started', {
    helperThreadId: 'helper-1',
    title: 'Review the timer change',
    instanceName: 'Codex at work',
    providerKind: 'codex',
    isolation: 'folder',
    at: '2026-11-13T08:00:00.000Z',
  });

function setup(items: ThreadItem[]) {
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>(() =>
    Promise.resolve({
      commandId: '00000000-0000-4000-8000-000000000000',
      seqs: [],
      duplicate: false,
    }),
  );
  const topics: Record<string, unknown> = {
    turns: [turn(0)],
    threadItems: items,
    threads: [thread, helper],
    threadActivity: [working],
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: request as Connection['request'],
    subscribe(topic, _params, onData) {
      onData(topics[topic] ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  const layout = createLayoutStore();
  render(
    <RuntimeProvider
      runtime={{
        connection,
        layout,
        draft: createDraftStore(),
        settings: createSettingsStore(createMemorySettingsSource(undefined, {})),
      }}
    >
      <ThreadConversation thread={thread} instance={claude} />
    </RuntimeProvider>,
  );
  const dispatched = () =>
    request.mock.calls.flatMap(([method, params]) =>
      method === 'dispatch' ? [(params as { command: Command }).command] : [],
    );
  return { layout, dispatched };
}

beforeEach(() => {
  nextIndex = 0;
});

describe('the helper row (spec 10)', () => {
  it('says which helper on which instance and what it runs now, opens it beside and stops it', async () => {
    const user = userEvent.setup();
    const { layout, dispatched } = setup([
      item(0, 'user', { text: 'Get a second opinion from Codex' }),
      started(),
    ]);
    const row = await screen.findByTestId('helper-row');
    expect(row.textContent).toContain('Helper · Codex at work · Review the timer change');
    expect(within(row).getByTestId('helper-row-line').textContent).toContain('Running pnpm test');
    expect(within(row).getByTestId('helper-row-line').textContent).toContain('4 tool calls');
    expect(within(row).getByRole('link', { name: 'Open thread' }).getAttribute('href')).toBe(
      '/chat/helper-1',
    );
    await user.click(within(row).getByRole('button', { name: 'Open in panel' }));
    expect(Object.values(layout.getState().panelTabs)[0]).toMatchObject({
      selected: 'thread:helper-1',
    });
    expect(panelTabsOf(layout.getState(), '')).toMatchObject({ selected: 'thread:helper-1' });
    await user.click(within(row).getByRole('button', { name: 'Stop' }));
    expect(dispatched()).toEqual([{ type: 'thread.interrupt', threadId: 'helper-1' }]);
  });
});

describe('helpers under their main thread (spec 11, 12)', () => {
  it('puts a helper right after its main thread, and names the main thread of one alone', () => {
    const other = { ...thread, id: 'other', title: 'Other thread' };
    expect(
      nestHelpers([helper, other, thread], (entry) => entry, [thread, helper, other]).map(
        ({ entry, depth, helperOf }) => [entry.id, depth, helperOf],
      ),
    ).toEqual([
      ['other', 0, undefined],
      [thread.id, 0, undefined],
      ['helper-1', 1, undefined],
    ]);
    expect(
      nestHelpers([helper], (entry) => entry, [thread, helper]).map(({ helperOf }) => helperOf),
    ).toEqual([thread.title]);
  });

  it('does the same in Threads at work, within a group', () => {
    const main = { ...thread, state: 'working' as const };
    const rows = atWorkRows(
      [helper, main],
      [working, { ...working, threadId: thread.id, runningTool: null }],
      [],
    );
    expect(rows.map((row) => [row.thread.id, row.depth])).toEqual([
      [thread.id, 0],
      ['helper-1', 1],
    ]);
  });
});
