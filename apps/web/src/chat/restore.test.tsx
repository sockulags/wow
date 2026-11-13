import type {
  Command,
  ProviderInstance,
  RestorePreview,
  Thread,
  ThreadItem,
  Turn,
} from '@wow/contracts';
import {
  RpcClientError,
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore, useStore } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '@/app/commands';
import { createLayoutStore, RuntimeProvider } from '@/app/runtime';
import { useGlobalKeybindings } from '@/app/use-commands';
import { conversationCommands, conversationStore } from './conversation-nav';
import { createDraftStore } from './draft';
import { restoreLineText, restoreStore } from './restore';
import { ThreadConversation } from './thread-view';

// Restore files when going back (thread work spec 20 to 24): the button and R on a message, the
// confirm with what changes and what changed outside the thread, the line with Undo, and Edit's
// choice of what goes back. All invented.

const thread: Thread = {
  id: 'bell',
  projectId: 'tea',
  cwd: '/work/tea chat',
  branch: null,
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

const twoMessages = () => [
  item(0, 'user', { text: 'Make the bell ring twice' }),
  item(0, 'assistant_text', { text: 'It rings twice.' }),
  item(1, 'user', { text: 'Now add the notes' }),
  item(1, 'assistant_text', { text: 'Notes added.' }),
];

const okPreview = (overrides: Partial<RestorePreview> = {}): RestorePreview => ({
  status: 'ok',
  message: null,
  write: ['docs/old.md', 'src/bell.ts'],
  remove: ['docs/notes.md'],
  outside: [],
  notRestorable: [],
  ...overrides,
});

function ConversationKeys() {
  const state = useStore(conversationStore);
  const settings = createSettingsStore(createMemorySettingsSource(undefined, {}));
  useGlobalKeybindings(conversationCommands({ ...state, reasoningOpen: false }, false), {
    settings,
  } as unknown as CommandContext);
  return null;
}

function setup({
  turns = [turn(0), turn(1)],
  items = twoMessages(),
  previews = [okPreview()],
  refuseDispatch,
}: {
  turns?: Turn[];
  items?: ThreadItem[];
  previews?: RestorePreview[];
  refuseDispatch?: RpcClientError;
} = {}) {
  const asked = [...previews];
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>((method) => {
    if (method === 'threads.restorePreview') return Promise.resolve(asked.shift() ?? okPreview());
    if (method === 'dispatch' && refuseDispatch) {
      const refusal = refuseDispatch;
      refuseDispatch = undefined;
      return Promise.reject(refusal);
    }
    return Promise.resolve({
      commandId: '00000000-0000-4000-8000-000000000000',
      seqs: [],
      duplicate: false,
    });
  });
  const topics: Record<string, unknown> = { turns, threadItems: items, threads: [thread] };
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
  render(
    <RuntimeProvider
      runtime={{
        connection,
        layout: createLayoutStore(),
        draft: createDraftStore(),
        settings: createSettingsStore(createMemorySettingsSource(undefined, {})),
      }}
    >
      <ThreadConversation thread={thread} instance={claude} />
      <ConversationKeys />
    </RuntimeProvider>,
  );
  const dispatched = () =>
    request.mock.calls.flatMap(([method, params]) =>
      method === 'dispatch' ? [(params as { command: Command }).command] : [],
    );
  const previewed = () =>
    request.mock.calls.flatMap(([method, params]) =>
      method === 'threads.restorePreview' ? [params] : [],
    );
  return { dispatched, previewed };
}

const userRows = () => screen.getAllByTestId('item-user');
const composer = () => screen.getByRole<HTMLTextAreaElement>('combobox', { name: /message/i });
const confirm = () => screen.findByTestId('restore-confirm');
const listed = (testId: string) =>
  within(screen.getByTestId(testId))
    .getAllByRole('listitem')
    .map((row) => row.textContent);

beforeEach(() => {
  nextIndex = 0;
});

afterEach(() => {
  restoreStore.setState({ question: undefined });
});

describe('Restore files to here (spec 20, 22)', () => {
  it('lists what is written back and deleted and restores after Enter', async () => {
    const user = userEvent.setup();
    const { dispatched, previewed } = setup();
    await user.click(
      within(userRows()[0] as HTMLElement).getByRole('button', { name: 'Restore files to here' }),
    );
    const dialog = await confirm();
    expect(previewed()).toEqual([{ threadId: 'bell', turnId: turnId(0) }]);
    expect(await within(dialog).findByText('Written back')).toBeTruthy();
    expect(listed('restore-write')).toEqual(['docs/old.md', 'src/bell.ts']);
    expect(listed('restore-remove')).toEqual(['docs/notes.md']);
    expect(screen.queryByTestId('restore-outside')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Restore' })).toBe(document.activeElement);
    await user.keyboard('{Enter}');
    expect(dispatched().at(-1)).toEqual({
      type: 'thread.restoreFiles',
      threadId: 'bell',
      turnId: turnId(0),
      confirmed: { outside: [], notRestorable: [] },
    });
    expect(screen.queryByTestId('restore-confirm')).toBeNull();
  });

  it('lists files changed outside the thread first and reads "Restore anyway"', async () => {
    const user = userEvent.setup();
    const { dispatched } = setup({
      previews: [
        okPreview({
          outside: ['src/bell.ts'],
          notRestorable: [{ path: 'assets/bell.wav', size: 12 * 1024 * 1024 }],
        }),
      ],
    });
    await user.click(
      within(userRows()[0] as HTMLElement).getByRole('button', { name: 'Restore files to here' }),
    );
    const dialog = await confirm();
    await within(dialog).findByText('Changed outside this thread since its last turn');
    const sections = within(dialog)
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent);
    expect(sections).toEqual([
      'Changed outside this thread since its last turn',
      'Too large to put back; they stay as they are',
      'Written back',
      'Deleted',
    ]);
    expect(listed('restore-not-restorable')).toEqual(['assets/bell.wav12.0 MB']);
    await user.click(within(dialog).getByRole('button', { name: 'Restore anyway' }));
    expect(dispatched().at(-1)).toMatchObject({
      confirmed: { outside: ['src/bell.ts'], notRestorable: ['assets/bell.wav'] },
    });
  });

  it('asks again with what the server found when the files changed since', async () => {
    const user = userEvent.setup();
    const now = okPreview({ outside: ['docs/notes.md'] });
    const { dispatched } = setup({
      refuseDispatch: new RpcClientError({
        code: 'conflict',
        message: 'The files changed since the confirm was shown',
        data: now,
      }),
    });
    await user.click(
      within(userRows()[0] as HTMLElement).getByRole('button', { name: 'Restore files to here' }),
    );
    const dialog = await confirm();
    await user.click(await within(dialog).findByRole('button', { name: 'Restore' }));
    expect(await within(dialog).findByText(/The files changed since\./)).toBeTruthy();
    expect(listed('restore-outside')).toEqual(['docs/notes.md']);
    await user.click(within(dialog).getByRole('button', { name: 'Restore anyway' }));
    expect(dispatched().at(-1)).toMatchObject({
      confirmed: { outside: ['docs/notes.md'], notRestorable: [] },
    });
  });

  it('says why when the server refuses, and Escape closes', async () => {
    const user = userEvent.setup();
    const { dispatched } = setup({
      previews: [
        {
          ...okPreview({ write: [], remove: [] }),
          status: 'outside',
          message: 'docs/old.md leads through a link or junction, so nothing is put back.',
        },
      ],
    });
    await user.click(
      within(userRows()[0] as HTMLElement).getByRole('button', { name: 'Restore files to here' }),
    );
    const dialog = await confirm();
    expect((await within(dialog).findByTestId('restore-refused')).textContent).toMatch(
      /leads through a link/,
    );
    expect(within(dialog).queryByRole('button', { name: /Restore/ })).toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('restore-confirm')).toBeNull();
    expect(dispatched()).toEqual([]);
  });

  it('offers it with R on the focused message, and not on old turns or while a turn runs', async () => {
    const { previewed } = setup({ turns: [turn(0, { restorable: undefined }), turn(1)] });
    expect(
      within(userRows()[0] as HTMLElement).queryByRole('button', { name: 'Restore files to here' }),
    ).toBeNull();
    act(() => userRows()[0]?.focus());
    fireEvent.keyDown(document.activeElement as Element, { key: 'r', code: 'KeyR' });
    expect(screen.queryByTestId('restore-confirm')).toBeNull();
    act(() => userRows()[1]?.focus());
    const command = conversationCommands(
      { ...conversationStore.getState(), reasoningOpen: false },
      false,
    ).find((entry) => entry.id === 'chat.restoreFiles');
    expect(command).toMatchObject({
      title: 'Restore files to this message',
      keybinding: 'keybindings.restoreMessage',
    });
    fireEvent.keyDown(document.activeElement as Element, { key: 'r', code: 'KeyR' });
    expect(await confirm()).toBeTruthy();
    expect(previewed()).toEqual([{ threadId: 'bell', turnId: turnId(1) }]);
  });

  it('offers no Restore while a turn runs', () => {
    setup({ turns: [turn(0), turn(1, { state: 'running', endedAt: null })] });
    expect(screen.queryByRole('button', { name: 'Restore files to here' })).toBeNull();
  });
});

const line = (undoOf?: string) =>
  item(
    1,
    'files_restored',
    {
      toTurnId: turnId(0),
      written: ['docs/old.md', 'src/bell.ts'],
      removed: ['docs/notes.md'],
      failed: [],
      ...(undoOf ? { undoOf } : {}),
      at: '2026-11-13T08:02:00.000Z',
    },
    'bell:restore',
  );

describe('the restore line (spec 24)', () => {
  it('names the message and the counts, and Undo asks with the same confirm', async () => {
    const user = userEvent.setup();
    const { dispatched, previewed } = setup({
      items: [...twoMessages(), line()],
      previews: [okPreview({ write: ['docs/notes.md', 'src/bell.ts'], remove: ['docs/old.md'] })],
    });
    const shown = screen.getByTestId('files-restored');
    expect(shown.textContent).toContain(
      'Files restored to before “Make the bell ring twice” · 2 written · 1 deleted',
    );
    await user.click(within(shown).getByRole('button', { name: 'Undo' }));
    const dialog = await confirm();
    expect(previewed()).toEqual([{ threadId: 'bell', undoItemId: 'bell:restore' }]);
    await user.click(await within(dialog).findByRole('button', { name: 'Undo' }));
    expect(dispatched().at(-1)).toEqual({
      type: 'thread.undoRestore',
      threadId: 'bell',
      itemId: 'bell:restore',
      confirmed: { outside: [], notRestorable: [] },
    });
  });

  it('offers no Undo once a turn started after it', () => {
    setup({
      turns: [turn(0), turn(1), turn(2)],
      items: [...twoMessages(), line(), item(2, 'user', { text: 'Ring three times' })],
    });
    expect(
      within(screen.getByTestId('files-restored')).queryByRole('button', { name: 'Undo' }),
    ).toBeNull();
  });

  it('words an undo and failures', () => {
    expect(
      restoreLineText(
        {
          toTurnId: turnId(0),
          written: ['a'],
          removed: [],
          failed: [{ path: 'b', message: 'EBUSY' }],
          undoOf: 'x',
          at: '2026-11-13T08:02:00.000Z',
        },
        'Make the bell ring twice',
      ),
    ).toBe('Restore undone · 1 written · 0 deleted · 1 could not be changed');
  });
});

describe("Edit's choice (spec 21)", () => {
  it('offers "Conversation and files", confirms what goes back, then sends the edit with it', async () => {
    const user = userEvent.setup();
    const { dispatched, previewed } = setup();
    await user.click(composer());
    await user.keyboard('{ArrowUp}');
    const choice = screen.getByTestId('edit-files-choice');
    expect(within(choice).getByRole('radio', { name: 'Conversation only' })).toHaveProperty(
      'ariaChecked',
      'true',
    );
    await user.click(within(choice).getByRole('radio', { name: 'Conversation and files' }));
    await user.clear(composer());
    await user.type(composer(), 'Add shorter notes{Enter}');
    const dialog = await confirm();
    expect(previewed()).toEqual([{ threadId: 'bell', turnId: turnId(1) }]);
    expect(dispatched()).toEqual([]);
    await user.click(await within(dialog).findByRole('button', { name: 'Restore and send' }));
    expect(dispatched().at(-1)).toEqual({
      type: 'thread.editLast',
      threadId: 'bell',
      turnId: turnId(1),
      text: 'Add shorter notes',
      restoreFiles: { confirmed: { outside: [], notRestorable: [] } },
    });
  });

  it('sends nothing when the confirm is cancelled, and keeps the text', async () => {
    const user = userEvent.setup();
    const { dispatched } = setup();
    await user.click(composer());
    await user.keyboard('{ArrowUp}');
    act(() => {
      conversationCommands({ ...conversationStore.getState(), reasoningOpen: false }, false)
        .find((entry) => entry.id === 'chat.edit.withFiles')
        ?.run({} as CommandContext);
    });
    expect(
      within(screen.getByTestId('edit-files-choice')).getByRole('radio', {
        name: 'Conversation and files',
      }),
    ).toHaveProperty('ariaChecked', 'true');
    await user.click(composer());
    await user.keyboard('{Enter}');
    await confirm();
    await user.keyboard('{Escape}');
    expect(await screen.findByText(/Not sent: the files were not put back/)).toBeTruthy();
    expect(dispatched()).toEqual([]);
    expect(composer().value).toBe('Now add the notes');
  });

  it('keeps "Conversation only" for a turn without a snapshot', async () => {
    const user = userEvent.setup();
    setup({ turns: [turn(0), turn(1, { restorable: undefined })] });
    await user.click(composer());
    await user.keyboard('{ArrowUp}');
    expect(screen.getByTestId('edit-notice')).toBeTruthy();
    expect(screen.queryByTestId('edit-files-choice')).toBeNull();
  });
});
