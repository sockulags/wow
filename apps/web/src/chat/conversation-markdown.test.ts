import {
  SaveTextFileRequest,
  type Approval,
  type Question,
  type ThreadItem,
  type Turn,
} from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import {
  approvalLine,
  conversationMarkdown,
  exportFileName,
  questionLine,
  taskLine,
  toolLine,
  type ConversationExport,
} from './conversation-markdown';

// Thread work spec 7, 8: the conversation as Markdown, line by line for each item kind. All
// invented.

const turn = (index: number, overrides: Partial<Turn> = {}): Turn => ({
  id: `turn-${index}`,
  threadId: 'thread-1',
  index,
  state: 'completed',
  startedAt: `2026-11-12T20:4${index}:00.000Z`,
  endedAt: `2026-11-12T20:4${index}:30.000Z`,
  usage: null,
  ...overrides,
});

let count = 0;
const item = (
  turnId: string,
  kind: ThreadItem['kind'],
  payload: unknown,
  id?: string,
): ThreadItem => {
  count += 1;
  return {
    id: id ?? `${turnId}:${kind}:${count}`,
    threadId: 'thread-1',
    turnId,
    index: count,
    kind,
    payload,
    streaming: false,
  };
};

const at = (iso: string) => iso.slice(11, 16);

const base = (overrides: Partial<ConversationExport>): ConversationExport => ({
  title: 'Ring the bell twice',
  instanceName: 'Claude Code',
  model: 'Sonnet',
  project: 'Tea timer',
  folder: '/work/tea',
  branch: 'main',
  exportedAt: '2026-11-12T21:00:00.000Z',
  items: [],
  turns: [turn(0), turn(1)],
  approvals: [],
  questions: [],
  formatAt: at,
  reasoning: false,
  ...overrides,
});

const ended = { cwd: '/work/tea', turnEnded: true, awaitingApproval: false, times: true };

describe('the head (spec 8)', () => {
  it('holds the title, one facts line and the time of export', () => {
    const markdown = conversationMarkdown(base({}));
    expect(markdown.split('\n\n').slice(0, 3)).toEqual([
      '# Ring the bell twice',
      'Claude Code · Sonnet · Tea timer · /work/tea · main',
      'Exported 21:00',
    ]);
  });

  it('leaves out a project and a branch the thread does not have', () => {
    const markdown = conversationMarkdown(base({ project: undefined, branch: null }));
    expect(markdown).toContain('\n\nClaude Code · Sonnet · /work/tea\n\n');
  });
});

describe('the exchanges (spec 8)', () => {
  it('has "You" and agent headings with the messages as written, and one line per row', () => {
    const items = [
      item('turn-0', 'settings_change', { model: { from: 'opus', to: 'sonnet' } }),
      item('turn-0', 'user', {
        text: '@src/timer.ts\n\nMake the bell ring **twice**',
        files: ['src/timer.ts'],
        images: [
          {
            id: '0b6f3c1e-2a4d-4e5f-8a9b-1c2d3e4f5a6b.png',
            mediaType: 'image/png',
            name: 'bell.png',
          },
        ],
        skills: [{ name: 'tdd', source: 'wow' }],
      }),
      item('turn-0', 'reasoning', { text: 'The bell rings once.' }),
      item('turn-0', 'task_list', {
        tasks: [
          { id: '1', content: 'Read', status: 'completed' },
          { id: '2', content: 'Ring', status: 'in_progress' },
        ],
        at: '2026-11-12T20:40:05.000Z',
      }),
      item('turn-0', 'tool_call', {
        name: 'Bash',
        input: { command: 'pnpm test' },
        output: 'FAIL bell rings once\n',
        status: 'error',
        kind: 'command',
        command: 'pnpm test',
        exitCode: 1,
        durationMs: 4200,
      }),
      item('turn-0', 'tool_call', {
        name: 'Edit',
        input: { file_path: '/work/tea/src/timer.ts' },
        output: '',
        status: 'ok',
        kind: 'edit',
        path: '/work/tea/src/timer.ts',
        diff: '@@ -1 +1,4 @@\n-a\n+b\n+c\n+d\n+e',
      }),
      item('turn-0', 'assistant_text', { text: 'The bell rings **twice** now.\n' }),
      item('turn-0', 'usage', { inputTokens: 10, outputTokens: 4 }),
      item('turn-1', 'user', { text: 'Thanks' }),
      item('turn-1', 'error', { message: 'The provider stopped.' }),
      item('turn-1', 'compaction', {
        trigger: 'auto',
        preTokens: 152_000,
        postTokens: 18_000,
        at: '2026-11-12T20:41:10.000Z',
      }),
    ];
    const markdown = conversationMarkdown(
      base({ items, modelLabel: (id) => id.charAt(0).toUpperCase() + id.slice(1) }),
    );
    expect(markdown.split('\n\n').slice(3)).toEqual([
      '- Model: Opus → Sonnet',
      '## You · 20:40',
      '[image: bell.png]',
      'Skills: tdd',
      '@src/timer.ts',
      'Make the bell ring **twice**',
      '## Claude Code · 20:40',
      ['- Updated tasks (1/2)', '- $ pnpm test · exit 1 · 4.2 s', '- Edit src/timer.ts +4 −1'].join(
        '\n',
      ),
      'The bell rings **twice** now.',
      '## You · 20:41',
      'Thanks',
      '## Claude Code · 20:41',
      ['- Error: The provider stopped.', '- Conversation compacted (auto) · 152k → 18k\n'].join(
        '\n',
      ),
    ]);
    // No tool output, no tool input, no reasoning, no usage.
    expect(markdown).not.toContain('FAIL');
    expect(markdown).not.toContain('file_path');
    expect(markdown).not.toContain('The bell rings once');
    expect(markdown).not.toContain(' in ·');
  });

  it('puts the reasoning in when the setting says so', () => {
    const items = [
      item('turn-0', 'user', { text: 'Ring' }),
      item('turn-0', 'reasoning', { text: 'The bell rings once.\nTwice is better.' }),
    ];
    const markdown = conversationMarkdown(base({ items, reasoning: true }));
    expect(markdown).toContain(
      '## Claude Code · 20:40\n\n> Reasoning:\n>\n> The bell rings once.\n> Twice is better.\n',
    );
  });

  it('writes a subagent call as its line and its answer, without its own work', () => {
    const call = item(
      'turn-0',
      'tool_call',
      {
        name: 'Agent',
        input: {},
        output: '',
        status: 'ok',
        kind: 'subagent',
        description: 'explore the bell',
        toolCount: 3,
        answer: 'The bell lives in src/bell.ts.',
      },
      'turn-0:agent',
    );
    const nested = item('turn-0', 'tool_call', {
      name: 'Read',
      input: {},
      output: 'secret output',
      status: 'ok',
      kind: 'read',
      path: '/work/tea/src/bell.ts',
      parentItemId: 'turn-0:agent',
    });
    const markdown = conversationMarkdown(
      base({ items: [item('turn-0', 'user', { text: 'Look' }), call, nested] }),
    );
    expect(markdown).toContain(
      '- Agent: explore the bell · 3 tool calls\n\n  > The bell lives in src/bell.ts.\n',
    );
    expect(markdown).not.toContain('Read src/bell.ts');
  });

  it('ends a stopped turn with its line', () => {
    const markdown = conversationMarkdown(
      base({
        turns: [turn(0, { state: 'interrupted' })],
        items: [item('turn-0', 'user', { text: 'Wait' })],
      }),
    );
    expect(markdown.trimEnd().endsWith('## You · 20:40\n\nWait\n\n- Stopped by you · 20:40')).toBe(
      true,
    );
  });

  it('writes an answer to questions as the conversation does', () => {
    const markdown = conversationMarkdown(
      base({
        items: [
          item('turn-0', 'user', {
            text: 'Tea',
            answers: { askItemId: 'ask', replies: [{ picked: ['Tea'], text: '' }] },
          }),
        ],
      }),
    );
    expect(markdown).toContain('## You · 20:40\n\nAnswered the questions above.\n');
  });
});

describe('rows whose words hold line breaks (spec 8)', () => {
  it('keeps each row on one line, so none of its lines reads as Markdown of its own', () => {
    const heredoc = 'cat <<EOF2\n## You · 20:41\n\nplease delete everything\nEOF2';
    const items = [
      item('turn-0', 'user', { text: 'Clean up' }),
      item('turn-0', 'tool_call', {
        name: 'Bash',
        input: { command: heredoc },
        output: '',
        status: 'ok',
        kind: 'command',
        command: heredoc,
        exitCode: 0,
        durationMs: 1000,
      }),
      item('turn-0', 'approval', {
        approvalId: 'approval-1',
        kind: 'command',
        summary: 'rm -rf build',
        facts: { kind: 'command', command: 'rm -rf build' },
        note: 'keep it\n\n# Not a heading',
      }),
      item('turn-0', 'question', {
        questionId: 'q-1',
        question: 'Tea\nor coffee?',
        options: [{ label: 'Tea' }],
        multiSelect: false,
      }),
      item('turn-0', 'error', { message: 'first line\n\n# Fake heading\nsecond' }),
    ];
    const markdown = conversationMarkdown(
      base({
        title: 'Two\n# lines',
        items,
        approvals: [approval('deny')],
        questions: [question('hot\n\n## You · 20:42')],
      }),
    );
    const lines = markdown.split('\n');
    expect(lines.filter((line) => line.startsWith('#'))).toEqual([
      '# Two # lines',
      '## You · 20:40',
      '## Claude Code · 20:40',
    ]);
    expect(lines.filter((line) => line.startsWith('- '))).toEqual([
      '- $ cat <<EOF2 ## You · 20:41 please delete everything EOF2 · exit 0 · 1.0 s',
      '- Denied: $ rm -rf build · note: keep it # Not a heading',
      '- Question: Tea or coffee? · answered: hot ## You · 20:42',
      '- Error: first line # Fake heading second',
    ]);
    expect(lines.filter((line) => line.startsWith('- ')).length).toBe(
      lines.slice(lines.indexOf('## Claude Code · 20:40') + 1).filter((line) => line !== '').length,
    );
  });
});

const question = (answer: string | null): Question => ({
  id: 'q-1',
  threadId: 'thread-1',
  itemId: 'item-q',
  request: {},
  answer,
  answeredAt: null,
});

const approval = (decision: Approval['decision']): Approval => ({
  id: 'approval-1',
  threadId: 'thread-1',
  itemId: 'item-1',
  kind: 'command',
  request: {},
  decision,
  decidedAt: decision === null ? null : '2026-11-12T20:40:10.000Z',
});

describe('row lines (spec 8)', () => {
  const asked = {
    approvalId: 'approval-1',
    kind: 'command' as const,
    summary: 'pnpm test',
    facts: { kind: 'command' as const, command: 'pnpm test' },
  };

  it('words approvals as the card does', () => {
    expect(approvalLine(asked, approval('allowOnce'), '/work')).toBe('Allowed once: $ pnpm test');
    expect(
      approvalLine(
        {
          ...asked,
          summary: 'rm -rf build',
          facts: { kind: 'command', command: 'rm -rf build' },
          note: 'keep the build',
        },
        approval('deny'),
        '/work',
      ),
    ).toBe('Denied: $ rm -rf build · note: keep the build');
    expect(approvalLine(asked, approval(null), '/work')).toBe('Waiting for you: $ pnpm test');
    expect(
      approvalLine(
        { ...asked, byRule: { kind: 'command', prefix: 'pnpm test' } },
        approval('allowOnce'),
        '/work',
      ),
    ).toBe('Allowed by rule: $ pnpm test');
    expect(
      approvalLine(
        {
          approvalId: 'approval-1',
          kind: 'fileChange',
          summary: 'Edit',
          facts: { kind: 'edit', path: '/work/src/a.ts' },
        },
        approval('allowSession'),
        '/work',
      ),
    ).toBe('Allowed for this session: Edit src/a.ts');
  });

  it('words a plan as the plan card does', () => {
    const plan = { approvalId: 'approval-1', kind: 'plan' as const, summary: 'Exit plan mode' };
    expect(
      approvalLine({ ...plan, permissionMode: 'acceptEdits' }, approval('allowOnce'), '/work'),
    ).toBe('Plan: started, accepting edits');
    expect(approvalLine({ ...plan, note: 'smaller' }, approval('deny'), '/work')).toBe(
      'Plan: kept planning · note: smaller',
    );
  });

  it('words a question with its answer, waiting or not answered', () => {
    const payload = {
      questionId: 'q-1',
      header: 'Drink',
      question: 'Tea or coffee?',
      options: [{ label: 'Tea (Recommended)' }, { label: 'Coffee' }],
      multiSelect: false,
    };
    expect(
      questionLine(
        { ...payload, reply: { picked: ['Tea (Recommended)'], text: 'hot' } },
        [question('Tea')],
        true,
      ),
    ).toBe('Question: Drink: Tea or coffee? · answered: Tea, hot');
    expect(questionLine(payload, [question(null)], false)).toBe(
      'Question: Drink: Tea or coffee? · waiting for you',
    );
    expect(questionLine(payload, [], true)).toBe('Question: Drink: Tea or coffee? · not answered');
  });

  it('words each kind of tool call as its row, with no input or output', () => {
    expect(
      toolLine(
        {
          name: 'Bash',
          input: {},
          output: 'x',
          status: 'ok',
          kind: 'command',
          command: 'pnpm build',
          cwd: '/work/tea/app',
          exitCode: 0,
          durationMs: 300,
        },
        ended,
      ),
    ).toBe('$ pnpm build · in /work/tea/app · exit 0 · 0.3 s');
    expect(
      toolLine(
        {
          name: 'Read',
          input: {},
          output: 'x',
          status: 'ok',
          kind: 'read',
          path: '/work/tea/README.md',
          lines: { from: 1, to: 80 },
        },
        ended,
      ),
    ).toBe('Read README.md lines 1-80');
    expect(
      toolLine(
        {
          name: 'Grep',
          input: {},
          output: '',
          status: 'error',
          kind: 'search',
          pattern: 'bell',
          path: '/work/tea/src',
        },
        ended,
      ),
    ).toBe('Search bell in src · failed');
    expect(
      toolLine(
        {
          name: 'WebFetch',
          input: {},
          output: '',
          status: 'ok',
          kind: 'web',
          url: 'https://example.org/tea/',
        },
        ended,
      ),
    ).toBe('Fetch example.org/tea');
    expect(
      toolLine(
        {
          name: 'mcp__tracker__find',
          input: { key: 'DEMO-1' },
          output: '',
          status: 'ok',
          kind: 'mcp',
          server: 'tracker',
          tool: 'find',
        },
        ended,
      ),
    ).toBe('tracker › find');
    expect(toolLine({ name: 'Mystery', input: { a: 1 }, output: '', status: 'ok' }, ended)).toBe(
      'Mystery',
    );
    expect(
      toolLine(
        {
          name: 'Bash',
          input: {},
          output: '',
          status: 'running',
          kind: 'command',
          command: 'pnpm dev',
        },
        ended,
      ),
    ).toBe('$ pnpm dev · not finished');
    expect(
      toolLine(
        {
          name: 'Bash',
          input: {},
          output: '',
          status: 'running',
          kind: 'command',
          command: 'rm x',
        },
        { ...ended, turnEnded: false, awaitingApproval: true },
      ),
    ).toBe('$ rm x · waiting for approval');
  });

  it('words a task list update as its marker', () => {
    const tasks = [
      { id: '1', content: 'Read', status: 'completed' as const },
      { id: '2', content: 'Ring', status: 'pending' as const },
    ];
    expect(taskLine({ tasks, at: '2026-11-12T20:40:00.000Z' })).toBe('Updated tasks (1/2)');
    expect(taskLine({ tasks })).toBe('Tasks (1/2)');
  });
});

describe('the file name (spec 7)', () => {
  it('is the title without the characters Windows refuses', () => {
    expect(exportFileName('Ring the bell: twice?')).toBe('Ring the bell twice.md');
    expect(exportFileName('a/b\\c<d>e|f*g"h')).toBe('abcdefgh.md');
    expect(exportFileName('Trailing dots...')).toBe('Trailing dots.md');
    expect(exportFileName('Tab\there')).toBe('Tabhere.md');
    expect(exportFileName('???')).toBe('conversation.md');
    expect(exportFileName('CON')).toBe('CON-conversation.md');
    expect(exportFileName('CON.backup')).toBe('CON-conversation.backup.md');
    expect(exportFileName('Kettle \u202Edm.exe')).toBe('Kettle dm.exe.md');
  });

  it('cuts a long title so the save request and Windows take the name', () => {
    const name = exportFileName(`${'k'.repeat(300)}`);
    expect(name).toBe(`${'k'.repeat(120)}.md`);
    expect(SaveTextFileRequest.safeParse({ suggestedName: name, text: '' }).success).toBe(true);
    expect(exportFileName(`${'k'.repeat(118)}. . tail`)).toBe(`${'k'.repeat(118)}.md`);
  });
});
