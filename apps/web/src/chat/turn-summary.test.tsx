import type { ProviderInstance, Thread, ThreadItem, Turn } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore } from 'zustand';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLayoutStore, RuntimeProvider } from '@/app/runtime';
import { conversationText } from './find';
import { createDraftStore } from './draft';
import { threadChangesStore } from './thread-changes';
import { ThreadConversation } from './thread-view';
import { summaryText, turnSummaries } from './turn-summary';

// The summary at the start of a turn's usage row (chat overview spec 1 to 3): what the turn
// changed, as the server measured it, and what it ran, from its rows. All invented.

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

const tool = (turnIndex: number, payload: Record<string, unknown>) =>
  item(turnIndex, 'tool_call', { name: 'Bash', input: {}, output: '', ...payload });

const usage = (turnIndex: number, extra: Record<string, unknown> = {}) =>
  item(
    turnIndex,
    'usage',
    { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 0, ...extra },
    `${turnId(turnIndex)}:usage`,
  );

function setup(items: ThreadItem[], turns: Turn[]) {
  const request = vi.fn<() => Promise<unknown>>(() =>
    Promise.resolve({
      status: 'ok',
      message: null,
      baseSha: null,
      files: [],
      omitted: 0,
      patch: null,
      turnPaths: null,
    }),
  );
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
    </RuntimeProvider>,
  );
}

beforeEach(() => {
  nextIndex = 0;
  threadChangesStore.setState({ threadId: undefined, turnOnly: false, turn: undefined });
});

describe('the words of a turn summary (spec 1)', () => {
  it("says what changed, what ran and how much failed; a subagent's own calls do not count", () => {
    const items = [
      tool(0, { kind: 'command', command: 'pnpm test', status: 'error' }),
      tool(0, { kind: 'read', path: 'a.ts', status: 'ok' }),
      tool(0, { kind: 'read', path: 'b.ts', status: 'ok', parentItemId: 'agent' }),
      tool(0, { kind: 'edit', path: 'a.ts', status: 'ok' }),
      usage(0, { changes: { files: 3, added: 40, removed: 2 } }),
    ];
    const summary = turnSummaries(items).get(`${turnId(0)}:usage`);
    expect(summary && summaryText(summary)).toBe(
      'Changed 3 files +40 −2 · Ran 1 command, read 1 file, edited 1 file · 1 failed',
    );
    expect(summary?.opensChanges).toBe(true);
  });

  it('has nothing for a turn that did nothing or could not be measured', () => {
    const summaries = turnSummaries([
      usage(0, { changes: null }),
      usage(1, { changes: { files: 0, added: 0, removed: 0 } }),
      usage(2),
    ]);
    expect(summaries.size).toBe(0);
  });
});

const conversation = () => [
  item(0, 'user', { text: 'Make the bell ring twice' }),
  tool(0, { kind: 'edit', path: 'bell.ts', status: 'ok' }),
  usage(0, { changes: { files: 1, added: 1, removed: 0 } }),
  item(1, 'user', { text: 'Add the notes' }),
  tool(1, { kind: 'command', command: 'pnpm test', status: 'ok' }),
  usage(1, { changes: { files: 2, added: 4, removed: 1 } }),
];

describe('the summary on the usage row (spec 1 to 3)', () => {
  it("starts the usage row and opens that turn's Changes, an earlier one by its number", async () => {
    const user = userEvent.setup();
    setup(conversation(), [turn(0), turn(1)]);
    const shown = screen.getAllByTestId('turn-summary').map((row) => row.textContent);
    expect(shown).toEqual([
      'Changed 1 file +1 −0 · Edited 1 file · ',
      'Changed 2 files +4 −1 · Ran 1 command · ',
    ]);
    const [first, second] = screen.getAllByTestId('turn-summary-changes');
    await user.click(first as HTMLElement);
    expect(threadChangesStore.getState()).toMatchObject({
      threadId: thread.id,
      turnOnly: true,
      turn: { id: turnId(0), number: 1 },
    });
    await user.click(second as HTMLElement);
    expect(threadChangesStore.getState()).toMatchObject({ turnOnly: true, turn: undefined });
  });

  it('is found by Find', () => {
    const all = conversation();
    const pieces = conversationText({
      entries: all.map((entry) => ({ kind: 'item', item: entry })),
      children: new Map(),
      turns: [turn(0), turn(1)],
      approvals: [],
      questions: [],
      cwd: thread.cwd,
      outputLines: 20,
      summaries: turnSummaries(all),
    });
    expect(pieces.map((piece) => piece.text)).toContain('Changed 2 files +4 −1 · Ran 1 command');
  });
});
