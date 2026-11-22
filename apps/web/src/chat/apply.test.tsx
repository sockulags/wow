import type {
  ApplyPreview,
  ChangesAppliedItemPayload,
  Command,
  ProviderInstance,
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
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLayoutStore, RuntimeProvider } from '@/app/runtime';
import { ApplyDialog, applyStore, askApply } from './apply';
import { conversationMarkdown } from './conversation-markdown';
import { createDraftStore } from './draft';
import { appliedLineText } from './git-lines';
import { ThreadConversation } from './thread-view';

// Apply to project folder (parallel threads spec 4, 6, 8, 9): the confirm with what is written,
// merged, deleted and left, the line Apply leaves with its Undo, and its words in the export.
// All invented.

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

const okPreview = (overrides: Partial<ApplyPreview> = {}): ApplyPreview => ({
  status: 'ok',
  message: null,
  projectFolder: '/work/tea',
  base: '4e1d2a0',
  files: [
    { path: 'bell.ts', change: 'modified', outcome: 'write', reason: null },
    { path: 'docs/notes.md', change: 'modified', outcome: 'merge', reason: null },
    { path: 'old.md', change: 'deleted', outcome: 'delete', reason: null },
    { path: 'kettle.ts', change: 'modified', outcome: 'left', reason: 'conflict' },
    { path: 'readme.md', change: 'modified', outcome: 'same', reason: null },
  ],
  ...overrides,
});

const applied = (
  overrides: Partial<ChangesAppliedItemPayload> = {},
): ChangesAppliedItemPayload => ({
  projectFolder: '/work/tea',
  base: '4e1d2a0',
  written: ['bell.ts'],
  merged: ['docs/notes.md'],
  removed: ['old.md'],
  left: [{ path: 'kettle.ts', reason: 'both changed the same lines' }],
  failed: [],
  savedAs: `1763020800000-${'a'.repeat(40)}`,
  at: '2026-11-13T08:01:00.000Z',
  ...overrides,
});

function setup({
  items = [] as ThreadItem[],
  previews = [okPreview()],
  refuseDispatch,
}: {
  items?: ThreadItem[];
  previews?: ApplyPreview[];
  refuseDispatch?: RpcClientError;
} = {}) {
  const asked = [...previews];
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>((method) => {
    if (method === 'threads.applyPreview') return Promise.resolve(asked.shift() ?? okPreview());
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
  const topics: Record<string, unknown> = {
    turns: [turn(0)],
    threadItems: items,
    threads: [thread],
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
      <ApplyDialog threadId={thread.id} />
    </RuntimeProvider>,
  );
  const dispatched = () =>
    request.mock.calls.flatMap(([method, params]) =>
      method === 'dispatch' ? [(params as { command: Command }).command] : [],
    );
  return { connection, dispatched };
}

const listed = (testId: string) =>
  within(screen.getByTestId(testId))
    .getAllByRole('listitem')
    .map((row) => row.textContent);

beforeEach(() => {
  nextIndex = 0;
});

afterEach(() => {
  applyStore.setState({ question: undefined });
});

describe('the Apply confirm (spec 4, 6)', () => {
  it('lists what is left for you first, then merged, written and deleted, and applies on Enter', async () => {
    const user = userEvent.setup();
    const { connection, dispatched } = setup();
    await act(() => askApply(connection, thread.id));
    const dialog = await screen.findByTestId('apply-confirm');
    expect(
      within(dialog)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual([
      'Left for you; the project folder keeps its own',
      'Merged with your changes',
      'Written',
      'Deleted',
    ]);
    expect(listed('apply-left')).toEqual(['kettle.tsboth changed the same lines']);
    expect(listed('apply-write')).toEqual(['bell.ts']);
    expect(within(dialog).getByText('/work/tea')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Apply' })).toBe(document.activeElement);
    await user.keyboard('{Enter}');
    expect(dispatched()).toEqual([
      {
        type: 'thread.applyToProject',
        threadId: thread.id,
        confirmed: {
          write: ['bell.ts', 'old.md'],
          merge: ['docs/notes.md'],
          left: ['kettle.ts'],
        },
      },
    ]);
    expect(screen.queryByTestId('apply-confirm')).toBeNull();
  });

  it('asks again with the new lists when the files changed since', async () => {
    const user = userEvent.setup();
    const now = okPreview({
      files: [{ path: 'bell.ts', change: 'modified', outcome: 'left', reason: 'conflict' }],
    });
    const { connection } = setup({
      refuseDispatch: new RpcClientError({
        code: 'conflict',
        message: 'The files changed since.',
        data: now,
      }),
    });
    await act(() => askApply(connection, thread.id));
    await user.click(await screen.findByRole('button', { name: 'Apply' }));
    expect(await screen.findByText(/The files changed since\./)).toBeTruthy();
    expect(listed('apply-left')).toEqual(['bell.tsboth changed the same lines']);
  });

  it('says why when it cannot apply, and offers no Apply', async () => {
    const { connection } = setup({
      previews: [
        {
          status: 'projectBusy',
          message: 'A turn is running in "Kettle", which works in the project folder.',
          projectFolder: null,
          base: null,
          files: [],
        },
      ],
    });
    await act(() => askApply(connection, thread.id));
    expect((await screen.findByTestId('apply-refused')).textContent).toContain('Kettle');
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
  });
});

describe('the apply line (spec 8, 9)', () => {
  it('says what was applied and undoes the newest apply', async () => {
    const user = userEvent.setup();
    const line = item(0, 'changes_applied', applied(), 'bell:turn:0:changes-applied:3');
    const { dispatched } = setup({
      items: [
        item(0, 'user', { text: 'Make the bell ring twice' }),
        item(0, 'assistant_text', { text: 'It rings twice.' }),
        line,
      ],
    });
    const row = await screen.findByTestId('changes-applied');
    expect(row.textContent).toContain(
      'Applied to /work/tea · 1 written · 1 merged · 1 deleted · 1 left for you',
    );
    expect(row.textContent).toContain('kettle.ts: both changed the same lines');
    await user.click(within(row).getByRole('button', { name: 'Undo' }));
    expect(dispatched()).toEqual([
      { type: 'thread.undoApply', threadId: thread.id, itemId: line.id },
    ]);
  });

  it('offers no Undo once undone, and says what the undo left', async () => {
    setup({
      items: [
        item(0, 'user', { text: 'Make the bell ring twice' }),
        item(0, 'changes_applied', applied({ undoneBy: 'u' }), 'a'),
        item(
          0,
          'changes_applied',
          applied({
            written: ['bell.ts'],
            merged: [],
            removed: [],
            left: [{ path: 'old.md', reason: 'changed since Apply' }],
            undoOf: 'a',
            savedAs: undefined,
          }),
          'u',
        ),
      ],
    });
    const rows = await screen.findAllByTestId('changes-applied');
    expect(rows.map((row) => within(row).queryByRole('button', { name: 'Undo' }))).toEqual([
      null,
      null,
    ]);
    expect(rows[1]?.textContent).toContain(
      'Apply undone · 1 written · 0 deleted · 1 file changed since, left as is',
    );
  });

  it('is written in the Markdown export', () => {
    expect(appliedLineText(applied())).toBe(
      'Applied to /work/tea · 1 written · 1 merged · 1 deleted · 1 left for you',
    );
    const markdown = conversationMarkdown({
      title: thread.title,
      instanceName: 'Claude',
      model: 'Sonnet',
      project: 'Tea',
      folder: thread.cwd,
      branch: thread.branch,
      exportedAt: '2026-11-13T09:00:00.000Z',
      turns: [turn(0)],
      items: [
        item(0, 'user', { text: 'Make the bell ring twice' }),
        item(0, 'changes_applied', applied()),
      ],
      approvals: [],
      questions: [],
      formatAt: (iso) => iso,
      reasoning: false,
    });
    expect(markdown).toContain(
      'Applied to /work/tea · 1 written · 1 merged · 1 deleted · 1 left for you · kettle.ts: both changed the same lines',
    );
  });
});
