import type { Command, ProviderInstance, Thread, ThreadItem, Turn } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from 'zustand';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import type { CommandContext } from '@/app/commands';
import { createLayoutStore, RuntimeProvider } from '@/app/runtime';
import { useGlobalKeybindings } from '@/app/use-commands';
import { conversationCommands, conversationStore } from './conversation-nav';
import { createDraftStore } from './draft';
import { goBackView } from './go-back';
import { ThreadConversation } from './thread-view';

// Edit and Fork (agent workbench U12, spec 62, 63, 71, 74): Up in an empty composer and E bring
// the last message back to send again, "Earlier version" keeps what it replaced, F and "Fork from
// here" start a new thread from a message, and Codex offers neither and says why. All invented.

const thread: Thread = {
  id: 'kettle',
  projectId: 'tea',
  cwd: '/work/kettle',
  branch: null,
  providerInstanceId: 'claude',
  providerSessionId: 'session-1',
  title: 'Kettle timer',
  model: 'sonnet',
  effort: 'high',
  permissionMode: 'acceptEdits',
  state: 'idle',
  pinned: false,
  runId: null,
  stepId: null,
  createdAt: '2026-11-12T08:00:00.000Z',
  updatedAt: '2026-11-12T08:00:00.000Z',
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
const codex: ProviderInstance = { ...claude, id: 'codex', kind: 'codex', name: 'Codex' };

const turnId = (index: number) => `kettle:turn:${index}`;
const turn = (index: number, overrides: Partial<Turn> = {}): Turn => ({
  id: turnId(index),
  threadId: thread.id,
  index,
  state: 'completed',
  startedAt: `2026-11-12T08:0${index}:00.000Z`,
  endedAt: `2026-11-12T08:0${index}:30.000Z`,
  usage: null,
  resumable: true,
  ...overrides,
});

let nextIndex = 0;
const item = (
  turnIndex: number,
  kind: ThreadItem['kind'],
  payload: unknown,
  id = `${turnId(turnIndex)}:${kind === 'user' ? 'user' : `${kind}-${nextIndex}`}`,
): ThreadItem => {
  nextIndex += 1;
  return {
    id,
    threadId: thread.id,
    turnId: turnId(turnIndex),
    index: nextIndex,
    kind,
    payload,
    streaming: false,
  };
};

const exchange = (index: number, text: string, answer: string) => [
  item(index, 'user', { text }),
  item(index, 'assistant_text', { text: answer }),
];

const threeMessages = () => [
  ...exchange(0, 'Plan the timer', 'A plan for the timer.'),
  ...exchange(1, 'Build it', 'Built the timer.'),
  ...exchange(2, 'Add a bell', 'Added a bell.'),
];

// The app's key listener with the conversation's commands, as the shell has it.
function ConversationKeys() {
  const state = useStore(conversationStore);
  const settings = createSettingsStore(createMemorySettingsSource(undefined, {}));
  useGlobalKeybindings(conversationCommands({ ...state, reasoningOpen: false }, false), {
    settings,
  } as unknown as CommandContext);
  return null;
}

function setup({
  instance = claude,
  turns = [turn(0), turn(1), turn(2)],
  items = threeMessages(),
  shown = {},
}: {
  instance?: ProviderInstance;
  turns?: Turn[];
  items?: ThreadItem[];
  shown?: Partial<Thread>;
} = {}) {
  const listeners = new Map<string, (rows: unknown) => void>();
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>(() =>
    Promise.resolve({
      commandId: '00000000-0000-4000-8000-000000000000',
      seqs: [],
      duplicate: false,
    }),
  );
  const topics: Record<string, unknown> = { turns, threadItems: items, threads: [thread] };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: request as Connection['request'],
    subscribe(topic, _params, onData) {
      listeners.set(topic, onData as (rows: unknown) => void);
      onData(topics[topic] ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  render(
    <RuntimeProvider
      runtime={{
        connection,
        layout: createLayoutStore(),
        draft: createDraftStore(),
        settings: createSettingsStore(createMemorySettingsSource(undefined, {})),
      }}
    >
      <ThreadConversation
        thread={{ ...thread, providerInstanceId: instance.id, ...shown }}
        instance={instance}
      />
      <ConversationKeys />
    </RuntimeProvider>,
  );
  const push = (topic: string, rows: unknown) => act(() => listeners.get(topic)?.(rows));
  const dispatched = () =>
    request.mock.calls.flatMap(([method, params]) =>
      method === 'dispatch' ? [(params as { command: Command }).command] : [],
    );
  return { push, dispatched };
}

const composer = () => screen.getByRole<HTMLTextAreaElement>('combobox', { name: /message/i });
const userRows = () => screen.getAllByTestId('item-user');
const commands = () =>
  conversationCommands({ ...conversationStore.getState(), reasoningOpen: false }, false);

beforeEach(() => {
  nextIndex = 0;
});

describe('Edit (spec 62, 63)', () => {
  it('loads the last message with Up in an empty composer and sends it as an edit', async () => {
    const user = userEvent.setup();
    const { dispatched } = setup();
    await user.click(composer());
    await user.keyboard('{ArrowUp}');
    expect(composer().value).toBe('Add a bell');
    expect(screen.getByTestId('edit-notice').textContent).toMatch(
      /Sending it replaces that message and its answer/,
    );
    // Nothing changed files in that turn, so there is nothing to say about them.
    expect(screen.queryByTestId('edit-files-note')).toBeNull();
    await user.clear(composer());
    await user.type(composer(), 'Add a light{Enter}');
    expect(dispatched().at(-1)).toEqual({
      type: 'thread.editLast',
      threadId: 'kettle',
      turnId: turnId(2),
      text: 'Add a light',
    });
  });

  it('does nothing with Up when the composer holds text, and Cancel leaves the edit', async () => {
    const user = userEvent.setup();
    setup();
    await user.type(composer(), 'Next');
    await user.keyboard('{ArrowUp}');
    expect(screen.queryByTestId('edit-notice')).toBeNull();
    await user.clear(composer());
    await user.keyboard('{ArrowUp}');
    await user.click(
      within(screen.getByTestId('edit-notice')).getByRole('button', { name: 'Cancel' }),
    );
    expect(screen.queryByTestId('edit-notice')).toBeNull();
    expect(composer().value).toBe('');
  });

  it('says files stay as they are when the replaced turn changed files', async () => {
    const user = userEvent.setup();
    const items = [
      ...threeMessages(),
      item(2, 'tool_call', {
        name: 'Edit',
        input: {},
        output: '',
        status: 'ok',
        kind: 'edit',
        path: 'src/bell.ts',
      }),
    ];
    setup({ items });
    await user.click(composer());
    await user.keyboard('{ArrowUp}');
    expect(screen.getByTestId('edit-files-note').textContent).toBe(
      'Files stay as they are: what that turn changed is not undone.',
    );
  });

  it('shows the replaced exchange as "Earlier version" on the message that replaced it', async () => {
    const user = userEvent.setup();
    setup({
      turns: [turn(0), turn(1), turn(2, { replacedBy: turnId(3) }), turn(3)],
      items: [...threeMessages(), ...exchange(3, 'Add a light', 'Added a light.')],
    });
    // The replaced exchange is not in the conversation itself.
    expect(userRows()).toHaveLength(3);
    expect(userRows()[2]?.textContent).toMatch(/^Add a light/);
    const earlier = within(userRows().at(-1) as HTMLElement).getByTestId('earlier-version');
    expect(earlier.textContent).toMatch(/^Earlier version/);
    await user.click(within(earlier).getByText('Earlier version'));
    const replaced = within(earlier).getByTestId('earlier-exchange');
    expect(replaced.textContent).toContain('Add a bell');
    expect(replaced.textContent).toContain('Added a bell.');
  });

  it('is offered with E on the last message only; E on another message does nothing', async () => {
    const user = userEvent.setup();
    setup();
    act(() => userRows()[1]?.focus());
    expect(commands().map((command) => command.id)).not.toContain('chat.editFocused');
    fireEvent.keyDown(document.activeElement as Element, { key: 'e', code: 'KeyE' });
    expect(screen.queryByTestId('edit-notice')).toBeNull();
    act(() => userRows()[2]?.focus());
    expect(commands().find((command) => command.id === 'chat.editFocused')?.keybinding).toBe(
      'keybindings.editMessage',
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'e', code: 'KeyE' });
    expect(await screen.findByTestId('edit-notice')).toBeTruthy();
    expect(composer().value).toBe('Add a bell');
    await user.keyboard('{Escape}');
  });

  it('is not offered when the exchange before was answered before points were kept', () => {
    const view = goBackView(
      [turn(0, { resumable: false }), turn(1)],
      [...exchange(0, 'Plan the timer', 'A plan.'), ...exchange(1, 'Build it', 'Built.')],
    );
    expect(view.editable).toBeUndefined();
    expect([...view.forkable.keys()]).toEqual([`${turnId(1)}:user`]);
    // The only message of a thread can always be edited: that starts a new conversation.
    expect(
      goBackView([turn(0, { resumable: false })], exchange(0, 'Plan', 'A plan.')).editable,
    ).toMatchObject({ turnId: turnId(0), text: 'Plan' });
  });
});

describe('Fork (spec 71, 74)', () => {
  it('forks from the second of three messages with "Fork from here", on the same settings and folder', async () => {
    const user = userEvent.setup();
    const { dispatched } = setup();
    await user.click(
      within(userRows()[1] as HTMLElement).getByRole('button', { name: 'Fork from here' }),
    );
    expect(dispatched().at(-1)).toMatchObject({
      type: 'thread.create',
      providerInstanceId: 'claude',
      projectId: 'tea',
      cwd: '/work/kettle',
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'acceptEdits',
      forkFrom: { threadId: 'kettle', turnId: turnId(1) },
    });
  });

  it('forks from the focused message with F', () => {
    const { dispatched } = setup();
    act(() => userRows()[1]?.focus());
    expect(commands().find((command) => command.id === 'chat.fork')).toMatchObject({
      title: 'Fork from this message',
      keybinding: 'keybindings.forkMessage',
    });
    fireEvent.keyDown(document.activeElement as Element, { key: 'f', code: 'KeyF' });
    expect(dispatched().at(-1)).toMatchObject({
      type: 'thread.create',
      forkFrom: { threadId: 'kettle', turnId: turnId(1) },
    });
  });
});

describe('A go-back the provider refused', () => {
  const failedEdit = () => ({
    turns: [
      turn(0),
      turn(1),
      turn(2, { replacedBy: turnId(3) }),
      turn(3, { state: 'failed', resumable: false }),
    ],
    items: [
      ...threeMessages(),
      item(3, 'user', { text: 'Add a light' }),
      item(3, 'error', { message: 'No message to go back to' }),
    ],
  });

  it('offers to go on without going back, on the error and in the palette', async () => {
    const user = userEvent.setup();
    const { dispatched } = setup({
      ...failedEdit(),
      shown: { goBack: { resumeId: 'session-1', at: 'point-1', fork: false } },
    });
    await user.click(screen.getByRole('button', { name: 'Go on without going back' }));
    expect(dispatched().at(-1)).toEqual({ type: 'thread.dropGoBack', threadId: 'kettle' });
    expect(commands().find((command) => command.id === 'chat.dropGoBack')?.title).toBe(
      'Go on without going back',
    );
  });

  it('offers a fork that has no conversation of its own to start a new one', () => {
    setup({
      ...failedEdit(),
      shown: {
        providerSessionId: null,
        goBack: { resumeId: 'session-0', at: 'point-1', fork: true },
      },
    });
    expect(screen.getByRole('button', { name: 'Start a new conversation' })).toBeTruthy();
  });

  it('is not offered when the thread does not go back or its last turn did not fail', () => {
    setup(failedEdit());
    expect(screen.queryByRole('button', { name: 'Go on without going back' })).toBeNull();
    expect(commands().some((command) => command.id === 'chat.dropGoBack')).toBe(false);
  });
});

describe('Codex (spec 63, 71)', () => {
  it('offers neither Edit nor Fork, and their palette commands say why', async () => {
    const user = userEvent.setup();
    const { dispatched } = setup({ instance: codex });
    expect(screen.queryByRole('button', { name: 'Fork from here' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    await user.click(composer());
    await user.keyboard('{ArrowUp}');
    expect(screen.queryByTestId('edit-notice')).toBeNull();
    act(() => userRows()[2]?.focus());
    fireEvent.keyDown(document.activeElement as Element, { key: 'e', code: 'KeyE' });
    fireEvent.keyDown(document.activeElement as Element, { key: 'f', code: 'KeyF' });
    expect(screen.queryByTestId('edit-notice')).toBeNull();
    expect(dispatched().filter((command) => command.type === 'thread.create')).toEqual([]);
    const listed = commands().filter((command) =>
      ['chat.editLast', 'chat.fork'].includes(command.id),
    );
    expect(listed.map((command) => command.detail)).toEqual([
      'Codex cannot go back in its conversation, so a message there cannot be edited or forked.',
      'Codex cannot go back in its conversation, so a message there cannot be edited or forked.',
    ]);
  });
});
