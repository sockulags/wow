import type { ThreadItem, ToolCallItemPayload, Turn } from '@wow/contracts';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadMarkdown } from '../../test/markdown';
import { ConversationItem, StoppedLine, type ItemContext } from '../items';
import { Toaster, toast } from 'sonner';
import type { CommandContext } from '@/app/commands';
import { focusedRowActions, rowActionStore } from '@/lib/row-actions';
import { rowActionCommands } from '../row-commands';
import { TaskDetails, TaskPin, taskPinCommands, taskPinStore, activeTaskPin } from '../task-pin';
import { formatDuration, groupSummary } from './facts';
import { ToolCallGroup } from './group';

// Tool rows, the pinned task list and copy (agent workbench U4, spec 27 to 32, 48, 89, 91).
// Invented data.

beforeAll(loadMarkdown);
afterEach(() => vi.useRealTimers());

const context: ItemContext = {
  cwd: '/work/demo',
  permissionLabel: 'Ask',
  turnEnded: true,
  at: undefined,
  awaitingApproval: false,
  formatAt: (iso) => iso.slice(11, 16),
  outputLines: 20,
};

let next = 10;
const tool = (payload: Partial<ToolCallItemPayload>, turnId = 'turn-1'): ThreadItem => ({
  id: `item-${(next += 1)}`,
  threadId: 't1',
  turnId,
  index: next,
  kind: 'tool_call',
  payload: { name: 'tool', input: {}, output: '', status: 'ok', ...payload },
  streaming: false,
});

const show = (item: ThreadItem, itemContext: ItemContext = context) =>
  render(
    <ul>
      <ConversationItem item={item} approvals={[]} questions={[]} context={itemContext} />
    </ul>,
  );

const open = (row: HTMLElement) => {
  const details = row.querySelector('details') as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event('toggle'));
};

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 2, 20, 41, seconds)).toISOString();
const testOutput = `${Array.from({ length: 25 }, (_, line) => `line ${line + 1}`).join('\n')}\n`;

describe('command rows (spec 27)', () => {
  it('reads $ command, its other folder and "exit 1 · 4.2 s", and opens to its last lines', async () => {
    show(
      tool({
        name: 'command',
        kind: 'command',
        command: 'pnpm test',
        cwd: '/work/demo/app',
        status: 'error',
        exitCode: 1,
        durationMs: 4200,
        startedAt: at(0),
        endedAt: at(5),
        output: testOutput,
      }),
    );
    const row = screen.getByTestId('item-tool_call');
    expect(within(row).getByTestId('tool-command').textContent).toBe('$ pnpm test');
    expect(within(row).getByTestId('tool-folder').textContent).toBe('in /work/demo/app');
    // The provider's own duration wins over the server's clock.
    expect(within(row).getByTestId('tool-time').textContent).toBe('exit 1 · 4.2 s');
    open(row);
    const output = within(row).getByTestId('tool-output-text');
    expect(output.textContent?.split('\n')).toHaveLength(20);
    expect(output.textContent?.startsWith('line 6\n')).toBe(true);
    fireEvent.click(within(row).getByRole('button', { name: 'Show all 25 lines' }));
    expect(within(row).getByTestId('tool-output-text').textContent?.split('\n')).toHaveLength(25);
  });

  it('leaves the folder out when it is the thread\'s, and reads "failed" with the server\'s time for a Claude command', () => {
    show(
      tool({
        name: 'Bash',
        kind: 'command',
        command: 'pnpm lint',
        cwd: '/work/demo/',
        status: 'error',
        startedAt: at(0),
        endedAt: at(2),
      }),
    );
    const row = screen.getByTestId('item-tool_call');
    expect(within(row).queryByTestId('tool-folder')).toBeNull();
    expect(within(row).getByTestId('tool-time').textContent).toBe('failed · 2.0 s');
  });

  it('formats durations as seconds, then as a clock', () => {
    expect([300, 4200, 42_000, 92_000].map(formatDuration)).toEqual([
      '0.3 s',
      '4.2 s',
      '42 s',
      '1:32',
    ]);
  });
});

describe('read, search, web and MCP rows (spec 28, 29)', () => {
  it('draws each as one line with its path, pattern or address', () => {
    const lines = [
      tool({
        name: 'Read',
        kind: 'read',
        path: '/work/demo/README.md',
        lines: { from: 1, to: 80 },
      }),
      tool({ name: 'Grep', kind: 'search', pattern: 'kettle', path: '/work/demo/src' }),
      tool({ name: 'WebFetch', kind: 'web', url: 'https://example.org/' }),
    ].map((item) => {
      const view = show(item);
      const text = within(view.container).getByTestId('tool-line').textContent;
      view.unmount();
      return text;
    });
    expect(lines).toEqual([
      'Read README.md lines 1-80',
      'Search kettle in src',
      'Fetch example.org',
    ]);
  });

  it('draws an MCP call as server › tool with key: value arguments, and the JSON on request', () => {
    show(
      tool({
        name: 'mcp__tracker__find_issue',
        kind: 'mcp',
        server: 'tracker',
        tool: 'find_issue',
        input: { key: 'DEMO-42', fields: ['status'] },
        output: 'DEMO-42 · To Do',
      }),
    );
    const row = screen.getByTestId('item-tool_call');
    expect(within(row).getByTestId('tool-mcp').textContent).toBe('tracker › find_issue');
    expect(within(row).getByTestId('tool-arguments').textContent).toBe(
      'key: DEMO-42 · fields: ["status"]',
    );
    open(row);
    expect(row.querySelector('.wow-code')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Show JSON' }));
    expect(row.querySelector('.wow-code')?.textContent).toContain('"DEMO-42"');
  });
});

describe('time of a running call (spec 30)', () => {
  it('counts up from the start the server stored', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at(3)));
    show(
      tool({
        name: 'Bash',
        kind: 'command',
        command: 'pnpm dev',
        status: 'running',
        startedAt: at(0),
      }),
      { ...context, turnEnded: false },
    );
    const time = screen.getByTestId('tool-time');
    expect(time.textContent).toBe('running · 3.0 s');
    expect(time.dataset['startedAt']).toBe(at(0));
    act(() => vi.advanceTimersByTime(2000));
    expect(time.textContent).toBe('running · 5.0 s');
  });

  it('stops counting a call its turn left unfinished', () => {
    show(
      tool({
        name: 'Bash',
        kind: 'command',
        command: 'pnpm dev',
        status: 'running',
        startedAt: at(0),
      }),
    );
    expect(screen.getByTestId('tool-time').textContent).toBe('not finished');
  });
});

const tasks = [
  'Read the readme',
  'Find the issue',
  'Plan the timer',
  'Running the tests',
  'Fix the test',
  'Start the server',
  'Write the summary',
].map((content, index) => ({
  id: String(index + 1),
  content,
  status:
    index < 3
      ? ('completed' as const)
      : index === 3
        ? ('in_progress' as const)
        : ('pending' as const),
}));
const turn = (state: Turn['state'], index = 0): Turn => ({
  id: `turn-${index + 1}`,
  threadId: 't1',
  index,
  state,
  startedAt: at(0),
  endedAt: state === 'running' ? null : at(30),
  usage: null,
});
const taskItem = (list: typeof tasks, stamped = true): ThreadItem => ({
  id: `tasks-${(next += 1)}`,
  threadId: 't1',
  turnId: 'turn-1',
  index: next,
  kind: 'task_list',
  payload: stamped ? { tasks: list, at: at(1) } : { tasks: list },
  streaming: false,
});

describe('the task list (spec 31)', () => {
  it('pins "3/7 · <current task>" above the composer, and the command toggles it', () => {
    const items = [
      taskItem(tasks.map((task) => ({ ...task, status: 'pending' }))),
      taskItem(tasks),
    ];
    render(<TaskPin threadId="t1" items={items} turns={[turn('running')]} />);
    expect(screen.getByTestId('task-pin-line').textContent).toBe('3/7 · Running the tests');
    expect(screen.queryByRole('region', { name: 'Pinned tasks' })).toBeNull();
    const shown = activeTaskPin(taskPinStore.getState());
    expect(shown).toBe('t1');
    const [toggle] = taskPinCommands(shown, false);
    expect(toggle?.keybinding).toBe('keybindings.toggleTasks');
    act(() => toggle?.run(undefined as never));
    expect(
      within(screen.getByRole('region', { name: 'Pinned tasks' }))
        .getAllByRole('listitem')
        .map((entry) => entry.textContent),
    ).toEqual(tasks.map((task) => task.content));
  });

  it('marks each update in the conversation, and Details lists the latest', () => {
    show(taskItem(tasks), { ...context, turnEnded: false });
    expect(screen.getByTestId('task-marker').textContent).toBe('Updated tasks (3/7)');
    render(<TaskDetails items={[taskItem(tasks)]} turns={[turn('completed')]} />);
    expect(screen.getByRole('region', { name: 'Thread tasks' }).textContent).toContain(
      'Running the tests',
    );
  });

  it('draws a list stored before markers in full, as it was (spec 48)', () => {
    show(taskItem(tasks, false));
    expect(screen.queryByTestId('task-marker')).toBeNull();
    expect(screen.getByRole('region', { name: 'Tasks' }).textContent).toContain(
      'Write the summary',
    );
  });
});

describe('copy (spec 32)', () => {
  it('copies a message as markdown and as text, a code block and a tool output', async () => {
    const user = userEvent.setup();
    show({
      id: 'm1',
      threadId: 't1',
      turnId: 'turn-1',
      index: 1,
      kind: 'assistant_text',
      payload: { text: 'The **kettle** is ready.\n\n```bash\npnpm test\n```' },
      streaming: false,
    });
    const message = screen.getByTestId('item-assistant_text');
    await within(message).findByText('kettle');
    await user.click(within(message).getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe(
      'The **kettle** is ready.\n\n```bash\npnpm test\n```',
    );
    await user.click(within(message).getByRole('button', { name: 'Copy text' }));
    expect(await navigator.clipboard.readText()).toMatch(/^The kettle is ready\.\s*pnpm test$/);
    await user.click(within(message).getByRole('button', { name: 'Copy code' }));
    expect(await navigator.clipboard.readText()).toBe('pnpm test');

    show(tool({ name: 'Bash', kind: 'command', command: 'pnpm test', output: testOutput }));
    const row = screen.getByTestId('item-tool_call');
    open(row);
    await user.click(within(row).getByRole('button', { name: 'Copy output' }));
    expect(await navigator.clipboard.readText()).toBe(testOutput);
  });
});

const rowCommands = () => rowActionCommands(focusedRowActions(rowActionStore.getState()));
// The palette command runs the row's own action; the action gives back the clipboard write.
const runRow = async (id: string) => {
  expect(rowCommands().some((command) => command.id === `chat.${id}`)).toBe(true);
  await focusedRowActions(rowActionStore.getState())
    .find((action) => action.id === id)
    ?.run();
};
const copyMessage = (): ThreadItem => ({
  id: 'm2',
  threadId: 't1',
  turnId: 'turn-1',
  index: 2,
  kind: 'assistant_text',
  payload: { text: 'Boil **water**.\n\n```bash\npnpm dev\n```' },
  streaming: false,
});
const failedNotices = () => screen.queryAllByText('Nothing was copied');

describe('copy from the palette and when the clipboard fails (spec 32)', () => {
  afterEach(() => {
    act(() => void toast.dismiss());
  });

  it("offers the focused message's, code block's and tool output's actions as commands", async () => {
    userEvent.setup();
    show(copyMessage());
    const shown = screen.getByTestId('item-assistant_text');
    await within(shown).findByText('water');
    act(() => within(shown).getByRole('button', { name: 'Copy code' }).focus());
    expect(rowCommands().map((command) => [command.id, command.title])).toEqual([
      ['chat.copyCode', 'Copy code'],
      ['chat.copy', 'Copy message'],
      ['chat.copyText', 'Copy message text'],
    ]);
    await runRow('copyCode');
    expect(await navigator.clipboard.readText()).toBe('pnpm dev');
    await runRow('copy');
    expect(await navigator.clipboard.readText()).toBe('Boil **water**.\n\n```bash\npnpm dev\n```');

    show(tool({ name: 'Bash', kind: 'command', command: 'pnpm test', output: testOutput }));
    const row = screen.getByTestId('item-tool_call');
    act(() => (row.querySelector('summary') as HTMLElement).focus());
    expect(rowCommands().map((command) => command.id)).toEqual(['chat.copyOutput']);
    open(row);
    act(() => within(row).getByRole('button', { name: 'Copy output' }).focus());
    expect(rowCommands().map((command) => command.title)).toEqual([
      'Copy output',
      'Show all 25 lines',
    ]);
    act(() =>
      rowCommands()
        .find((command) => command.id === 'chat.outputLines')
        ?.run({} as CommandContext),
    );
    expect(within(row).getByTestId('tool-output-text').textContent?.split('\n')).toHaveLength(25);
    expect(rowCommands().map((command) => command.title)).toEqual([
      'Copy output',
      'Show the last 20 lines',
    ]);
    await runRow('copyOutput');
    expect(await navigator.clipboard.readText()).toBe(testOutput);
    expect(failedNotices()).toEqual([]);
  });

  it('says nothing was copied when the clipboard refuses the text', async () => {
    const user = userEvent.setup();
    render(<Toaster />);
    show(tool({ name: 'Bash', kind: 'command', command: 'pnpm test', output: testOutput }));
    const row = screen.getByTestId('item-tool_call');
    open(row);
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
      new Error('Write permission denied'),
    );
    await user.click(within(row).getByRole('button', { name: 'Copy output' }));
    expect(await screen.findByText('Nothing was copied')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Copied' })).toBeNull();
  });

  it('says nothing was copied when there is no clipboard', async () => {
    render(<Toaster />);
    show(copyMessage());
    const shown = screen.getByTestId('item-assistant_text');
    await within(shown).findByText('water');
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    try {
      act(() => within(shown).getByRole('button', { name: 'Copy' }).focus());
      await runRow('copy');
      expect(await screen.findByText('Nothing was copied')).toBeTruthy();
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});

describe('the end of a turn and of a group (spec 89, 91)', () => {
  it('ends a stopped turn with "Stopped by you · <time>" and Resume', () => {
    const onResume = vi.fn<() => void>();
    render(
      <StoppedLine
        turn={turn('interrupted')}
        formatAt={context.formatAt}
        resume={{ onResume, prompt: 'Continue' }}
      />,
    );
    expect(screen.getByTestId('turn-stopped').textContent).toBe('Stopped by you · 20:41Resume');
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onResume).toHaveBeenCalled();
  });

  it('reads a closed group as what it did, and a running one as its latest call', () => {
    const calls = [
      tool({ name: 'Read', kind: 'read', path: '/work/demo/a.ts' }),
      tool({ name: 'Read', kind: 'read', path: '/work/demo/b.ts' }),
      tool({ name: 'Bash', kind: 'command', command: 'pnpm test', status: 'error' }),
    ];
    const view = render(
      <ol>
        <ToolCallGroup items={calls} contextOf={() => context} closed />
      </ol>,
    );
    expect(screen.getByTestId('tool-group-summary').textContent).toBe(
      'Read 2 files, ran 1 command · 1 failed',
    );
    const running = [
      ...calls,
      tool({
        name: 'Bash',
        kind: 'command',
        command: 'pnpm dev',
        status: 'running',
        startedAt: at(0),
      }),
    ];
    view.rerender(
      <ol>
        <ToolCallGroup items={running} contextOf={() => ({ ...context, turnEnded: false })} />
      </ol>,
    );
    expect(screen.queryByTestId('tool-group-summary')).toBeNull();
    const summary = screen.getByTestId('item-tool_group').querySelector('summary');
    expect(within(summary as HTMLElement).getByTestId('tool-command').textContent).toBe(
      '$ pnpm dev',
    );
    expect(within(summary as HTMLElement).getByTestId('tool-time').textContent).toMatch(/^running/);
    expect(groupSummary([])).toBe('');
  });
});

describe('a tool call stored before tool kinds (spec 48)', () => {
  it('shows its name, input and output as it did', () => {
    show(tool({ name: 'Bash', input: { command: 'ls' }, output: 'README.md', status: 'ok' }));
    const row = screen.getByTestId('item-tool_call');
    const line = row.querySelector('summary')?.textContent;
    expect(line).toBe('Bashlsdone');
    open(row);
    expect(within(row).getByRole('region', { name: 'Tool input' }).textContent).toContain('"ls"');
    expect(within(row).getByRole('region', { name: 'Tool output' }).textContent).toContain(
      'README.md',
    );
  });
});
