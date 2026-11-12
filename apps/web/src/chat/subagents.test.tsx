import type {
  BackgroundTask,
  ProviderInstance,
  Thread,
  ThreadItem,
  ToolCallItemPayload,
  Turn,
} from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import type { CommandContext } from '@/app/commands';
import { createLayoutStore, RuntimeProvider } from '@/app/runtime';
import { loadMarkdown } from '../test/markdown';
import { backgroundCommands, backgroundStore, backgroundTarget } from './background';
import { createDraftStore } from './draft';
import { ThreadConversation } from './thread-view';
import { nestSubagentWork } from './view-model';

// Subagents and background work (agent workbench U11, spec 44, 48, 90). Invented data; the clock
// is set by the test.

beforeAll(loadMarkdown);
afterEach(() => vi.useRealTimers());

const start = Date.UTC(2026, 10, 12, 9, 0, 0);
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();

const thread: Thread = {
  id: 'thread-1',
  projectId: null,
  cwd: '/work/kettle',
  branch: null,
  providerInstanceId: 'claude',
  providerSessionId: null,
  title: 'Kettle',
  model: 'opus',
  effort: 'high',
  permissionMode: 'default',
  state: 'working',
  pinned: false,
  runId: null,
  stepId: null,
  createdAt: at(0),
  updatedAt: at(0),
};

const instanceOf = (kind: 'claude' | 'codex'): ProviderInstance => ({
  id: kind,
  kind,
  name: kind,
  binaryPath: kind,
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
});

const turn = (state: Turn['state']): Turn => ({
  id: 'turn-1',
  threadId: thread.id,
  index: 0,
  state,
  startedAt: at(0),
  endedAt: state === 'running' ? null : at(100),
  usage: null,
});

let index = 0;
const row = (id: string, kind: ThreadItem['kind'], payload: unknown): ThreadItem => ({
  id,
  threadId: thread.id,
  turnId: 'turn-1',
  index: (index += 1),
  kind,
  payload,
  streaming: false,
});
const call = (id: string, payload: Partial<ToolCallItemPayload>) =>
  row(id, 'tool_call', { name: 'tool', input: {}, output: '', status: 'ok', ...payload });

const agent = (payload: Partial<ToolCallItemPayload>) =>
  call('agent', {
    name: 'Agent',
    kind: 'subagent',
    description: 'explore the auth code',
    prompt: 'Find where the kettle checks who may start it.',
    startedAt: at(0),
    ...payload,
  });

const subagentWork = (running: boolean): ThreadItem[] => [
  row('user', 'user', { text: 'Explore with an agent' }),
  agent(running ? { status: 'running' } : {}),
  call('grep', {
    kind: 'search',
    pattern: 'mayStart',
    path: 'src',
    parentItemId: 'agent',
    startedAt: at(1),
    endedAt: at(2),
  }),
  call('read', {
    kind: 'read',
    path: '/work/kettle/src/auth.ts',
    parentItemId: 'agent',
    startedAt: at(2),
    endedAt: at(3),
  }),
  row('note', 'assistant_text', { text: 'Running its test.', parentItemId: 'agent' }),
  call('test', {
    kind: 'command',
    command: 'pnpm test auth',
    parentItemId: 'agent',
    status: running ? 'running' : 'ok',
    startedAt: at(4),
  }),
];

function setup({
  shown = thread,
  kind = 'claude',
  turns,
  items,
}: {
  shown?: Thread;
  kind?: 'claude' | 'codex';
  turns: Turn[];
  items: ThreadItem[];
}) {
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>(() =>
    Promise.resolve({
      commandId: '00000000-0000-4000-8000-000000000000',
      seqs: [],
      duplicate: false,
    }),
  );
  const topics: Record<string, unknown> = { turns, threadItems: items };
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
      <ThreadConversation
        thread={{ ...shown, providerInstanceId: kind }}
        instance={instanceOf(kind)}
      />
    </RuntimeProvider>,
  );
  const sent = () =>
    request.mock.calls
      .filter(([method]) => method === 'dispatch')
      .map(([, params]) => (params as { command: unknown }).command);
  return { sent, connection };
}

const conversation = () => screen.getByRole('list', { name: 'Conversation' });

describe('a Claude Code subagent (spec 44)', () => {
  it('shows one agent row with the description, "3 tool calls", the time and the nested rows while it runs', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start + 12_000);
    setup({ turns: [turn('running')], items: subagentWork(true) });
    const rows = screen.getAllByTestId('agent-row');
    expect(rows).toHaveLength(1);
    const agentRow = rows[0] as HTMLElement;
    expect(within(agentRow).getByTestId('agent-task').textContent).toBe(
      'Agent: explore the auth code',
    );
    expect(within(agentRow).getByTestId('agent-facts').textContent).toBe('3 tool calls · 12 s');
    const work = within(agentRow).getByRole('list', { name: "The subagent's work" });
    expect(within(work).getAllByRole('listitem')).toHaveLength(4);
    expect(within(work).getByText('Running its test.')).toBeTruthy();
    expect(within(work).getByTestId('tool-command').textContent).toBe('$ pnpm test auth');
    // The subagent's work is under its call, not in the conversation itself.
    expect(
      [...conversation().querySelectorAll(':scope > li')].map((li) =>
        li.getAttribute('data-item-id'),
      ),
    ).toEqual(['user', 'agent']);
    expect(within(agentRow).queryByTestId('agent-answer')).toBeNull();
  });

  it('shows the answer once it is done, with its count and time, and the nested rows on request', () => {
    const items = subagentWork(false);
    items[1] = agent({
      status: 'ok',
      endedAt: at(95),
      durationMs: 92_000,
      toolCount: 3,
      answer: 'The kettle checks `mayStart` in `src/auth.ts`.',
    });
    setup({ shown: { ...thread, state: 'idle' }, turns: [turn('completed')], items });
    const agentRow = screen.getByTestId('agent-row');
    expect(within(agentRow).getByTestId('agent-facts').textContent).toBe('3 tool calls · 1:32');
    expect(within(agentRow).getByTestId('agent-answer').textContent).toContain(
      'The kettle checks mayStart in src/auth.ts.',
    );
    expect(within(agentRow).queryByRole('list', { name: "The subagent's work" })).toBeNull();
    fireEvent.click(within(agentRow).getByRole('button', { name: /Agent: explore/ }));
    expect(within(agentRow).getByRole('list', { name: "The subagent's work" })).toBeTruthy();
    expect(within(agentRow).getByTestId('agent-prompt').textContent).toBe(
      'Find where the kettle checks who may start it.',
    );
  });
});

describe('a Codex collab agent (spec 44)', () => {
  it('shows the prompt, the state and the final message, without a nested list', () => {
    setup({
      kind: 'codex',
      shown: { ...thread, state: 'idle' },
      turns: [turn('completed')],
      items: [
        call('spawn', {
          name: 'spawnAgent',
          kind: 'subagent',
          prompt: 'Explore the auth code.\nSay where login is checked.',
          agentState: 'done',
          answer: 'Login is checked in src/auth.ts.',
          startedAt: at(0),
          endedAt: at(40),
        }),
      ],
    });
    const agentRow = screen.getByTestId('agent-row');
    expect(within(agentRow).getByTestId('agent-task').textContent).toBe(
      'Agent: Explore the auth code.',
    );
    expect(within(agentRow).getByTestId('agent-state').textContent).toBe('done');
    expect(within(agentRow).getByTestId('agent-answer').textContent).toContain(
      'Login is checked in src/auth.ts.',
    );
    fireEvent.click(within(agentRow).getByRole('button', { name: /Agent:/ }));
    expect(within(agentRow).getByTestId('agent-prompt').textContent).toContain(
      'Say where login is checked.',
    );
    expect(within(agentRow).queryByRole('list', { name: "The subagent's work" })).toBeNull();
  });

  it('keeps a spawned agent working while Codex says it runs, though its call has finished', () => {
    setup({
      kind: 'codex',
      turns: [turn('running')],
      items: [
        call('spawn', {
          name: 'spawnAgent',
          kind: 'subagent',
          prompt: 'Count.',
          agentState: 'running',
        }),
      ],
    });
    expect(screen.getByTestId('agent-row').getAttribute('data-working')).toBe('true');
    expect(screen.getByTestId('agent-state').textContent).toBe('running');
  });
});

describe('agent calls stored before (spec 48)', () => {
  it('draws a Task call without a kind as the row it was, with nothing nested', () => {
    setup({
      shown: { ...thread, state: 'idle' },
      turns: [turn('completed')],
      items: [
        call('old', {
          name: 'Task',
          input: { description: 'explore', prompt: 'Look around' },
          output: 'Found it.',
        }),
      ],
    });
    expect(screen.queryByTestId('agent-row')).toBeNull();
    const old = screen.getByTestId('item-tool_call');
    expect(old.querySelector('[data-tool-kind]')?.getAttribute('data-tool-kind')).toBe('old');
    expect(old.textContent).toContain('Task');
  });

  it('keeps an item whose call is not in the thread in the conversation', () => {
    const { top, children } = nestSubagentWork([
      row('lost', 'assistant_text', { text: 'Orphan', parentItemId: 'missing' }),
    ]);
    expect(top.map((item) => item.id)).toEqual(['lost']);
    expect(children.size).toBe(0);
  });
});

const tasks: BackgroundTask[] = [
  {
    id: 'bg-1',
    description: 'Count the tea leaves',
    agent: true,
    kind: 'agent',
    startedAt: at(0),
    lastOutput: 'Counted 30 leaves so far',
  },
  { id: 'sh-1', description: 'pnpm dev', kind: 'command', startedAt: at(30) },
];

const elapsed = () => screen.getAllByTestId('background-elapsed').map((chip) => chip.textContent);

describe('background tasks (spec 90)', () => {
  it('shows two chips that count up from when the server heard of them', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(start + 42_000);
    setup({
      shown: { ...thread, state: 'idle', backgroundTasks: tasks },
      turns: [turn('completed')],
      items: [],
    });
    expect(screen.getByTestId('background-label').textContent).toBe('Waiting for background work');
    expect(elapsed()).toEqual(['0:42', '0:12']);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(elapsed()).toEqual(['0:45', '0:15']);
  });

  it('opens a chip to its latest output, and Stop on Claude Code stops it', async () => {
    const { sent } = setup({
      shown: { ...thread, backgroundTasks: tasks },
      turns: [turn('running')],
      items: [],
    });
    expect(screen.getByTestId('background-label').textContent).toBe('In the background');
    fireEvent.click(screen.getAllByTestId('background-chip')[0] as HTMLElement);
    expect((await screen.findByTestId('background-output')).textContent).toBe(
      'Counted 30 leaves so far',
    );
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop' }));
    expect(sent()).toEqual([{ type: 'thread.stopTask', threadId: thread.id, taskId: 'bg-1' }]);
  });

  it('has no Stop on Codex, and says when nothing was reported', async () => {
    setup({
      kind: 'codex',
      shown: { ...thread, state: 'idle', backgroundTasks: [tasks[1] as BackgroundTask] },
      turns: [turn('completed')],
      items: [],
    });
    fireEvent.click(screen.getByTestId('background-chip'));
    expect((await screen.findByTestId('background-output')).textContent).toBe(
      'Nothing reported yet.',
    );
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  // Ctrl+B (keybindings.toBackground) is the palette command of the running command or agent.
  it('offers Ctrl+B for the running command and sends it to the background', () => {
    const items = [
      call('cmd', { kind: 'command', command: 'pnpm dev', status: 'running' }),
      call('nested', {
        kind: 'command',
        command: 'pnpm test',
        status: 'running',
        parentItemId: 'x',
      }),
    ];
    expect(backgroundTarget(items, 'turn-1')).toEqual({ itemId: 'cmd', title: '`pnpm dev`' });
    expect(backgroundTarget(items, undefined)).toBeUndefined();
    const { connection } = setup({ turns: [turn('running')], items });
    const state = backgroundStore.getState();
    expect(state.target).toEqual({ itemId: 'cmd', title: '`pnpm dev`' });
    const command = backgroundCommands(state).find((entry) => entry.id === 'chat.toBackground');
    expect(command).toMatchObject({ keybinding: 'keybindings.toBackground', detail: '`pnpm dev`' });
    command?.run({ connection } as unknown as CommandContext);
    expect((connection.request as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([
      'dispatch',
      expect.objectContaining({
        command: { type: 'thread.toBackground', threadId: thread.id, itemId: 'cmd' },
      }),
    ]);
  });

  it('does not offer Ctrl+B for a command that waits for its approval', () => {
    const items = [
      call('turn-1:dev', { kind: 'command', command: 'pnpm dev', status: 'running' }),
      call('turn-1:rm', { kind: 'command', command: 'rm -rf dist', status: 'running' }),
    ];
    const approval = {
      id: `${thread.id}:rm`,
      threadId: thread.id,
      itemId: 'turn-1:approval:rm',
      kind: 'command',
      request: {},
      decision: null,
      decidedAt: null,
    } as const;
    expect(backgroundTarget(items, 'turn-1', [approval])).toEqual({
      itemId: 'turn-1:dev',
      title: '`pnpm dev`',
    });
    expect(
      backgroundTarget(items, 'turn-1', [{ ...approval, decision: 'allowOnce', decidedAt: at(1) }])
        ?.itemId,
    ).toBe('turn-1:rm');
  });

  it('offers no Ctrl+B on Codex', () => {
    setup({
      kind: 'codex',
      turns: [turn('running')],
      items: [call('cmd', { kind: 'command', command: 'pnpm dev', status: 'running' })],
    });
    expect(backgroundStore.getState().target).toBeUndefined();
  });
});
