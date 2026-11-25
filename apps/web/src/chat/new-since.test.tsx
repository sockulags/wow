import type { ProviderInstance, Thread, ThreadItem, Turn } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, render, screen } from '@testing-library/react';
import { createStore } from 'zustand';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLayoutStore, RuntimeProvider } from '@/app/runtime';
import { conversationStore } from './conversation-nav';
import { createDraftStore } from './draft';
import { ThreadConversation } from './thread-view';

// "New since you looked" (chat overview spec 17 to 20): a thread opened unread starts at what
// came after where the user left off. All invented.

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

const conversation = () => [
  item(0, 'user', { text: 'Make the bell ring twice' }),
  item(0, 'assistant_text', { text: 'It rings twice now.' }),
  item(1, 'user', { text: 'And add the notes' }),
  item(1, 'assistant_text', { text: 'The notes are there.' }),
];

function setup(shown: Thread) {
  const items = conversation();
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: (() => Promise.resolve(undefined)) as Connection['request'],
    subscribe(topic, _params, onData) {
      const topics: Record<string, unknown> = {
        turns: [turn(0), turn(1)],
        threadItems: items,
        threads: [shown],
      };
      onData(topics[topic] ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  const runtime = {
    connection,
    layout: createLayoutStore(),
    draft: createDraftStore(),
    settings: createSettingsStore(createMemorySettingsSource(undefined, {})),
  };
  const view = render(
    <RuntimeProvider runtime={runtime}>
      <ThreadConversation thread={shown} instance={claude} />
    </RuntimeProvider>,
  );
  return {
    rerender: (next: Thread) =>
      view.rerender(
        <RuntimeProvider runtime={runtime}>
          <ThreadConversation thread={next} instance={claude} />
        </RuntimeProvider>,
      ),
  };
}

// The text of each row in order, with the divider as "--- new ---".
const rows = () =>
  [...screen.getByRole('list', { name: 'Conversation' }).children].map((row) =>
    row.getAttribute('data-testid') === 'new-since' ? '--- new ---' : (row.textContent ?? ''),
  );

beforeEach(() => {
  nextIndex = 0;
});

describe('New since you looked (spec 17 to 20)', () => {
  it('sits before the first item after where the user left off, and the palette can go there', () => {
    setup({ ...thread, seen: false, seenThrough: 2 });
    const shown = rows();
    const at = shown.indexOf('--- new ---');
    expect(at).toBeGreaterThan(0);
    expect(shown[at + 1]).toContain('And add the notes');
    expect(shown.slice(0, at).join(' ')).toContain('It rings twice now.');
    expect(conversationStore.getState().hasNew).toBe(true);
  });

  it('is not there for a thread already seen, or one from before', () => {
    setup({ ...thread, seen: true, seenThrough: 1 });
    expect(screen.queryByTestId('new-since')).toBeNull();
  });

  it('is not there for a thread that never kept where the user left off', () => {
    setup({ ...thread, seen: false });
    expect(screen.queryByTestId('new-since')).toBeNull();
  });

  it('stays once the thread is marked seen, and goes when a turn starts', () => {
    const { rerender } = setup({ ...thread, seen: false, seenThrough: 1 });
    act(() => rerender({ ...thread, seen: true, seenThrough: 3 }));
    expect(screen.getByTestId('new-since')).toBeTruthy();
    act(() => rerender({ ...thread, seen: true, seenThrough: 3, state: 'working' }));
    expect(screen.queryByTestId('new-since')).toBeNull();
  });
});
