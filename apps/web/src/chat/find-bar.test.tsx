import type { ProviderInstance, Thread, ThreadItem, Turn } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from 'zustand';
import { createStore } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '@/app/commands';
import { createLayoutStore, RuntimeProvider, type Runtime } from '@/app/runtime';
import { useGlobalKeybindings } from '@/app/use-commands';
import { keyScope } from '@/settings/keybindings-table';
import { conversationCommands, conversationStore } from './conversation-nav';
import { createDraftStore } from './draft';
import type * as FindModule from './find';
import { conversationText } from './find';
import { ThreadConversation, ThreadView } from './thread-view';

// The real text walk, counted: find reads the conversation again only when it changed.
vi.mock('./find', async (importOriginal) => {
  const real = await importOriginal<typeof FindModule>();
  return {
    ...real,
    conversationText: vi.fn<typeof real.conversationText>(real.conversationText),
  };
});

// Thread work U1 in the thread view: Ctrl+F finds text anywhere in the conversation and opens
// what holds it; the conversation copies and saves as Markdown. All invented.

const thread: Thread = {
  id: 'thread-kettle',
  projectId: null,
  cwd: '/work/tea',
  branch: 'main',
  providerInstanceId: 'claude',
  providerSessionId: null,
  title: 'Tell the kettle story',
  model: 'sonnet',
  effort: 'high',
  permissionMode: 'default',
  state: 'idle',
  pinned: false,
  runId: null,
  stepId: null,
  createdAt: '2026-11-12T20:40:00.000Z',
  updatedAt: '2026-11-12T20:40:00.000Z',
};

const claude: ProviderInstance = {
  id: 'claude',
  kind: 'claude',
  name: 'Claude Code',
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

const turn = (index: number, overrides: Partial<Turn> = {}): Turn => ({
  id: `turn-${index}`,
  threadId: thread.id,
  index,
  state: 'completed',
  startedAt: `2026-11-12T20:4${index}:00.000Z`,
  endedAt: `2026-11-12T20:4${index}:30.000Z`,
  usage: null,
  ...overrides,
});

const item = (
  id: string,
  kind: ThreadItem['kind'],
  payload: unknown,
  overrides: Partial<ThreadItem> = {},
): ThreadItem => ({
  id,
  threadId: thread.id,
  turnId: 'turn-0',
  index: 0,
  kind,
  payload,
  streaming: false,
  ...overrides,
});

const story = Array.from({ length: 40 }, (_, line) =>
  line === 2 ? 'line 3: the kettle whistled' : `line ${line + 1}: the water warmed`,
).join('\n');

const read = (id: string, file: string) =>
  item(id, 'tool_call', {
    name: 'Read',
    input: { file_path: `/work/tea/${file}` },
    output: 'Steep for three minutes.\n',
    status: 'ok',
    kind: 'read',
    path: `/work/tea/${file}`,
  });

// The kettle story: the word in the message, closed reasoning, the reply in bold, line 3 of a
// 40-line output and a read in a closed group.
const kettleStory = (): ThreadItem[] => [
  item('turn-0:user', 'user', { text: 'Tell the kettle story' }),
  item('turn-0:thinking', 'reasoning', { text: 'Tell it about the kettle.' }),
  item('turn-0:story-1', 'assistant_text', { text: 'Here is the **kettle** story.' }),
  item('turn-0:cat', 'tool_call', {
    name: 'Bash',
    input: { command: 'cat story.txt' },
    output: `${story}\n`,
    status: 'ok',
    kind: 'command',
    command: 'cat story.txt',
    exitCode: 0,
    durationMs: 400,
  }),
  item('turn-0:story-2', 'assistant_text', { text: 'Then I read the notes.' }),
  read('turn-0:read-0', 'notes/brew.md'),
  read('turn-0:read-1', 'notes/kettle.md'),
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
  items = kettleStory(),
  turns = [turn(0)],
  settings = {},
  runtime = {},
  view = 'conversation',
}: {
  items?: ThreadItem[];
  turns?: Turn[];
  settings?: Record<string, unknown>;
  runtime?: Partial<Runtime>;
  view?: 'conversation' | 'thread' | 'assistant';
} = {}) {
  const listeners = new Map<string, (rows: unknown) => void>();
  const shown: Thread = view === 'assistant' ? { ...thread, kind: 'assistant' } : thread;
  const topics: Record<string, unknown> = {
    turns,
    threadItems: items,
    threads: [shown],
    providerInstances: [claude],
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: ((method: string) =>
      method === 'provider.listModels'
        ? Promise.resolve([{ id: 'sonnet', label: 'Sonnet', description: '', efforts: [] }])
        : Promise.resolve({ commandId: 'c', seqs: [], duplicate: false })) as Connection['request'],
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
        settings: createSettingsStore(createMemorySettingsSource(undefined, settings)),
        ...runtime,
      }}
    >
      {view === 'thread' ? (
        <ThreadView threadId={thread.id} />
      ) : (
        <ThreadConversation
          thread={shown}
          instance={claude}
          autoFocus
          {...(view === 'assistant' ? { extras: { placeholder: 'Ask wow' } } : {})}
        />
      )}
      <ConversationKeys />
    </RuntimeProvider>,
  );
  const push = (topic: string, rows: unknown) => act(() => listeners.get(topic)?.(rows));
  return { push };
}

const composer = () => screen.getByRole('combobox', { name: 'Message' });
const field = () => screen.findByRole('searchbox', { name: 'Find in conversation' });
const count = () => screen.getByTestId('find-count').textContent;
const current = () =>
  [...document.querySelectorAll<HTMLElement>('[data-find-current]')].map(
    (row) => row.dataset['itemId'],
  );
const row = (itemId: string) =>
  [...document.querySelectorAll<HTMLElement>('li[data-item-id]')]
    .filter((element) => element.dataset['itemId'] === itemId)
    .at(-1);

beforeEach(() => {
  conversationStore.setState({ reasoning: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('find in the conversation (spec 1 to 4)', () => {
  it('opens from the composer, counts across closed rows and opens what holds each match', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(composer());
    await user.keyboard('{Control>}f{/Control}');
    const input = await field();
    expect(document.activeElement).toBe(input);
    await user.keyboard('KETTLE');
    expect(count()).toBe('1 of 5');
    expect(current()).toEqual(['turn-0:user']);
    // Without the Custom Highlight API (jsdom) the current match's row is outlined.
    expect(row('turn-0:user')?.dataset['findOutline']).toBe('true');

    const reasoning = row('turn-0:thinking')?.querySelector('details');
    expect(reasoning?.open).toBe(false);
    await user.keyboard('{F3}');
    expect(count()).toBe('2 of 5');
    expect(row('turn-0:thinking')?.querySelector('details')?.open).toBe(true);

    await user.keyboard('{Enter}');
    expect(count()).toBe('3 of 5');
    expect(current()).toEqual(['turn-0:story-1']);

    await user.keyboard('{Enter}');
    expect(count()).toBe('4 of 5');
    const command = row('turn-0:cat');
    expect(command?.querySelector('details')?.open).toBe(true);
    // The match is on line 3, before the last 20: the output shows all of its lines.
    expect(within(command as HTMLElement).getByTestId('tool-output-text').textContent).toContain(
      'line 3: the kettle whistled',
    );
    expect(
      within(command as HTMLElement).getByRole('button', { name: 'Show the last 20 lines' }),
    ).toBeTruthy();

    await user.keyboard('{F3}');
    expect(count()).toBe('5 of 5');
    const group = screen.getByTestId('item-tool_group');
    expect(group.querySelector('details')?.open).toBe(true);
    expect(current()).toEqual(['turn-0:read-1']);

    // Wrapping at both ends.
    await user.keyboard('{F3}');
    expect(count()).toBe('1 of 5');
    await user.keyboard('{Shift>}{F3}{/Shift}');
    expect(count()).toBe('5 of 5');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(count()).toBe('4 of 5');
    await user.click(screen.getByRole('button', { name: 'Next match' }));
    expect(count()).toBe('5 of 5');
    await user.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(count()).toBe('4 of 5');
  });

  it('selects the field again on a second Ctrl+F, and reads "No matches"', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(composer());
    await user.keyboard('{Control>}f{/Control}');
    const input = (await field()) as HTMLInputElement;
    await user.keyboard('teapot');
    expect(count()).toBe('No matches');
    await user.click(composer());
    await user.keyboard('{Control>}f{/Control}');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6]);
  });

  it('closes with Escape, gives the focus back and leaves what it opened open (spec 1, 4)', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(composer());
    await user.keyboard('{Control>}f{/Control}');
    await field();
    await user.keyboard('kettle{F3}');
    expect(row('turn-0:thinking')?.querySelector('details')?.open).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('find-bar')).toBeNull();
    expect(document.activeElement).toBe(composer());
    expect(row('turn-0:thinking')?.querySelector('details')?.open).toBe(true);
    expect(current()).toEqual([]);
  });

  it('closes with Escape after a click on one of its buttons (spec 1)', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(composer());
    await user.keyboard('{Control>}f{/Control}');
    await field();
    await user.keyboard('kettle');
    await user.click(screen.getByRole('button', { name: 'Next match' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next match' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('find-bar')).toBeNull();
  });

  it('marks the counted match, and outlines the row where its text on screen holds more (spec 2)', async () => {
    const registry = new Map<string, { ranges: Range[] }>();
    vi.stubGlobal('CSS', { highlights: registry });
    vi.stubGlobal(
      'Highlight',
      class {
        readonly ranges: Range[];
        constructor(...ranges: Range[]) {
          this.ranges = ranges;
        }
      },
    );
    try {
      const user = userEvent.setup();
      setup({
        items: [
          item('turn-0:user', 'user', { text: 'Make tea' }),
          item('turn-0:reply', 'assistant_text', { text: 'Put the\nkettle on.' }),
          item('turn-0:wait', 'tool_call', {
            name: 'Bash',
            input: { command: 'sleep 4.2' },
            output: '',
            status: 'ok',
            kind: 'command',
            command: 'sleep 4.2',
            exitCode: 0,
            durationMs: 4200,
          }),
        ],
      });
      await user.click(composer());
      await user.keyboard('{Control>}f{/Control}');
      await field();
      // Across the line break the message shows as a space.
      await user.keyboard('the kettle');
      expect(count()).toBe('1 of 1');
      expect(registry.get('wow-find-current')?.ranges.map((range) => range.toString())).toEqual([
        'the\nkettle',
      ]);
      expect(current()).toEqual(['turn-0:reply']);
      expect(row('turn-0:reply')?.dataset['findOutline']).toBeUndefined();

      // The call's line counts "4.2" once; its row on screen also shows the time "4.2 s".
      await user.clear(await field());
      await user.keyboard('4.2');
      expect(count()).toBe('1 of 1');
      expect(current()).toEqual(['turn-0:wait']);
      expect(registry.get('wow-find-current')?.ranges).toEqual([]);
      expect(row('turn-0:wait')?.dataset['findOutline']).toBe('true');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('marks a match in the second question of one ask card on that card (spec 3)', async () => {
    const user = userEvent.setup();
    const question = (id: string, text: string, label: string) =>
      item(id, 'question', {
        questionId: id,
        question: text,
        askId: 'ask-1',
        options: [{ label }],
        multiSelect: false,
      });
    setup({
      items: [
        item('turn-0:user', 'user', { text: 'Make tea' }),
        question('turn-0:q1', 'Which pot?', 'The blue pot'),
        question('turn-0:q2', 'Which oolong?', 'Milk oolong'),
      ],
      turns: [turn(0, { state: 'running', endedAt: null })],
    });
    expect(row('turn-0:q2')).toBeUndefined();
    await user.click(composer());
    await user.keyboard('{Control>}f{/Control}');
    await field();
    // Only the second question's text holds it; the card is drawn as one row.
    await user.keyboard('oolong');
    expect(count()).toBe('1 of 1');
    expect(current()).toEqual(['turn-0:q1']);
  });

  it("shows a subagent's whole prompt when the match is past the lines it shows at first (spec 2)", async () => {
    const user = userEvent.setup();
    const prompt = ['Boil the water.', 'Warm the pot.', 'Add the leaves.', 'Pour.', 'Use oolong.'];
    setup({
      items: [
        item('turn-0:user', 'user', { text: 'Make tea' }),
        item('turn-0:agent', 'tool_call', {
          name: 'Task',
          input: {},
          output: '',
          status: 'ok',
          kind: 'subagent',
          description: 'brew the tea',
          prompt: prompt.join('\n'),
          answer: 'Brewed.',
        }),
      ],
    });
    await user.click(composer());
    await user.keyboard('{Control>}f{/Control}');
    await field();
    await user.keyboard('oolong');
    expect(count()).toBe('1 of 1');
    expect(current()).toEqual(['turn-0:agent']);
    const shown = screen.getByTestId('agent-prompt');
    expect(shown.textContent).toContain('Use oolong.');
    expect(shown.className).not.toContain('line-clamp');
  });

  it('does not count the JSON behind Show JSON or an earlier version, and stops at the limit (spec 2, 3)', async () => {
    const user = userEvent.setup();
    setup({
      turns: [turn(0, { replacedBy: 'turn-1' }), turn(1)],
      items: [
        item('turn-0:user', 'user', { text: 'Boil the kettle first' }),
        item('turn-0:reply', 'assistant_text', { text: 'The kettle boils.' }),
        item('turn-1:user', 'user', { text: 'Boil water' }, { turnId: 'turn-1' }),
        item(
          'turn-1:mcp',
          'tool_call',
          {
            name: 'mcp__tea__boil',
            input: { vessel: { name: 'kettle' } },
            output: '',
            status: 'ok',
            kind: 'mcp',
            server: 'tea',
            tool: 'boil',
          },
          { turnId: 'turn-1' },
        ),
      ],
    });
    await user.click(composer());
    await user.keyboard('{Control>}f{/Control}');
    await field();
    // The argument is shown as JSON text on its row ({"name":"kettle"}), the earlier version not.
    await user.keyboard('kettle');
    expect(count()).toBe('1 of 2');
    await user.keyboard('{Enter}');
    expect(row('turn-1:mcp')?.querySelector('details')?.open).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Show JSON' }));
    expect(count()).toBe('2 of 2');
    await user.clear(await field());
    await user.keyboard('version');
    expect(count()).toBe('No matches');
  });

  it('reads the limit and a plus past chat.findMaxMatches (spec 3)', async () => {
    const user = userEvent.setup();
    setup({ settings: { 'chat.findMaxMatches': 3 } });
    await user.click(composer());
    await user.keyboard('{Control>}f{/Control}');
    await field();
    await user.keyboard('kettle');
    expect(count()).toBe('3+');
  });

  it('reads the conversation again only when it changed, not on every render', async () => {
    const user = userEvent.setup();
    const { push } = setup();
    await user.click(composer());
    await user.keyboard('{Control>}f{/Control}');
    await field();
    await user.keyboard('kettle');
    const walks = vi.mocked(conversationText).mock.calls.length;
    // A render for something else the view shows: the same conversation.
    push('workflowRuns', []);
    push('projects', []);
    expect(vi.mocked(conversationText).mock.calls.length).toBe(walks);
    push('threadItems', [
      ...kettleStory(),
      item('turn-0:more', 'assistant_text', { text: 'A kettle.' }),
    ]);
    expect(vi.mocked(conversationText).mock.calls.length).toBe(walks + 1);
  });

  it('follows a streaming turn and keeps the current match on its item (spec 5)', async () => {
    const user = userEvent.setup();
    const items = kettleStory();
    const { push } = setup({ items, turns: [turn(0, { state: 'running', endedAt: null })] });
    await user.click(composer());
    await user.keyboard('{Control>}f{/Control}');
    await field();
    await user.keyboard('kettle{F3}{F3}');
    expect(count()).toBe('3 of 5');
    expect(current()).toEqual(['turn-0:story-1']);
    // A match comes before it, in the user's message, and one after, at the end.
    push('threadItems', [
      { ...items[0], payload: { text: 'Tell the kettle story, kettle first' } },
      ...items.slice(1),
      item('turn-0:story-3', 'assistant_text', { text: 'The kettle ' }, { streaming: true }),
    ]);
    expect(count()).toBe('4 of 7');
    expect(current()).toEqual(['turn-0:story-1']);
  });
});

describe('commands and keys (spec 6, 9)', () => {
  it('lists Find in conversation, Find next and Find previous with their keys, and the export', () => {
    setup();
    const commands = conversationCommands(
      { ...conversationStore.getState(), reasoningOpen: false },
      false,
    );
    const shown = Object.fromEntries(
      commands
        .filter((command) => /find|markdown|save/i.test(command.id))
        .map((command) => [command.id, [command.title, command.keybinding]]),
    );
    expect(shown).toEqual({
      'chat.find': ['Find in conversation', 'keybindings.findInConversation'],
      'chat.findNext': ['Find next', 'keybindings.findNext'],
      'chat.findPrevious': ['Find previous', 'keybindings.findPrevious'],
      'chat.copyMarkdown': ['Copy conversation as Markdown', undefined],
      'chat.saveMarkdown': ['Save conversation…', undefined],
    });
    expect(keyScope('keybindings.findInConversation')).toBe('Chat');
    expect(keyScope('keybindings.findNext')).toBe('Chat');
  });

  it('offers neither find nor the export in the Assistant view (spec 9)', async () => {
    const user = userEvent.setup();
    setup({ view: 'assistant' });
    const ids = conversationCommands(
      { ...conversationStore.getState(), reasoningOpen: false },
      false,
    ).map((command) => command.id);
    expect(ids.filter((id) => /find|Markdown/.test(id))).toEqual([]);
    await user.click(composer());
    await user.keyboard('{Control>}f{/Control}');
    expect(screen.queryByTestId('find-bar')).toBeNull();
  });

  it('opens again with F3 on the last search and goes to its next match', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(composer());
    await user.keyboard('{Control>}f{/Control}');
    await field();
    await user.keyboard('kettle{Escape}');
    await user.keyboard('{F3}');
    await field();
    expect(count()).toBe('2 of 5');
  });
});

describe('copy and save as Markdown (spec 7)', () => {
  it('copies the conversation from the header menu', async () => {
    const user = userEvent.setup();
    setup({ view: 'thread' });
    await screen.findByTestId('item-tool_group');
    await user.click(screen.getByRole('button', { name: 'More thread actions' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Copy conversation as Markdown' }),
    );
    const copied = await navigator.clipboard.readText();
    expect(copied.split('\n\n').slice(0, 2)).toEqual([
      '# Tell the kettle story',
      'Claude Code · Sonnet · /work/tea · main',
    ]);
    expect(copied).toMatch(
      /\n## You · [^\n]+\n\nTell the kettle story\n\n## Claude Code · [^\n]+\n/,
    );
    expect(copied).toContain(
      '- $ cat story.txt · exit 0 · 0.4 s\n\nThen I read the notes.\n\n- Read notes/brew.md\n- Read notes/kettle.md\n',
    );
    expect(copied).not.toContain('the water warmed');
    expect(copied).not.toContain('Tell it about the kettle');
  });

  it("saves through the desktop's dialog with the title as the name", async () => {
    const user = userEvent.setup();
    const saveTextFile = vi.fn<(file: { suggestedName: string; text: string }) => Promise<string>>(
      (file: { suggestedName: string; text: string }) =>
        Promise.resolve(`/home/me/Documents/${file.suggestedName}`),
    );
    setup({
      view: 'thread',
      runtime: { saveTextFile },
      items: [item('turn-0:user', 'user', { text: 'Why: the kettle?' })],
    });
    await screen.findByTestId('item-user');
    await user.click(screen.getByRole('button', { name: 'More thread actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Save conversation…' }));
    expect(saveTextFile).toHaveBeenCalledTimes(1);
    const [file] = saveTextFile.mock.calls[0] ?? [];
    expect(file?.suggestedName).toBe('Tell the kettle story.md');
    expect(file?.text).toMatch(/\n## You · [^\n]+\n\nWhy: the kettle\?\n/);
  });

  it('downloads the file in the browser build', async () => {
    const created: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      created.push(blob as Blob);
      return 'blob:kettle';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clicked: Array<{ download: string; href: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ download: this.download, href: this.href });
    });
    setup();
    const save = conversationStore.getState().handle?.find?.saveMarkdown;
    expect(save).toBeDefined();
    await act(async () => {
      await save?.();
    });
    expect(clicked).toEqual([{ download: 'Tell the kettle story.md', href: 'blob:kettle' }]);
    expect(await created[0]?.text()).toContain('# Tell the kettle story');
  });
});
