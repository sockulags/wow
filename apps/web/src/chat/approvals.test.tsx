import type { Approval, ApprovalItemPayload, ThreadDiff, ThreadItem, Turn } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, RuntimeProvider, type Runtime } from '@/app/runtime';
import { loadMarkdown } from '../test/markdown';
import { approvalCardStore, approvalCommands } from './approval-card';
import { createDraftStore } from './draft';
import { ConversationItem, type ItemContext } from './items';
import {
  changesSummary,
  ThreadChanges,
  ThreadChangesChip,
  threadChangesCommands,
  threadChangesStore,
} from './thread-changes';
import { diffParts } from './tools/edit';

// Agent workbench U6 in the web app: edit rows with their diff (spec 33), the approval card
// (spec 36 to 38), the plan card (spec 42, 43) and a thread's Changes (spec 34, 35). Invented.

beforeAll(loadMarkdown);
afterEach(() => {
  approvalCardStore.setState({ offer: undefined, keyed: [], noting: undefined });
  threadChangesStore.setState({ threadId: undefined, path: undefined, turnOnly: false });
});

const context: ItemContext = {
  cwd: '/work/kettle',
  permissionLabel: 'Ask',
  turnEnded: false,
  at: undefined,
  awaitingApproval: false,
  formatAt: (iso) => iso,
};

function harness(answers: Record<string, unknown> = {}, turns: Turn[] = []) {
  const sent: unknown[] = [];
  const asked: unknown[] = [];
  const turnListeners: ((data: unknown[]) => void)[] = [];
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>((method, params) => {
    if (method === 'dispatch') {
      sent.push((params as { command: unknown }).command);
      return Promise.resolve({ commandId: 'c1', seqs: [1], duplicate: false });
    }
    asked.push([method, params]);
    const key = `${method}:${(params as { path?: string }).path ?? ''}`;
    return Promise.resolve(answers[key] ?? answers[method] ?? null);
  });
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: request as unknown as Connection['request'],
    subscribe(topic, _params, onData) {
      if (topic === 'turns') turnListeners.push(onData);
      onData(topic === 'turns' ? turns : []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  const runtime: Runtime = {
    connection,
    layout: createLayoutStore(),
    draft: createDraftStore(),
    settings: createSettingsStore(createMemorySettingsSource(undefined, {})),
  };
  const show = (ui: ReactNode) => render(<RuntimeProvider runtime={runtime}>{ui}</RuntimeProvider>);
  const pushTurns = (next: Turn[]) => {
    for (const listener of turnListeners) listener(next);
  };
  return { sent, asked, show, runtime, request, pushTurns };
}

const item = (kind: ThreadItem['kind'], payload: unknown): ThreadItem => ({
  id: 't1:turn:0:x',
  threadId: 't1',
  turnId: 't1:turn:0',
  index: 1,
  kind,
  payload,
  streaming: false,
});

const approvalRow = (payload: ApprovalItemPayload, decision: Approval['decision'] = null) => ({
  item: item('approval', payload),
  approval: {
    id: payload.approvalId,
    threadId: 't1',
    itemId: 't1:turn:0:x',
    kind: payload.kind,
    request: { summary: payload.summary, details: { raw: true } },
    decision,
    decidedAt: decision === null ? null : '2026-11-02T08:00:00.000Z',
  } satisfies Approval,
});

const timerDiff =
  '@@ -1,3 +1,6 @@\n const a = 1;\n-const minutes = 3;\n+const minutes = 4;\n+ring();\n+ring();\n+ring();';

describe('an edit row (spec 33)', () => {
  it('reads "Edit <path> +n −m" and opens to the diff with Open file', async () => {
    const user = userEvent.setup();
    const opened = vi.fn<(path: string) => void>();
    render(
      <ul>
        <ConversationItem
          item={item('tool_call', {
            kind: 'edit',
            name: 'Edit',
            input: {},
            output: '',
            status: 'ok',
            path: '/work/kettle/src/timer.ts',
            diff: timerDiff,
          })}
          approvals={[]}
          questions={[]}
          context={{ ...context, turnEnded: true, openFile: opened }}
        />
      </ul>,
    );
    expect(screen.getByTestId('tool-line').textContent).toBe('Edit src/timer.ts');
    expect(screen.getByTestId('edit-counts').textContent).toBe('+4 −1');
    await user.click(screen.getByText('Edit', { exact: false }));
    const table = screen.getByRole('table', { name: 'Diff of src/timer.ts' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.getAttribute('data-kind')),
    ).toEqual(['hunk', 'context', 'remove', 'add', 'add', 'add', 'add']);
    await user.click(screen.getByRole('button', { name: 'Open file' }));
    expect(opened).toHaveBeenCalledWith('src/timer.ts');
  });

  it('counts the whole edit when its diff is cut, and has no Open file for a file outside the folder', async () => {
    const user = userEvent.setup();
    const opened = vi.fn<(path: string) => void>();
    render(
      <ul>
        <ConversationItem
          item={item('tool_call', {
            kind: 'edit',
            name: 'Edit',
            input: {},
            output: '',
            status: 'ok',
            path: '/elsewhere/notes.md',
            diff: timerDiff,
            diffCut: true,
            diffCounts: { added: 120, removed: 30 },
          })}
          approvals={[]}
          questions={[]}
          context={{ ...context, turnEnded: true, openFile: opened }}
        />
      </ul>,
    );
    expect(screen.getByTestId('edit-counts').textContent).toBe('+120 −30');
    await user.click(screen.getByText('Edit', { exact: false }));
    expect(screen.getByTestId('edit-diff')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open file' })).toBeNull();
  });

  it('splits a diff of several files by their headers, and leaves an old edit row as it was', () => {
    expect(
      diffParts(
        '--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+one\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone',
      ),
    ).toEqual([
      { path: 'new.ts', hunks: '@@ -0,0 +1 @@\n+one' },
      { path: 'old.ts', hunks: '@@ -1 +0,0 @@\n-gone' },
    ]);
    render(
      <ul>
        <ConversationItem
          item={item('tool_call', {
            kind: 'edit',
            name: 'Edit',
            input: { file_path: 'a.ts' },
            output: '',
            status: 'ok',
            path: 'a.ts',
          })}
          approvals={[]}
          questions={[]}
          context={{ ...context, turnEnded: true }}
        />
      </ul>,
    );
    expect(screen.queryByTestId('edit-counts')).toBeNull();
  });
});

const showApproval = (
  h: ReturnType<typeof harness>,
  payload: ApprovalItemPayload,
  decision: Approval['decision'] = null,
) => {
  const row = approvalRow(payload, decision);
  return h.show(
    <ul>
      <ConversationItem
        item={row.item}
        approvals={[row.approval]}
        questions={[]}
        context={context}
      />
    </ul>,
  );
};

describe('the approval card (spec 36 to 38)', () => {
  it('shows a command with its folder and the rule "always allow" stores, and allows always on Y', async () => {
    const h = harness();
    showApproval(h, {
      approvalId: 't1:a1',
      kind: 'command',
      summary: 'Run the tests',
      facts: { kind: 'command', command: 'pnpm test --watch', cwd: '/work/kettle/app' },
      rule: { kind: 'command', prefix: 'pnpm test' },
    });
    expect(screen.getByTestId('approval-command').textContent).toBe('$ pnpm test --watch');
    expect(screen.getByTestId('approval-context').textContent).toBe('In /work/kettle/app · Ask');
    expect(screen.getByTestId('approval-rule').textContent).toBe(
      'Run commands starting with pnpm test',
    );
    const commands = approvalCommands(approvalCardStore.getState().offer);
    expect(commands.map((command) => [command.id, command.keybinding])).toEqual([
      ['chat.approval.allowOnce', 'keybindings.approvalAllowOnce'],
      ['chat.approval.allowSession', 'keybindings.approvalAllowSession'],
      ['chat.approval.allowAlways', 'keybindings.approvalAllowAlways'],
      ['chat.approval.deny', 'keybindings.approvalDeny'],
    ]);
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Always allow in this project' }));
    expect(h.sent).toEqual([
      { type: 'approval.answer', approvalId: 't1:a1', decision: 'allowAlways' },
    ]);
  });

  it('shows an edit as its diff and an MCP tool as server › tool with its arguments, without a rule for the edit', () => {
    const h = harness();
    showApproval(h, {
      approvalId: 't1:a2',
      kind: 'fileChange',
      summary: 'Edit the timer',
      facts: { kind: 'edit', path: '/work/kettle/src/timer.ts', diff: timerDiff },
    });
    expect(screen.getByRole('table', { name: 'Diff of src/timer.ts' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Always allow in this project' })).toBeNull();
    expect(approvalCommands(approvalCardStore.getState().offer).map((c) => c.id)).not.toContain(
      'chat.approval.allowAlways',
    );
    showApproval(h, {
      approvalId: 't1:a3',
      kind: 'tool',
      summary: 'Create an issue',
      facts: { kind: 'mcp', server: 'github', tool: 'create_issue', arguments: { title: 'Bell' } },
      rule: { kind: 'tool', server: 'github', tool: 'create_issue' },
    });
    expect(screen.getByTestId('approval-tool').textContent).toBe('github › create_issue');
    expect(screen.getByText('title:')).toBeTruthy();
    expect(screen.getByText('Bell')).toBeTruthy();
  });

  it('has no Open file on an edit that waits for its answer, is still being made or was denied', async () => {
    const h = harness();
    const opened = vi.fn<(path: string) => void>();
    const edit: ApprovalItemPayload = {
      approvalId: 't1:a2',
      kind: 'fileChange',
      summary: 'Write the bell',
      facts: { kind: 'edit', path: '/work/kettle/src/bell.ts', diff: '@@ -0,0 +1 @@\n+ring();' },
    };
    const card = (decision: Approval['decision']) => {
      const row = approvalRow(edit, decision);
      return (
        <ConversationItem
          item={row.item}
          approvals={[row.approval]}
          questions={[]}
          context={{ ...context, openFile: opened }}
        />
      );
    };
    const { rerender } = h.show(<ul>{card(null)}</ul>);
    expect(screen.getByRole('table', { name: 'Diff of src/bell.ts' })).toBeTruthy();
    expect(screen.queryByTestId('edit-without-file')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open file' })).toBeNull();
    rerender(
      <RuntimeProvider runtime={h.runtime}>
        <ul>{card('allowOnce')}</ul>
      </RuntimeProvider>,
    );
    expect(screen.getByRole('button', { name: 'Open file' })).toBeTruthy();
    // Denied, the file never changed and Changes does not have it.
    rerender(
      <RuntimeProvider runtime={h.runtime}>
        <ul>{card('deny')}</ul>
      </RuntimeProvider>,
    );
    expect(screen.getByRole('table', { name: 'Diff of src/bell.ts' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open file' })).toBeNull();
    const deniedRow = (
      <RuntimeProvider runtime={h.runtime}>
        <ul>
          <ConversationItem
            item={item('tool_call', {
              kind: 'edit',
              name: 'Write',
              input: {},
              output: 'The user denied this edit.',
              status: 'error',
              path: '/work/kettle/src/bell.ts',
              diff: '@@ -0,0 +1 @@\n+ring();',
            })}
            approvals={[]}
            questions={[]}
            context={{ ...context, turnEnded: true, openFile: opened }}
          />
        </ul>
      </RuntimeProvider>
    );
    rerender(deniedRow);
    await userEvent.setup().click(screen.getByText('Edit', { exact: false }));
    expect(screen.getByTestId('edit-diff')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open file' })).toBeNull();
    rerender(
      <RuntimeProvider runtime={h.runtime}>
        <ul>
          <ConversationItem
            item={item('tool_call', {
              kind: 'edit',
              name: 'Write',
              input: {},
              output: '',
              status: 'running',
              path: '/work/kettle/src/bell.ts',
              diff: '@@ -0,0 +1 @@\n+ring();',
            })}
            approvals={[]}
            questions={[]}
            context={{ ...context, awaitingApproval: true, openFile: opened }}
          />
        </ul>
      </RuntimeProvider>,
    );
    // Still open from the denied row: the same item, now running.
    expect(screen.getByTestId('edit-diff')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open file' })).toBeNull();
  });

  it('says that a write drawn from its input does not show the file it replaces', () => {
    const h = harness();
    showApproval(h, {
      approvalId: 't1:a2',
      kind: 'fileChange',
      summary: 'Write the timer',
      facts: {
        kind: 'edit',
        path: '/work/kettle/src/timer.ts',
        diff: '@@ -0,0 +1 @@\n+export const minutes = 5;',
        diffWithoutFile: true,
      },
    });
    expect(screen.getByTestId('edit-without-file').textContent).toBe(
      "The new content only; the file's current content is not shown.",
    );
  });

  it('opens a one-line note on Deny; Enter sends it, and an empty note denies without one (spec 37)', async () => {
    const user = userEvent.setup();
    const h = harness();
    showApproval(h, {
      approvalId: 't1:a1',
      kind: 'command',
      summary: 'Install',
      facts: { kind: 'command', command: 'npm install' },
    });
    await user.click(screen.getByRole('button', { name: 'Deny' }));
    const note = screen.getByPlaceholderText('No, and tell it what to do instead');
    expect(document.activeElement).toBe(note);
    await user.type(note, 'Use pnpm.{Enter}');
    expect(h.sent).toEqual([
      { type: 'approval.answer', approvalId: 't1:a1', decision: 'deny', note: 'Use pnpm.' },
    ]);
    // The answer is in; the note closes once the server took it.
    await act(() => Promise.resolve());
    expect(screen.queryByTestId('approval-note')).toBeNull();
    act(() => approvalCardStore.setState({ noting: 't1:a1' }));
    await user.type(screen.getByPlaceholderText('No, and tell it what to do instead'), '{Enter}');
    expect(h.sent.at(-1)).toEqual({
      type: 'approval.answer',
      approvalId: 't1:a1',
      decision: 'deny',
    });
  });

  it("answers the thread's first pending request with the keys, and the open thread's before a step's", () => {
    const h = harness();
    const first = approvalRow({
      approvalId: 't1:a1',
      kind: 'command',
      summary: 'First',
      facts: { kind: 'command', command: 'pnpm lint' },
    });
    const second = approvalRow({
      approvalId: 't1:a2',
      kind: 'command',
      summary: 'Second',
      facts: { kind: 'command', command: 'pnpm test' },
      rule: { kind: 'command', prefix: 'pnpm test' },
    });
    const step = approvalRow({
      approvalId: 's1:a1',
      kind: 'command',
      summary: 'Step',
      facts: { kind: 'command', command: 'pnpm build' },
    });
    const row = (entry: typeof first, keyed: { id: string; side: boolean }) => (
      <ConversationItem
        key={entry.approval.id}
        item={{ ...entry.item, id: entry.approval.id }}
        approvals={[entry.approval]}
        questions={[]}
        context={{ ...context, keyedApproval: keyed }}
      />
    );
    const main = { id: 't1:a1', side: false };
    const { rerender } = h.show(<ul>{row(first, main)}</ul>);
    const showAll = (ui: ReactNode) =>
      rerender(<RuntimeProvider runtime={h.runtime}>{ui}</RuntimeProvider>);
    // The step's card in the panel mounts last, then the thread's second request.
    showAll(
      <ul>
        {row(first, main)}
        {row(step, { id: 's1:a1', side: true })}
      </ul>,
    );
    showAll(
      <ul>
        {row(first, main)}
        {row(step, { id: 's1:a1', side: true })}
        {row(second, main)}
      </ul>,
    );
    expect(approvalCardStore.getState().offer?.approvalId).toBe('t1:a1');
    // The first one answered, the keys go to the next of the thread, not to the step's.
    showAll(
      <ul>
        {row(step, { id: 's1:a1', side: true })}
        {row(second, { id: 't1:a2', side: false })}
      </ul>,
    );
    expect(approvalCardStore.getState().offer?.approvalId).toBe('t1:a2');
    showAll(<ul>{row(step, { id: 's1:a1', side: true })}</ul>);
    expect(approvalCardStore.getState().offer?.approvalId).toBe('s1:a1');
  });

  it('says a request a rule answered was allowed by it, and a denial its note', () => {
    const h = harness();
    showApproval(
      h,
      {
        approvalId: 't1:a1',
        kind: 'command',
        summary: 'Run the tests',
        facts: { kind: 'command', command: 'pnpm test' },
        byRule: { kind: 'command', prefix: 'pnpm test' },
      },
      'allowOnce',
    );
    expect(screen.getByTestId('approval-decision').textContent).toBe(
      'Allowed by rule: Run commands starting with pnpm test',
    );
    showApproval(
      h,
      { approvalId: 't1:a2', kind: 'command', summary: 'x', note: 'Use pnpm.' },
      'deny',
    );
    expect(screen.getAllByTestId('approval-decision').at(-1)?.textContent).toBe(
      'Denied: Use pnpm.',
    );
  });
});

const plan = (from: 'request' | 'conversation'): ApprovalItemPayload => ({
  approvalId: 't1:p1',
  kind: 'plan',
  summary: 'Exit plan mode',
  plan: { text: '## Plan\n\n1. Read the timer\n2. Add the bell', from },
});

describe('the plan card (spec 42, 43)', () => {
  it('renders the plan, starts it with edits accepted on Enter, and offers its choices with keys', async () => {
    const user = userEvent.setup();
    const h = harness();
    const row = approvalRow(plan('request'));
    h.show(
      <ul>
        <ConversationItem
          item={row.item}
          approvals={[row.approval]}
          questions={[]}
          context={context}
        />
      </ul>,
    );
    const card = within(screen.getByTestId('plan-card'));
    expect(await card.findByRole('heading', { name: 'Plan' })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('Start, accept edits');
    expect(
      approvalCommands(approvalCardStore.getState().offer).map((command) => [
        command.title,
        command.keybinding,
      ]),
    ).toEqual([
      ['Plan: start, accept edits', 'keybindings.planAcceptEdits'],
      ['Plan: start, ask each time', 'keybindings.planAskEachTime'],
      ['Plan: keep planning…', 'keybindings.planKeepPlanning'],
    ]);
    await user.keyboard('{Enter}');
    expect(h.sent).toEqual([
      {
        type: 'approval.answer',
        approvalId: 't1:p1',
        decision: 'allowOnce',
        permissionMode: 'acceptEdits',
      },
    ]);
  });

  it('keeps planning with a note, and labels a plan taken from the conversation', async () => {
    const user = userEvent.setup();
    const h = harness();
    const row = approvalRow(plan('conversation'));
    h.show(
      <ul>
        <ConversationItem
          item={row.item}
          approvals={[row.approval]}
          questions={[]}
          context={context}
        />
      </ul>,
    );
    expect(screen.getByText('The plan as written in the conversation')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Keep planning' }));
    await user.type(
      screen.getByPlaceholderText('What to change in the plan'),
      'Test first.{Enter}',
    );
    expect(h.sent).toEqual([
      { type: 'approval.answer', approvalId: 't1:p1', decision: 'deny', note: 'Test first.' },
    ]);
  });
});

const file = (path: string, added: number, removed: number) => ({
  path,
  oldPath: null,
  status: 'modified' as const,
  content: 'text' as const,
  added,
  removed,
  size: 10,
  changedBy: [],
});

const listing: ThreadDiff = {
  status: 'ok',
  message: null,
  baseSha: 'abc',
  files: [file('README.md', 2, 0), file('src/timer.ts', 40, 7)],
  omitted: 0,
  patch: null,
  turnPaths: ['README.md'],
};

const names = async () =>
  (await screen.findAllByTestId('thread-changes-file')).map((row) => row.textContent);

describe("a thread's Changes (spec 34, 35)", () => {
  it('sums the changes in the chip and opens them', async () => {
    const user = userEvent.setup();
    expect(changesSummary(listing.files)).toBe('+42 −7 in 2 files');
    expect(changesSummary([])).toBeUndefined();
    const h = harness({ 'threads.diff': listing });
    h.show(<ThreadChangesChip threadId="t1" />);
    await user.click(await screen.findByRole('button', { name: 'Changes: +42 −7 in 2 files' }));
    expect(threadChangesStore.getState().threadId).toBe('t1');
    // A tab of the thread's panel, selected (no router here, so the route is '').
    expect(h.runtime.layout.getState().panelTabs['']?.selected).toBe('changes:t1');
  });

  it('lists the files, narrows to this turn and shows a file’s diff', async () => {
    const user = userEvent.setup();
    const h = harness({
      'threads.diff': listing,
      'threads.diff:src/timer.ts': {
        ...listing,
        files: [file('src/timer.ts', 40, 7)],
        patch: '@@ -1 +1 @@\n-a\n+b',
      },
      'threads.diff:README.md': {
        ...listing,
        files: [file('README.md', 2, 0)],
        patch: '@@ -1 +1,3 @@\n a\n+b\n+c',
      },
    });
    act(() => threadChangesStore.setState({ threadId: 't1' }));
    h.show(<ThreadChanges changes={{ threadId: 't1', from: '/chat/t1' }} />);
    expect(await names()).toEqual(['MREADME.md+2 −0', 'Msrc/timer.ts+40 −7']);
    await user.click(screen.getByText('src/timer.ts'));
    expect(await screen.findByRole('table', { name: 'Diff of src/timer.ts' })).toBeTruthy();
    expect(
      threadChangesCommands('t1', '/chat/t1', true, false).map((command) => command.keybinding),
    ).toEqual(['keybindings.threadChanges', 'keybindings.changesStepOnly']);
    act(() => threadChangesCommands('t1', '/chat/t1', true, false)[1]?.run({} as never));
    expect(await names()).toEqual(['MREADME.md+2 −0']);
  });

  it('reads the changes again once the running turn is marked, not only when it ends', async () => {
    const turn: Turn = {
      id: 't1:turn:0',
      threadId: 't1',
      index: 0,
      state: 'running',
      startedAt: '2026-11-02T08:00:00.000Z',
      endedAt: null,
      usage: null,
      marked: false,
    };
    const h = harness(
      { 'threads.diff': { ...listing, status: 'noBase', files: [], turnPaths: null } },
      [turn],
    );
    act(() => threadChangesStore.setState({ threadId: 't1' }));
    h.show(<ThreadChanges changes={{ threadId: 't1', from: '/chat/t1' }} />);
    expect(await screen.findByText('No starting point')).toBeTruthy();
    h.request.mockImplementation((method) =>
      Promise.resolve(method === 'threads.diff' ? listing : null),
    );
    act(() => h.pushTurns([{ ...turn, marked: true }]));
    expect(await names()).toEqual(['MREADME.md+2 −0', 'Msrc/timer.ts+40 −7']);
  });

  it('says why when the folder is not in git, or the thread has no base', async () => {
    const h = harness({
      'threads.diff': { ...listing, status: 'noBase', files: [], turnPaths: null },
    });
    act(() => threadChangesStore.setState({ threadId: 't1' }));
    h.show(<ThreadChanges changes={{ threadId: 't1', from: '/chat/t1' }} />);
    expect(await screen.findByText('No starting point')).toBeTruthy();
  });
});
