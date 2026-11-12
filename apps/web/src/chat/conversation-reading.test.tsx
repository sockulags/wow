import type {
  AssistantProposal,
  ProviderInstance,
  ProviderModel,
  Skill,
  Thread,
  ThreadItem,
  Turn,
  WorkflowRun,
} from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, RuntimeProvider } from '@/app/runtime';
import { keyConflicts, keyScope } from '@/settings/keybindings-table';
import { conversationCommands, conversationStore, toggleReasoning } from './conversation-nav';
import { createDraftStore } from './draft';
import { compactionText, settingsChangeText } from './items';
import { shortTokens } from './model';
import {
  needsYouStore,
  needsYouTargets,
  nextNeedsYou,
  requestNeedsYouFocus,
  useNeedsYouFocus,
} from './needs-you';
import { ThreadConversation } from './thread-view';

// Conversation reading (agent workbench U10): dividers, usage models, the working line, the
// context meter, reasoning, moving between messages, "New output", the chat skill list and "Next
// that needs you". All invented.

const thread: Thread = {
  id: 'thread-1',
  projectId: null,
  cwd: '/work/kettle',
  branch: null,
  providerInstanceId: 'claude',
  providerSessionId: null,
  title: 'Kettle',
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

const models: ProviderModel[] = [
  { id: 'opus', label: 'Opus', description: '', efforts: ['low', 'high'] },
  { id: 'sonnet', label: 'Sonnet', description: '', efforts: ['low', 'high'] },
];

const turn = (index: number, overrides: Partial<Turn> = {}): Turn => ({
  id: `turn-${index}`,
  threadId: thread.id,
  index,
  state: 'completed',
  startedAt: `2026-11-12T08:0${index}:00.000Z`,
  endedAt: `2026-11-12T08:0${index}:30.000Z`,
  usage: null,
  ...overrides,
});

let nextIndex = 0;
const item = (
  turnId: string,
  kind: ThreadItem['kind'],
  payload: unknown,
  overrides: Partial<ThreadItem> = {},
): ThreadItem => {
  nextIndex += 1;
  return {
    id: `${turnId}:${kind}:${nextIndex}`,
    threadId: thread.id,
    turnId,
    index: nextIndex,
    kind,
    payload,
    streaming: false,
    ...overrides,
  };
};

const skill = (name: string, source: Skill['source'], claudeInvocation = `/${name}`): Skill => ({
  id: `${source}/${name}`,
  name,
  description: `Invented ${name}`,
  dir: `/skills/${name}`,
  source,
  manualOnly: false,
  invocations: { claude: claudeInvocation, codex: `$${name}` },
  ...(source === 'wow' || source === 'yours' ? { text: `Do ${name}.` } : {}),
});

function setup({
  instance = claude,
  turns = [],
  items = [],
  skills = [],
  settings = {},
  topics: extra = {},
}: {
  topics?: Record<string, unknown>;
  instance?: ProviderInstance;
  turns?: Turn[];
  items?: ThreadItem[];
  skills?: Skill[];
  settings?: Record<string, unknown>;
} = {}) {
  const listeners = new Map<string, (rows: unknown) => void>();
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>((method) =>
    method === 'provider.listModels'
      ? Promise.resolve(models)
      : Promise.resolve({
          commandId: '00000000-0000-4000-8000-000000000000',
          seqs: [],
          duplicate: false,
        }),
  );
  const topics: Record<string, unknown> = { turns, threadItems: items, skills, ...extra };
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
  const shown: Thread = {
    ...thread,
    providerInstanceId: instance.id,
    state: turns.some((entry) => entry.state === 'running') ? 'working' : 'idle',
  };
  render(
    <RuntimeProvider
      runtime={{
        connection,
        layout: createLayoutStore(),
        draft: createDraftStore(),
        settings: createSettingsStore(createMemorySettingsSource(undefined, settings)),
      }}
    >
      <ThreadConversation thread={shown} instance={instance} />
    </RuntimeProvider>,
  );
  const push = (topic: string, rows: unknown) => act(() => listeners.get(topic)?.(rows));
  return { push, request };
}

beforeEach(() => {
  nextIndex = 0;
  conversationStore.setState({ reasoning: {} });
  needsYouStore.setState({ request: undefined, last: undefined, landed: undefined });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a change of model, effort or mode (spec 9)', () => {
  it('shows one divider naming the change by label, and each usage row names its model', async () => {
    const items = [
      item('turn-0', 'user', { text: 'Plan the timer' }),
      item('turn-0', 'usage', { inputTokens: 1200, outputTokens: 340, model: 'opus' }),
      item('turn-1', 'settings_change', {
        model: { from: 'opus', to: 'sonnet' },
        permissionMode: { from: 'default', to: 'acceptEdits' },
      }),
      item('turn-1', 'user', { text: 'Build it' }),
      item('turn-1', 'usage', { inputTokens: 900, outputTokens: 120, model: 'sonnet' }),
    ];
    setup({ turns: [turn(0), turn(1)], items });
    const dividers = await screen.findAllByTestId('settings-divider');
    expect(dividers).toHaveLength(1);
    expect(await screen.findByText('Model: Opus → Sonnet · Mode: Accept edits')).toBeTruthy();
    const rows = screen.getAllByLabelText('Turn usage').map((row) => row.textContent);
    expect(rows[0]).toMatch(/^Opus · /);
    expect(rows[1]).toMatch(/^Sonnet · /);
    // The divider sits right before the message it belongs to.
    const order = screen
      .getAllByRole('listitem')
      .map((row) => row.dataset['testid'])
      .filter(Boolean);
    expect(order.indexOf('item-settings_change')).toBe(order.indexOf('item-user', 1) - 1);
  });

  it('names an effort change from and to, and a usage row from before without a model', () => {
    expect(settingsChangeText({ effort: { from: 'high', to: 'low' } })).toBe('Effort: High → Low');
    setup({
      turns: [turn(0)],
      items: [item('turn-0', 'usage', { inputTokens: 1200, outputTokens: 340 })],
    });
    expect(screen.getByLabelText('Turn usage').textContent).toMatch(/^1,200 in/);
  });
});

describe('the working line (spec 45)', () => {
  const running = turn(0, { state: 'running', endedAt: null });
  const calls = [
    item('turn-0', 'user', { text: 'Use two tools' }),
    item('turn-0', 'tool_call', {
      name: 'Bash',
      input: {},
      output: '',
      status: 'ok',
      kind: 'command',
      command: 'pnpm lint',
    }),
    item('turn-0', 'tool_call', {
      name: 'Bash',
      input: {},
      output: '',
      status: 'running',
      kind: 'command',
      command: 'pnpm test',
    }),
  ];

  it('names the running command, the time, the calls and the stop key, with no tokens on Claude Code', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T08:00:42.000Z'));
    setup({ turns: [running], items: calls });
    expect(screen.getByTestId('working-line').textContent).toBe(
      'Running pnpm test · 0:42 · 2 tool calls · Ctrl+. to stop',
    );
  });

  it('adds the live tokens where the provider counts them during the turn, as Codex does', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T08:00:42.000Z'));
    setup({
      instance: codex,
      turns: [running],
      items: [
        ...calls,
        item('turn-0', 'usage', { inputTokens: 12_000, outputTokens: 1_300, cachedInputTokens: 0 }),
      ],
    });
    expect(screen.getByTestId('working-line').textContent).toBe(
      'Running pnpm test · 0:42 · 2 tool calls · ↑12k ↓1.3k · Ctrl+. to stop',
    );
  });

  it('writes tokens short', () => {
    expect([940, 1300, 12_000, 152_000, 1_250_000].map(shortTokens)).toEqual([
      '940',
      '1.3k',
      '12k',
      '152k',
      '1.3M',
    ]);
  });
});

const usage = (usedTokens: number) =>
  item('turn-0', 'usage', {
    inputTokens: 1,
    outputTokens: 1,
    context: { usedTokens, maxTokens: 200_000 },
  });

describe('compaction and the context meter (spec 46, 47)', () => {
  it("shows Claude's compaction with its trigger and counts", () => {
    setup({
      turns: [turn(0)],
      items: [
        item('turn-0', 'compaction', {
          trigger: 'auto',
          preTokens: 152_000,
          postTokens: 18_000,
          at: '2026-11-12T08:00:10.000Z',
        }),
      ],
    });
    expect(screen.getByTestId('compaction-divider').textContent).toBe(
      'Conversation compacted (auto) · 152k → 18k',
    );
    expect(compactionText({ trigger: 'manual', preTokens: 40_000, at: thread.createdAt })).toBe(
      'Conversation compacted (manual) · 40k before',
    );
  });

  it('turns amber from the warning share and offers Compact now', async () => {
    const { request } = setup({ turns: [turn(0)], items: [usage(164_000)] });
    expect(screen.getByTestId('context-meter').textContent).toBe('Context 82 % full');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Compact now' }));
    expect(request).toHaveBeenCalledWith('dispatch', {
      commandId: expect.any(String),
      command: { type: 'thread.sendMessage', threadId: thread.id, text: '/compact' },
    });
  });

  it('reads the warning share from its setting', () => {
    setup({
      turns: [turn(0)],
      items: [usage(164_000)],
      settings: { 'chat.contextWarnPercent': 90 },
    });
    expect(screen.getByTestId('context-meter').textContent).toBe('164,000 / 200,000 context (82%)');
  });

  it('offers no Compact on Codex', () => {
    setup({ instance: codex, turns: [turn(0)], items: [usage(164_000)] });
    expect(screen.getByTestId('context-meter').textContent).toBe('Context 82 % full');
    expect(screen.queryByRole('button', { name: /Compact/ })).toBeNull();
  });
});

const reasoning = (overrides: Partial<ThreadItem> = {}) =>
  item(
    'turn-0',
    'reasoning',
    {
      text: 'The kettle clicks off.\nThen the timer starts.',
      startedAt: '2026-11-12T08:00:01.000Z',
      endedAt: '2026-11-12T08:00:12.000Z',
    },
    overrides,
  );

const opened = () =>
  screen.getAllByTestId('item-reasoning').map((row) => row.querySelector('details')?.open);

describe('reasoning (spec 88)', () => {
  it('shows its last line beside "Thinking…" while it streams, and "Thought for n s" after', () => {
    setup({
      turns: [turn(0, { state: 'running', endedAt: null })],
      items: [reasoning({ streaming: true })],
    });
    expect(screen.getByTestId('reasoning-label').textContent).toBe('Thinking…');
    expect(screen.getByTestId('reasoning-last-line').textContent).toBe('Then the timer starts.');
  });

  it('reads "Thought for n s" once something came after it, and "Reasoning" for one from before', () => {
    setup({
      turns: [turn(0, { state: 'running', endedAt: null })],
      items: [
        reasoning({ streaming: true }),
        item('turn-0', 'assistant_text', { text: 'Done.' }, { streaming: true }),
        item('turn-0', 'reasoning', { text: 'Old thoughts' }),
      ],
    });
    expect(screen.getAllByTestId('reasoning-label').map((label) => label.textContent)).toEqual([
      'Thought for 11 s',
      'Reasoning',
    ]);
  });

  it('opens and closes all of it with Ctrl+O, and opens by default from its setting', () => {
    setup({ turns: [turn(0)], items: [reasoning(), reasoning()] });
    expect(opened()).toEqual([false, false]);
    act(() => toggleReasoning(thread.id, false));
    expect(opened()).toEqual([true, true]);
    act(() => toggleReasoning(thread.id, false));
    expect(opened()).toEqual([false, false]);
    expect(
      conversationCommands({ ...conversationStore.getState(), reasoningOpen: false }, false).find(
        (command) => command.id === 'chat.toggleReasoning',
      )?.keybinding,
    ).toBe('keybindings.toggleReasoning');
  });

  it('opens by default when the setting says so', () => {
    setup({
      turns: [turn(0)],
      items: [reasoning()],
      settings: { 'chat.reasoningOpen': true },
    });
    expect(screen.getByTestId('item-reasoning').querySelector('details')?.open).toBe(true);
  });
});

const conversation = () => [
  item('turn-0', 'user', { text: 'Plan the timer' }),
  item('turn-0', 'assistant_text', { text: 'First a **plan**.' }),
  item('turn-0', 'assistant_text', { text: 'Then the timer.' }),
  item('turn-1', 'user', { text: 'Build it' }),
];

const handle = () => {
  const current = conversationStore.getState().handle;
  if (!current) throw new Error('No conversation registered');
  return current;
};

describe('reading a long thread (spec 73 to 75)', () => {
  it('shows each message its turn start and each answer when its turn ended, in the row', () => {
    setup({
      turns: [turn(0), turn(1, { state: 'running', endedAt: null })],
      items: conversation(),
    });
    const times = screen
      .getAllByTestId('message-time')
      .map((time) => time.getAttribute('dateTime'));
    expect(times).toEqual([
      '2026-11-12T08:00:00.000Z',
      '2026-11-12T08:00:30.000Z',
      '2026-11-12T08:01:00.000Z',
    ]);
  });

  it('moves between messages with Alt+Up and Alt+Down and copies the focused one with C', async () => {
    const user = userEvent.setup();
    const copied = vi.spyOn(navigator.clipboard, 'writeText');
    setup({ turns: [turn(0), turn(1)], items: conversation() });
    const rows = screen.getAllByRole('listitem').filter((row) => row.dataset['message']);
    act(() => handle().previousMessage());
    expect(document.activeElement).toBe(rows[3]);
    act(() => handle().previousMessage());
    act(() => handle().previousMessage());
    expect(document.activeElement).toBe(rows[1]);
    act(() => handle().nextMessage());
    expect(document.activeElement).toBe(rows[2]);
    const commands = conversationCommands(
      { ...conversationStore.getState(), reasoningOpen: false },
      false,
    );
    const copy = commands.find((command) => command.id === 'chat.copyFocusedMessage');
    expect(copy?.keybinding).toBe('keybindings.copyMessage');
    await act(async () => {
      await handle().copyFocused();
    });
    expect(copied).toHaveBeenCalledWith('Then the timer.');
    await user.keyboard('{Escape}');
  });

  it('shows "New output" when output arrives while scrolled up, and goes back down', async () => {
    const items = conversation();
    const { push } = setup({ turns: [turn(0), turn(1)], items });
    const scroller = screen.getByTestId('conversation');
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    expect(screen.queryByRole('button', { name: 'New output' })).toBeNull();
    push('threadItems', [...items, item('turn-1', 'assistant_text', { text: 'More.' })]);
    expect(conversationStore.getState().scrolledUp).toBe(true);
    expect(
      conversationCommands({ ...conversationStore.getState(), reasoningOpen: false }, false).find(
        (command) => command.id === 'chat.toNewest',
      )?.keybinding,
    ).toBe('keybindings.conversationEnd');
    await userEvent.setup().click(screen.getByRole('button', { name: 'New output' }));
    expect(scroller.scrollTop).toBe(2000);
    expect(screen.queryByRole('button', { name: 'New output' })).toBeNull();
    expect(conversationStore.getState().scrolledUp).toBe(false);
  });
});

describe('the chat skill list (spec 57)', () => {
  it('leads with Yours, puts wow last and marks its step skills', async () => {
    const user = userEvent.setup();
    setup({
      skills: [
        skill('wow-verdict', 'wow'),
        skill('lint-fix', 'user-claude'),
        skill('release', 'user-claude', '/tools:release'),
        skill('kettle-notes', 'project-claude'),
        skill('tidy-notes', 'yours'),
        skill('brew', 'user-claude'),
      ],
      turns: [turn(0)],
      items: [
        item('turn-0', 'user', {
          text: 'brew it',
          skills: [{ name: 'brew', source: 'user-claude' }],
        }),
      ],
    });
    await user.type(screen.getByRole('combobox', { name: /message/i }), '/');
    const list = await screen.findByRole('listbox', { name: 'Skills' });
    const headings = [...list.querySelectorAll('[cmdk-group-heading]')].map(
      (heading) => heading.textContent,
    );
    expect(headings.slice(-6)).toEqual([
      'Yours',
      'Project',
      'Recently used',
      'User',
      'Plugins',
      'wow',
    ]);
    const verdict = within(list).getByRole('option', { name: /wow-verdict/ });
    expect(within(verdict).getByTestId('step-skill-mark').textContent).toBe('for workflow steps');
    expect(within(list).getAllByTestId('step-skill-mark')).toHaveLength(1);
  });
});

// A waiting element that asks for the keyboard as the gate bar's Approve does.
function Target({ name }: { name: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  useNeedsYouFocus('run:run-1', ref);
  return <button ref={ref}>{name}</button>;
}

describe('next that needs you (spec 76)', () => {
  const waitingThread: Thread = {
    ...thread,
    id: 'thread-2',
    state: 'needs_you',
    updatedAt: '2026-11-12T08:05:00.000Z',
  };
  const run = {
    id: 'run-1',
    state: 'waiting',
    startedAt: '2026-11-12T08:00:00.000Z',
    steps: [],
  } as unknown as WorkflowRun;
  const proposal = {
    id: 'proposal-1',
    at: '2026-11-12T08:07:00.000Z',
    state: 'pending',
    title: 'Turn on weekends',
  } as unknown as AssistantProposal;

  it('goes to the oldest first and to the next one when pressed again', () => {
    const targets = needsYouTargets({
      threads: [waitingThread, thread],
      runs: [run],
      proposals: [proposal],
    });
    expect(targets.map((target) => target.key)).toEqual([
      'run:run-1',
      'thread:thread-2',
      'proposal:proposal-1',
    ]);
    expect(nextNeedsYou(targets, '/chat', undefined)?.key).toBe('run:run-1');
    expect(nextNeedsYou(targets, '/workflows/runs/run-1', 'run:run-1')?.key).toBe(
      'thread:thread-2',
    );
    expect(nextNeedsYou(targets, '/assistant', 'proposal:proposal-1')?.key).toBe('run:run-1');
  });

  it('puts the keyboard on the waiting approval of the thread on screen', () => {
    const approval = item('turn-0', 'approval', {
      approvalId: 'approval-1',
      kind: 'command',
      summary: 'pnpm test',
    });
    setup({
      turns: [turn(0, { state: 'running', endedAt: null })],
      items: [approval],
      topics: {
        approvals: [
          {
            id: 'approval-1',
            threadId: thread.id,
            itemId: approval.id,
            kind: 'command',
            request: { summary: 'pnpm test', details: null },
            decision: null,
            decidedAt: null,
          },
        ],
      },
    });
    act(() => screen.getByRole('combobox', { name: /message/i }).focus());
    act(() => requestNeedsYouFocus(`thread:${thread.id}`));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Approval request');
    expect(needsYouStore.getState().request).toMatchObject({ landed: true });
    // The user doing something lets the request go.
    fireEvent.pointerDown(document.body);
    expect(needsYouStore.getState().request).toBeUndefined();
  });

  it('takes the focus again when the view moves its target after it landed', () => {
    const view = render(<Target key="view" name="Approve in the view" />);
    act(() => requestNeedsYouFocus('run:run-1'));
    expect(document.activeElement?.textContent).toBe('Approve in the view');
    // The gate bar moves from the run view into the side panel: a new element.
    view.rerender(<Target key="panel" name="Approve in the panel" />);
    expect(document.activeElement?.textContent).toBe('Approve in the panel');
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(needsYouStore.getState().request).toBeUndefined();
  });
});

describe('the conversation keys (spec 74, 88)', () => {
  it('work in chat, beside the workflow builder keys that share them', () => {
    expect(keyScope('keybindings.previousMessage')).toBe('Chat');
    expect(keyScope('keybindings.copyMessage')).toBe('Chat');
    expect(keyScope('keybindings.ruleMoveUp')).toBe('Workflows');
    expect(keyScope('keybindings.nextNeedsYou')).toBe('General');
    expect(
      keyConflicts({
        'keybindings.previousMessage': 'Alt+ArrowUp',
        'keybindings.ruleMoveUp': 'Alt+ArrowUp',
      }).size,
    ).toBe(0);
  });
});
