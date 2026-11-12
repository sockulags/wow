import type { Approval, Question, ThreadItem, Turn } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import {
  conversationText,
  findCountText,
  findMatches,
  foldCase,
  keepCurrent,
  markdownText,
  type FindPiece,
  type FindSource,
} from './find';
import { groupToolCalls, nestSubagentWork } from './view-model';

// Thread work spec 2 to 5: what find matches in each kind of row, what has to open for a match to
// show, the count and the limit. All invented.

const turn = (index: number, overrides: Partial<Turn> = {}): Turn => ({
  id: `turn-${index}`,
  threadId: 'thread-1',
  index,
  state: 'completed',
  startedAt: '2026-11-12T20:40:00.000Z',
  endedAt: '2026-11-12T20:41:00.000Z',
  usage: null,
  ...overrides,
});

const item = (id: string, kind: ThreadItem['kind'], payload: unknown, turnId = 'turn-0') => ({
  id,
  threadId: 'thread-1',
  turnId,
  index: 0,
  kind,
  payload,
  streaming: false,
});

function source(
  items: ThreadItem[],
  extra: { approvals?: Approval[]; questions?: Question[]; turns?: Turn[] } = {},
): FindSource {
  const { top, children } = nestSubagentWork(items);
  return {
    entries: groupToolCalls(top),
    children,
    turns: extra.turns ?? [turn(0)],
    approvals: extra.approvals ?? [],
    questions: extra.questions ?? [],
    cwd: '/work/tea',
    outputLines: 20,
  };
}

const found = (pieces: readonly FindPiece[], query: string) =>
  findMatches(pieces, query, 1000).matches.map((match) => ({
    itemId: match.itemId,
    text: pieces[match.piece]?.text.slice(match.start, match.end),
    opens: pieces[match.piece]?.opens,
  }));

const read = (id: string, path: string) =>
  item(id, 'tool_call', {
    name: 'Read',
    input: { file_path: path },
    output: 'Steep\n',
    status: 'ok',
    kind: 'read',
    path,
  });

describe('what find matches (spec 2)', () => {
  it('matches a message as rendered, not its markdown', () => {
    expect(
      markdownText('The **kettle** and `the pot`\n\n- one\n- [two](https://example.org)'),
    ).toBe('The kettle and the pot\none\ntwo');
    const pieces = conversationText(
      source([item('a', 'assistant_text', { text: 'The **kettle** whistles' })]),
    );
    expect(found(pieces, 'kettle whistles')).toEqual([
      { itemId: 'a', text: 'kettle whistles', opens: [] },
    ]);
    expect(found(pieces, '**')).toEqual([]);
  });

  it('matches a user message, its files and its skills, but not the mention line twice', () => {
    const pieces = conversationText(
      source([
        item('u', 'user', {
          text: '@src/kettle.ts\n\nFix the kettle',
          files: ['src/kettle.ts'],
          skills: [{ name: 'kettle-check', source: 'wow' }],
        }),
      ]),
    );
    expect(found(pieces, 'kettle').map((match) => match.text)).toHaveLength(3);
  });

  it('matches closed reasoning, and opens it', () => {
    const pieces = conversationText(
      source([item('r', 'reasoning', { text: 'Think of the kettle' })]),
    );
    expect(found(pieces, 'kettle')).toEqual([
      { itemId: 'r', text: 'kettle', opens: ['reasoning:r'] },
    ]);
  });

  it("matches a command's line and its whole output, opening the row and its earlier lines", () => {
    const output = Array.from({ length: 40 }, (_, line) =>
      line === 2 ? 'the kettle whistled' : line === 39 ? 'kettle cooled' : `line ${line + 1}`,
    ).join('\n');
    const pieces = conversationText(
      source([
        item('c', 'tool_call', {
          name: 'Bash',
          input: { command: 'cat kettle.txt', secret: 'kettle in the input' },
          output,
          status: 'ok',
          kind: 'command',
          command: 'cat kettle.txt',
          exitCode: 0,
        }),
      ]),
    );
    expect(found(pieces, 'kettle')).toEqual([
      { itemId: 'c', text: 'kettle', opens: [] },
      { itemId: 'c', text: 'kettle', opens: ['row:c', 'output:c'] },
      { itemId: 'c', text: 'kettle', opens: ['row:c'] },
    ]);
  });

  it('matches the calls of a closed group, opening the group first', () => {
    const pieces = conversationText(
      source([read('r1', '/work/tea/notes/brew.md'), read('r2', '/work/tea/notes/kettle.md')]),
    );
    expect(found(pieces, 'kettle')).toEqual([
      { itemId: 'r2', text: 'kettle', opens: ['group:r1'] },
    ]);
    expect(found(pieces, 'steep').map((match) => match.opens)).toEqual([
      ['group:r1', 'row:r1'],
      ['group:r1', 'row:r2'],
    ]);
  });

  it("matches an edit's diff lines and an MCP call's arguments, never their JSON", () => {
    const pieces = conversationText(
      source([
        item('e', 'tool_call', {
          name: 'Edit',
          input: { old_string: 'json kettle' },
          output: '',
          status: 'ok',
          kind: 'edit',
          path: '/work/tea/src/a.ts',
          diff: '@@ -1 +1 @@\n-const pot = 1;\n+const kettle = 1;',
        }),
        item('u', 'user', { text: 'next' }),
        item('m', 'tool_call', {
          name: 'mcp__tracker__find',
          input: { key: 'KETTLE-1' },
          output: '',
          status: 'ok',
          kind: 'mcp',
          server: 'tracker',
          tool: 'find',
        }),
      ]),
    );
    expect(found(pieces, 'kettle')).toEqual([
      { itemId: 'e', text: 'kettle', opens: ['row:e'] },
      { itemId: 'm', text: 'KETTLE', opens: [] },
      { itemId: 'm', text: 'KETTLE', opens: ['row:m'] },
    ]);
    expect(found(pieces, 'json')).toEqual([]);
    expect(found(pieces, 'old_string')).toEqual([]);
  });

  it("matches a subagent's line, prompt, nested rows and answer", () => {
    const pieces = conversationText(
      source([
        item('agent', 'tool_call', {
          name: 'Task',
          input: {},
          output: '',
          status: 'ok',
          kind: 'subagent',
          description: 'find the kettle',
          prompt: 'Look for the kettle',
          answer: 'The **kettle** is in the shed.',
        }),
        item('nested', 'tool_call', {
          name: 'Read',
          input: {},
          output: '',
          status: 'ok',
          kind: 'read',
          path: '/work/tea/kettle.md',
          parentItemId: 'agent',
        }),
      ]),
    );
    expect(found(pieces, 'kettle')).toEqual([
      { itemId: 'agent', text: 'kettle', opens: [] },
      { itemId: 'agent', text: 'kettle', opens: ['agent:agent'] },
      { itemId: 'nested', text: 'kettle', opens: ['agent:agent'] },
      { itemId: 'agent', text: 'kettle', opens: [] },
    ]);
  });

  it('matches the shown text of approval, plan and question cards, not their details', () => {
    const approvals: Approval[] = [
      {
        id: 'ap-1',
        threadId: 'thread-1',
        itemId: 'ap',
        kind: 'command',
        request: { details: { kettle: 'details json' } },
        decision: 'deny',
        decidedAt: '2026-11-12T20:40:30.000Z',
      },
    ];
    const questions: Question[] = [
      { id: 'q-1', threadId: 'thread-1', itemId: 'q', request: {}, answer: null, answeredAt: null },
    ];
    const pieces = conversationText(
      source(
        [
          item('ap', 'approval', {
            approvalId: 'ap-1',
            kind: 'command',
            summary: 'boil kettle',
            facts: { kind: 'command', command: 'boil kettle' },
            note: 'not the kettle',
          }),
          item('pl', 'approval', {
            approvalId: 'ap-2',
            kind: 'plan',
            summary: 'Exit plan mode',
            plan: { text: '## Fill the kettle', from: 'request' },
          }),
          item('q', 'question', {
            questionId: 'q-1',
            question: 'Which kettle?',
            options: [{ label: 'Red kettle', description: 'the old one' }],
            multiSelect: false,
          }),
        ],
        { approvals, questions, turns: [turn(0, { state: 'running', endedAt: null })] },
      ),
    );
    expect(found(pieces, 'kettle').map((match) => match.itemId)).toEqual([
      'ap',
      'ap',
      'ap',
      'pl',
      'q',
      'q',
    ]);
    expect(found(pieces, 'details json')).toEqual([]);
  });

  it('matches error, divider and compaction lines and task lists, opening a closed task list', () => {
    const pieces = conversationText(
      source([
        item('err', 'error', { message: 'The kettle broke' }),
        item('div', 'settings_change', { model: { from: 'kettle-1', to: 'kettle-2' } }),
        item('cmp', 'compaction', { trigger: 'auto', at: '2026-11-12T20:40:00.000Z' }),
        item('t', 'task_list', {
          tasks: [{ id: '1', content: 'Boil the kettle', status: 'pending' }],
          at: '2026-11-12T20:40:00.000Z',
        }),
      ]),
    );
    expect(found(pieces, 'kettle').map((match) => [match.itemId, match.opens])).toEqual([
      ['err', []],
      ['div', []],
      ['div', []],
      ['t', ['tasks:t']],
    ]);
    expect(found(pieces, 'compacted')).toEqual([{ itemId: 'cmp', text: 'compacted', opens: [] }]);
    expect(found(pieces, 'updated tasks')).toHaveLength(1);
  });
});

describe('matching and counting (spec 2, 3, 5)', () => {
  const pieces: FindPiece[] = [
    { itemId: 'a', text: 'Kettle, KETTLE, kettle', opens: [] },
    { itemId: 'b', text: 'no match here', opens: [] },
    { itemId: 'c', text: 'ΚΕΤΤΛΕ kettle', opens: [] },
  ];

  it('ignores case for every letter and counts each match of a row', () => {
    expect(foldCase('ΚΈΤΤΛΕ İstanbul')).toBe('κέττλε İstanbul');
    const result = findMatches(pieces, 'KeTtLe', 1000);
    expect(result.more).toBe(false);
    expect(result.matches.map((match) => [match.itemId, match.nth])).toEqual([
      ['a', 0],
      ['a', 1],
      ['a', 2],
      ['c', 0],
    ]);
    expect(findMatches(pieces, 'κεττλε', 1000).matches).toHaveLength(1);
    expect(findMatches(pieces, '', 1000).matches).toEqual([]);
  });

  it('stops at the limit and says so', () => {
    const result = findMatches(pieces, 'kettle', 3);
    expect(result.matches).toHaveLength(3);
    expect(result.more).toBe(true);
    expect(findCountText(result, 0, 3)).toBe('3+');
    expect(findCountText(findMatches(pieces, 'kettle', 4), 1, 4)).toBe('2 of 4');
    expect(findCountText(findMatches(pieces, 'teapot', 4), -1, 4)).toBe('No matches');
  });

  it('keeps the current match on its row while the matches change', () => {
    const before = findMatches(pieces, 'kettle', 1000).matches;
    expect(keepCurrent(before, { itemId: 'c', nth: 0 })).toBe(3);
    const grown = findMatches(
      [{ itemId: 'new', text: 'a kettle first', opens: [] }, ...pieces],
      'kettle',
      1000,
    ).matches;
    expect(grown[keepCurrent(grown, { itemId: 'c', nth: 0 })]?.itemId).toBe('c');
    expect(keepCurrent(grown, { itemId: 'a', nth: 7 })).toBe(1);
    expect(keepCurrent(grown, undefined)).toBe(0);
    expect(keepCurrent([], undefined)).toBe(-1);
  });
});
