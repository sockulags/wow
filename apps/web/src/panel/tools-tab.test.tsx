import type {
  ProviderInstance,
  SessionTools,
  Thread,
  ThreadItem,
  ThreadTools,
} from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { renderApp } from '@/test/render';
import {
  filterSessionTools,
  seenServers,
  sessionToolsCommands,
  signInText,
  toolsChipText,
  toolsSummary,
} from './tools-tab';

// What the session can use (thread work spec 37 to 44, U5), against a fake server whose
// `threadTools` topic holds what the provider reported.

const thread = (id: string, providerInstanceId: string): Thread => ({
  id,
  projectId: null,
  cwd: '/work/tea',
  branch: null,
  providerInstanceId,
  providerSessionId: null,
  title: `Thread ${id}`,
  model: 'opus',
  effort: 'high',
  permissionMode: 'default',
  state: 'idle',
  pinned: false,
  runId: null,
  stepId: null,
  createdAt: '2026-11-12T20:00:00.000Z',
  updatedAt: '2026-11-12T20:00:00.000Z',
});

const instance = (id: string, kind: 'claude' | 'codex'): ProviderInstance => ({
  id,
  kind,
  name: kind === 'claude' ? 'Claude Code' : 'Codex',
  binaryPath: kind,
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: 'opus',
  defaultEffort: null,
  defaultPermissionMode: null,
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
});

const reported: SessionTools = {
  reportedAt: '2026-11-12T20:41:00.000Z',
  complete: true,
  mcpServers: [
    {
      name: 'tea-docs',
      state: 'connected',
      stateWord: 'connected',
      error: null,
      source: 'project',
      version: '1.2.0',
      address: 'https://docs.tea.example',
      tools: [
        {
          name: 'search_docs',
          description: 'Search the tea handbook',
          readOnly: true,
          destructive: false,
        },
        { name: 'remove_page', description: 'Remove a page', readOnly: false, destructive: true },
      ],
    },
    {
      name: 'tea-tracker',
      state: 'failed',
      stateWord: 'failed',
      error: 'spawn tea-tracker ENOENT',
      source: 'user',
      version: null,
      address: 'tea-tracker',
      tools: [],
    },
    {
      name: 'tea-cloud',
      state: 'needsAuth',
      stateWord: 'needs-auth',
      error: null,
      source: 'claudeai',
      version: null,
      address: 'https://mcp.tea-cloud.example',
      tools: [],
    },
  ],
  builtInTools: ['Bash', 'Read'],
  skills: [{ name: 'brew-guide', description: 'How long each tea steeps' }],
  commands: [{ name: 'review', description: 'Review the open changes' }],
  agents: [{ name: 'Explore', description: 'Looks through the code', model: 'haiku' }],
  plugins: [
    { name: 'tea-kit', version: '0.4.1', loaded: true, errors: [] },
    {
      name: 'kettle-hooks@tea-market',
      version: null,
      loaded: false,
      errors: ['hook-load-failed: the kettle hook did not load'],
    },
  ],
  instructionFiles: [],
};

const codexReport: SessionTools = {
  ...reported,
  complete: false,
  mcpServers: [],
  builtInTools: [],
  skills: [],
  commands: [],
  agents: [],
  plugins: [],
  instructionFiles: ['/work/tea/AGENTS.md'],
};

const mcpCall: ThreadItem = {
  id: 'brew:item-1',
  threadId: 'brew',
  turnId: 'brew:turn:0',
  index: 1,
  kind: 'tool_call',
  payload: {
    name: 'tea-docs.search_docs',
    input: {},
    output: '',
    status: 'ok',
    kind: 'mcp',
    server: 'tea-docs',
    tool: 'search_docs',
  },
  streaming: false,
};

function fake(rows: Readonly<Record<string, ThreadTools>>) {
  const asked: unknown[] = [];
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      if (method === 'threads.refreshTools') {
        asked.push(params);
        return Promise.resolve({ outcome: 'unchanged' });
      }
      if (method === 'threads.diff') {
        return Promise.resolve({
          status: 'noBase',
          message: null,
          baseSha: null,
          files: [],
          omitted: 0,
          patch: null,
          turnPaths: [],
        });
      }
      if (method === 'hosts.lookup') {
        return Promise.resolve({
          rules: { sites: [], repository: null, jiraKey: null },
          item: null,
          read: null,
        });
      }
      return Promise.resolve([]);
    },
    subscribe(topic, params, onData) {
      const threadId = (params as { threadId?: string } | null)?.threadId;
      if (topic === 'threads') {
        onData([thread('tea', 'claude'), thread('brew', 'codex'), thread('old', 'claude')]);
      } else if (topic === 'providerInstances') {
        onData([instance('claude', 'claude'), instance('codex', 'codex')]);
      } else if (topic === 'threadTools') {
        const row = threadId === undefined ? undefined : rows[threadId];
        onData(row ? [row] : []);
      } else if (topic === 'threadItems') {
        onData(threadId === 'brew' ? [mcpCall] : []);
      } else onData([]);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  const runtime: Runtime = {
    connection,
    layout: createLayoutStore(),
    draft: createDraftStore(),
    settings: createSettingsStore(
      createMemorySettingsSource(undefined, {
        'appearance.contextPanel': true,
        'providers.offerSetup': false,
        'calendar.zone': 'UTC',
      }),
    ),
  };
  return { runtime, asked };
}

const panel = () => screen.getByRole('complementary', { name: 'Context panel' });
const toolsTab = () => within(panel()).getByTestId('tools-tab');
const heading = (name: RegExp) => within(toolsTab()).getByRole('heading', { name });

const live: ThreadTools = { threadId: 'tea', tools: reported, source: 'turn', live: true };

describe('the Tools tab', () => {
  it('opens from the header chip and lists servers, tools, skills, commands, subagents and plugins with counts @thread-work-37 @thread-work-38', async () => {
    const server = fake({ tea: live });
    await renderApp('/chat/tea', server.runtime);
    const user = userEvent.setup();
    const chip = await screen.findByTestId('tools-chip');
    expect(chip.textContent).toBe('1 MCP server failed, 1 needs sign-in');
    await user.click(chip);
    expect(within(panel()).getByRole('tab', { name: 'Tools', selected: true })).toBeTruthy();

    const servers = within(toolsTab()).getAllByTestId('tools-server');
    expect(servers.map((row) => within(row).getByTestId('tools-server-state').textContent)).toEqual(
      ['Connected', 'Failed', 'Needs sign-in'],
    );
    expect(within(servers[0] as HTMLElement).getByTestId('tools-server-facts').textContent).toBe(
      'project · 1.2.0 · https://docs.tea.example',
    );
    expect(within(servers[0] as HTMLElement).getByText('read-only')).toBeTruthy();
    expect(within(servers[0] as HTMLElement).getByText('destructive')).toBeTruthy();
    expect(within(servers[1] as HTMLElement).getByTestId('tools-server-error').textContent).toBe(
      'spawn tea-tracker ENOENT',
    );
    expect(within(servers[2] as HTMLElement).getByText(signInText)).toBeTruthy();
    expect(heading(/^MCP servers/).textContent).toBe('MCP servers (3)');
    expect(heading(/^Built-in tools/).textContent).toBe('Built-in tools (2)');
    expect(heading(/^Skills/).textContent).toBe('Skills (1)');
    expect(heading(/^Commands/).textContent).toBe('Commands (1)');
    expect(heading(/^Subagents/).textContent).toBe('Subagents (1)');
    expect(heading(/^Plugins/).textContent).toBe('Plugins (2)');
    expect(within(toolsTab()).getByText(/did not load/)).toBeTruthy();
    expect(within(toolsTab()).getByTestId('tools-reported').textContent).toBe(
      'Reported as the turn of 20:41 started',
    );

    // The filter narrows every section.
    await user.type(within(toolsTab()).getByLabelText('Filter session tools'), 'tracker');
    expect(within(toolsTab()).getAllByTestId('tools-server')).toHaveLength(1);
    expect(heading(/^MCP servers/).textContent).toBe('MCP servers (1)');
    expect(heading(/^Built-in tools/).textContent).toBe('Built-in tools (0)');
    expect(heading(/^Skills/).textContent).toBe('Skills (0)');
  });

  it('asks the live session again on Refresh @thread-work-39', async () => {
    const server = fake({ tea: live });
    await renderApp('/chat/tea', server.runtime);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('tools-chip'));
    await user.click(within(toolsTab()).getByRole('button', { name: 'Refresh' }));
    expect(server.asked).toEqual([{ threadId: 'tea' }]);
  });

  it('offers no Refresh without a live session and says the list is filled at the next turn @thread-work-39', async () => {
    const server = fake({ tea: { ...live, live: false } });
    await renderApp('/chat/tea', server.runtime);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('open-session-tools'));
    expect(within(toolsTab()).queryByRole('button', { name: 'Refresh' })).toBeNull();
    expect(within(toolsTab()).getByTestId('tools-reported').textContent).toContain(
      'the list is filled again at the next turn',
    );
    expect(server.asked).toEqual([]);
  });

  it('shows an old thread an empty tab until its next turn, opened from Details @thread-work-43 @thread-work-44', async () => {
    const server = fake({});
    await renderApp('/chat/old', server.runtime);
    const user = userEvent.setup();
    expect(screen.queryByTestId('tools-chip')).toBeNull();
    expect((await screen.findByTestId('tools-summary')).textContent).toBe(
      'Reported when the next turn starts.',
    );
    await user.click(screen.getByTestId('open-session-tools'));
    expect(within(toolsTab()).getByText('No list yet')).toBeTruthy();
    expect(within(toolsTab()).getByTestId('tools-reported').textContent).toBe(
      'Nothing reported yet. The list is filled at the next turn.',
    );
  });

  it("shows Codex's instruction files and the servers its tool calls used @thread-work-42", async () => {
    const server = fake({
      brew: { threadId: 'brew', tools: codexReport, source: 'turn', live: true },
    });
    await renderApp('/chat/brew', server.runtime);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('open-session-tools'));
    expect(within(toolsTab()).getByTestId('tools-codex').textContent).toMatch(
      /^Codex reports no list of its servers, tools or skills to wow/,
    );
    const [seen] = within(toolsTab()).getAllByTestId('tools-server');
    expect(within(seen as HTMLElement).getByText("Seen in this thread's tool calls")).toBeTruthy();
    expect(within(seen as HTMLElement).getByText('search_docs')).toBeTruthy();
    expect(within(toolsTab()).getByText('/work/tea/AGENTS.md')).toBeTruthy();
    expect(within(toolsTab()).queryByRole('heading', { name: /^Skills/ })).toBeNull();
  });
});

describe('session tools helpers', () => {
  it('words the header chip only while a server failed or needs sign-in', () => {
    expect(toolsChipText(reported)).toBe('1 MCP server failed, 1 needs sign-in');
    expect(toolsChipText({ ...reported, mcpServers: reported.mcpServers.slice(0, 2) })).toBe(
      '1 MCP server failed',
    );
    expect(toolsChipText({ ...reported, mcpServers: reported.mcpServers.slice(0, 1) })).toBe(
      undefined,
    );
    expect(toolsChipText(undefined)).toBeUndefined();
  });

  it('narrows a server to its matching tools and keeps a server whose name matches whole', () => {
    expect(filterSessionTools(reported, 'search').mcpServers).toEqual([
      { ...reported.mcpServers[0], tools: [reported.mcpServers[0]?.tools[0]] },
    ]);
    expect(filterSessionTools(reported, 'TEA-DOCS').mcpServers[0]?.tools).toHaveLength(2);
    expect(filterSessionTools(reported, 'steeps').skills).toHaveLength(1);
    expect(filterSessionTools(reported, '').mcpServers).toHaveLength(3);
  });

  it('reads the servers and tools of MCP tool rows once each', () => {
    expect(seenServers([mcpCall, { ...mcpCall, id: 'brew:item-2' }])).toMatchObject([
      { name: 'tea-docs', tools: [{ name: 'search_docs' }] },
    ]);
  });

  it('sums up the list for Details', () => {
    expect(toolsSummary(reported)).toBe('3 MCP servers, 4 tools, 1 skill');
    expect(toolsSummary(undefined)).toBeUndefined();
  });

  it('offers Show session tools for a thread, and Refresh only with a live session; nothing for the assistant @thread-work-43', () => {
    expect(sessionToolsCommands('tea', '/chat/tea', false, true).map((c) => c.id)).toEqual([
      'chat.sessionTools',
      'chat.refreshTools',
    ]);
    expect(sessionToolsCommands('tea', '/chat/tea', true, false).map((c) => c.title)).toEqual([
      'Hide session tools',
    ]);
    // The assistant is never the open chat thread, so it gets none.
    expect(sessionToolsCommands(undefined, '/assistant', false, true)).toEqual([]);
  });
});
