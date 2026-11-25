import type { ProviderInstance, Thread, ThreadItem, Turn } from '@wow/contracts';
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
import { conversationCommands, conversationStore, showConversation } from './conversation-nav';
import { createDraftStore } from './draft';
import { outlineRows, ThreadOutline } from './outline';
import { ThreadConversation } from './thread-view';

// The outline and marks (chat overview spec 21 to 23). All invented.

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

const conversation = (): ThreadItem[] => [
  item(0, 'user', { text: 'Make the bell ring twice\nand quietly' }),
  item(0, 'tool_call', {
    name: 'Edit',
    input: {},
    output: '',
    status: 'ok',
    kind: 'edit',
    path: 'bell.ts',
  }),
  item(0, 'assistant_text', { text: 'It rings twice now.', marked: true }),
  item(
    0,
    'usage',
    { inputTokens: 1, outputTokens: 1, changes: { files: 1, added: 1, removed: 0 } },
    `${turnId(0)}:usage`,
  ),
  item(1, 'user', { text: 'Add the notes' }),
  item(1, 'assistant_text', { text: 'The notes are there.' }),
];

function runtimeWith(items: ThreadItem[]) {
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>(() =>
    Promise.resolve({ commandId: 'x', seqs: [], duplicate: false }),
  );
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: request as Connection['request'],
    subscribe(topic, _params, onData) {
      const topics: Record<string, unknown> = {
        turns: [turn(0), turn(1)],
        threadItems: items,
        threads: [thread],
      };
      onData(topics[topic] ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  return {
    request,
    runtime: {
      connection,
      layout: createLayoutStore(),
      draft: createDraftStore(),
      settings: createSettingsStore(createMemorySettingsSource(undefined, {})),
    },
  };
}

beforeEach(() => {
  nextIndex = 0;
});

describe('the outline rows (spec 21)', () => {
  it('lists each message with what its turn did, and the marked answers', () => {
    expect(
      outlineRows(conversation(), [turn(0), turn(1)]).map((row) => [
        row.kind,
        row.text,
        row.summary,
      ]),
    ).toEqual([
      ['message', 'Make the bell ring twice', 'Changed 1 file +1 −0 · Edited 1 file'],
      ['mark', 'It rings twice now.', undefined],
      ['message', 'Add the notes', undefined],
    ]);
  });

  it('leaves out a turn Edit replaced', () => {
    const rows = outlineRows(conversation(), [turn(0, { replacedBy: turnId(1) }), turn(1)]);
    expect(rows.map((row) => row.text)).toEqual(['Add the notes']);
  });
});

describe('the outline tab (spec 21)', () => {
  it("goes to a row's message in the conversation, and filters", async () => {
    const user = userEvent.setup();
    const focusItem = vi.fn<(itemId: string) => void>();
    const stop = showConversation(thread.id, {
      previousMessage: () => undefined,
      nextMessage: () => undefined,
      toEnd: () => undefined,
      copyFocused: () => undefined,
      focusItem,
    });
    const items = conversation();
    const { runtime } = runtimeWith(items);
    render(
      <RuntimeProvider runtime={runtime}>
        <ThreadOutline outline={{ threadId: thread.id, from: '/chat/bell' }} />
      </RuntimeProvider>,
    );
    const rows = screen.getAllByTestId('outline-row');
    expect(rows).toHaveLength(3);
    await user.click(rows[2] as HTMLElement);
    expect(focusItem).toHaveBeenCalledWith(items[4]?.id);
    await user.type(screen.getByRole('searchbox', { name: 'Filter the outline' }), 'notes');
    expect(screen.getAllByTestId('outline-row').map((row) => row.textContent)).toEqual([
      expect.stringContaining('Add the notes'),
    ]);
    stop();
  });
});

describe('marks on messages (spec 22, 23)', () => {
  it('shows the sign on a marked answer, and Mark sends the command', async () => {
    const user = userEvent.setup();
    const items = conversation();
    const { runtime, request } = runtimeWith(items);
    render(
      <RuntimeProvider runtime={runtime}>
        <ThreadConversation thread={thread} instance={claude} />
      </RuntimeProvider>,
    );
    expect(screen.getAllByTestId('message-marked')).toHaveLength(1);
    const answer = screen
      .getAllByTestId('item-assistant_text')
      .find((row) => row.textContent?.includes('The notes are there.'));
    await user.click(within(answer as HTMLElement).getByRole('button', { name: 'Mark' }));
    const sent = request.mock.calls
      .filter(([method]) => method === 'dispatch')
      .map(([, params]) => (params as { command: unknown }).command);
    expect(sent).toContainEqual({
      type: 'thread.markItem',
      threadId: thread.id,
      itemId: items[5]?.id,
      marked: true,
    });
  });

  it('offers Mark message for the focused message and the keys between marks', () => {
    const state = conversationStore.getState();
    const commands = conversationCommands(
      {
        ...state,
        threadId: thread.id,
        handle: {
          previousMessage: () => undefined,
          nextMessage: () => undefined,
          toEnd: () => undefined,
          copyFocused: () => undefined,
          isMarked: (id) => id === 'answer',
          markFocused: () => undefined,
          previousMark: () => undefined,
          nextMark: () => undefined,
        },
        focusedMessage: 'answer',
        reasoningOpen: false,
      },
      false,
    );
    expect(
      commands
        .filter((command) =>
          ['chat.markMessage', 'chat.previousMark', 'chat.nextMark'].includes(command.id),
        )
        .map((command) => [command.title, command.keybinding]),
    ).toEqual([
      ['Unmark message', 'keybindings.markMessage'],
      ['Previous marked message', 'keybindings.previousMark'],
      ['Next marked message', 'keybindings.nextMark'],
    ]);
  });
});
