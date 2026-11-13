import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import {
  ProviderEvent as ProviderEventSchema,
  type ProviderAdapterContext,
  type ProviderCommand,
  type ProviderEvent,
  type ProviderInstance,
  type SessionTools,
} from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from './index.js';
import type { SDKMessage } from './sdk.js';
import { cleanReportedText, mcpAddress } from './session-tools.js';
import { fakeQueryFunction, type FakeLive, type FakeStep } from './testing/fake-query.js';

// What the session can use (thread work spec 38, 40, 41, U5): the init message, completed from
// the live query, with nothing of a server's configuration but its address.

const instance: ProviderInstance = {
  id: 'claude-work',
  kind: 'claude',
  name: 'Work',
  binaryPath: '/opt/claude/bin/claude',
  configDir: '/home/me/.claude-work',
  env: {},
  launchArgs: [],
  defaultModel: 'sonnet',
  defaultEffort: 'high',
  defaultPermissionMode: 'default',
  status: 'unknown',
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
  account: null,
};

const context: ProviderAdapterContext = {
  resolveEnv: () => Promise.resolve({}),
  testTimeoutMs: () => 60_000,
  requestTimeoutMs: () => 60_000,
};

const startTurn = (overrides: Partial<Extract<ProviderCommand, { type: 'startTurn' }>> = {}) =>
  ({
    type: 'startTurn',
    threadId: 't1',
    cwd: '/work/tea',
    prompt: 'Brew the tea',
    model: 'sonnet',
    effort: 'high',
    permissionMode: 'default',
    ...overrides,
  }) satisfies ProviderCommand;

// Invented: an init message naming three servers, two plugins and a plugin that did not load.
const init: FakeStep = {
  message: {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'none',
    claude_code_version: '2.1.316',
    cwd: '/work/tea',
    tools: ['Bash', 'Read', 'mcp__tea-docs__search_docs', 'mcp__tea-docs__remove_page'],
    mcp_servers: [
      { name: 'tea-docs', status: 'connected', source: 'project' },
      { name: 'tea-tracker', status: 'failed', source: 'user' },
      { name: 'tea-cloud', status: 'needs-auth', source: 'claudeai' },
    ],
    model: 'claude-sonnet-4-5',
    permissionMode: 'default',
    slash_commands: ['compact', 'brew-guide'],
    output_style: 'default',
    skills: ['brew-guide'],
    agents: ['Explore'],
    plugins: [{ name: 'tea-kit', path: '/home/me/.claude/plugins/tea-kit', version: '0.4.1' }],
    plugin_errors: [
      {
        plugin: 'kettle-hooks@tea-market',
        type: 'hook-load-failed',
        message: 'The kettle hook did not load',
      },
    ],
    uuid: '00000000-0000-4000-8000-000000000001',
    session_id: 'sess-1',
  } as unknown as SDKMessage,
};

const done: FakeStep = {
  message: {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: 'ok',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-4000-8000-0000000000aa',
    session_id: 'sess-1',
  } as unknown as SDKMessage,
};

const commandsChanged: FakeStep = {
  message: {
    type: 'system',
    subtype: 'commands_changed',
    commands: [{ name: 'steep', description: 'Steep a pot (invented)', argumentHint: '<tea>' }],
    uuid: '00000000-0000-4000-8000-0000000000c2',
    session_id: 'sess-1',
  } as unknown as SDKMessage,
};

// Secret-bearing configuration: none of these values may come through (spec 41).
const secrets = [
  'sk-tea-secret',
  'Bearer tea-token',
  '--token=hunter2',
  '/v1/private/path',
  'key=abc123',
  'TEA_TOKEN',
];

const status: McpServerStatus[] = [
  {
    name: 'tea-docs',
    status: 'connected',
    serverInfo: { name: 'tea-docs', version: '1.2.0' },
    config: {
      type: 'http',
      url: 'https://user:pass@docs.tea.example:8443/v1/private/path?key=abc123',
      headers: { Authorization: 'Bearer tea-token' },
    },
    scope: 'project',
    source: 'project',
    tools: [
      {
        name: 'search_docs',
        description: 'Search the tea handbook',
        annotations: { readOnly: true },
      },
      { name: 'remove_page', description: 'Remove a page', annotations: { destructive: true } },
    ],
  },
  {
    name: 'tea-tracker',
    status: 'failed',
    error: 'spawn tea-tracker ENOENT',
    config: {
      type: 'stdio',
      command: '/usr/local/bin/tea-tracker',
      args: ['--token=hunter2'],
      env: { TEA_TOKEN: 'sk-tea-secret' },
    },
    source: 'user',
  },
  {
    name: 'tea-cloud',
    status: 'needs-auth',
    config: { type: 'claudeai-proxy', url: 'https://mcp.tea-cloud.example/sse', id: 'srv-1' },
    source: 'claudeai',
  },
];

const live: FakeLive = {
  mcpStatus: status,
  agents: [{ name: 'Explore', description: 'Looks through the code', model: 'haiku' }],
};

function harness(turns: FakeStep[][], answers: FakeLive = live, within = context) {
  const query = fakeQueryFunction(turns, answers);
  const adapter = new ClaudeAdapter(instance, within, { query, baseEnv: { PATH: '/usr/bin' } });
  const events: ProviderEvent[] = [];
  const waiting: Array<() => void> = [];
  adapter.onEvent((event) => {
    events.push(ProviderEventSchema.parse(event));
    if (event.type === 'sessionTools') for (const resolve of waiting.splice(0)) resolve();
  });
  const reported = () => new Promise<void>((resolve) => waiting.push(resolve));
  const tools = (): SessionTools[] =>
    events.flatMap((event) => (event.type === 'sessionTools' && event.tools ? [event.tools] : []));
  return { adapter, events, queries: query.opened, reported, tools };
}

describe('session tools from Claude Code', () => {
  it('reports the servers with states, error, source, version and tools, and the other lists', async () => {
    const h = harness([[init, done]]);
    const reported = h.reported();
    await h.adapter.send(startTurn());
    await reported;
    const [tools] = h.tools();
    expect(tools?.complete).toBe(true);
    expect(tools?.mcpServers).toEqual([
      {
        name: 'tea-docs',
        state: 'connected',
        stateWord: 'connected',
        error: null,
        source: 'project',
        version: '1.2.0',
        address: 'https://docs.tea.example:8443',
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
    ]);
    expect(tools?.builtInTools).toEqual(['Bash', 'Read']);
    expect(tools?.skills).toEqual([{ name: 'brew-guide', description: null }]);
    expect(tools?.commands.map((command) => command.name)).toEqual(['compact', 'release-notes']);
    expect(tools?.agents).toEqual([
      { name: 'Explore', description: 'Looks through the code', model: 'haiku' },
    ]);
    expect(tools?.plugins).toEqual([
      { name: 'tea-kit', version: '0.4.1', loaded: true, errors: [] },
      {
        name: 'kettle-hooks@tea-market',
        version: null,
        loaded: false,
        errors: ['hook-load-failed: The kettle hook did not load'],
      },
    ]);
  });

  it('lets no environment value, header, argument, URL path or query through', async () => {
    const h = harness([[init, done]]);
    const reported = h.reported();
    await h.adapter.send(startTurn());
    await reported;
    const sent = JSON.stringify(h.events);
    for (const secret of secrets) expect(sent).not.toContain(secret);
    expect(sent).not.toContain('user:pass');
    expect(sent).not.toContain('/usr/local/bin');
  });

  it('keeps a command line and a configured URL out of a failure and the address', async () => {
    const leaky: McpServerStatus[] = [
      {
        name: 'tea-tracker',
        status: 'failed',
        error: 'spawn npx -y @tea/server --api-key=sk-tea-123 ENOENT',
        config: { type: 'stdio', command: 'npx -y @tea/server --api-key=sk-tea-123' },
      },
      {
        name: 'tea-docs',
        status: 'failed',
        error:
          'Failed to connect to https://mcp.tea.example/v1/sse?key=sk-tea-123: 401 (Authorization: Bearer sk-tea-456)',
        config: { type: 'sse', url: 'https://mcp.tea.example/v1/sse?key=sk-tea-123' },
      },
      {
        name: 'tea-cloud',
        status: 'failed',
        error:
          'Redirected to https://u:pw@login.tea.example/a/b?c=d; header tea-header-777 refused',
        config: {
          type: 'http',
          url: 'https://cloud.tea.example/mcp',
          headers: { 'X-Tea-Key': 'tea-header-777' },
        },
      },
    ];
    const h = harness([[init, done]], { mcpStatus: leaky });
    const reported = h.reported();
    await h.adapter.send(startTurn());
    await reported;
    const [tools] = h.tools();
    expect(tools?.mcpServers.map((server) => [server.address, server.error])).toEqual([
      ['npx', 'spawn npx ENOENT'],
      [
        'https://mcp.tea.example',
        'Failed to connect to https://mcp.tea.example: 401 (Authorization: Bearer [hidden])',
      ],
      [
        'https://cloud.tea.example',
        'Redirected to https://login.tea.example; header [hidden] refused',
      ],
    ]);
    const sent = JSON.stringify(h.events);
    for (const secret of [
      'sk-tea-123',
      'sk-tea-456',
      '/v1/sse',
      'key=',
      'u:pw',
      'tea-header-777',
    ]) {
      expect(sent).not.toContain(secret);
    }
  });

  it('reports the init message alone when a live call does not answer in time', async () => {
    const h = harness(
      [[init, done]],
      { mcpStatus: new Promise(() => undefined) },
      {
        ...context,
        requestTimeoutMs: () => 1,
      },
    );
    const reported = h.reported();
    await h.adapter.send(startTurn());
    await reported;
    expect(h.tools()[0]?.complete).toBe(false);
    await expect(h.adapter.send({ type: 'describeSession', threadId: 't1' })).rejects.toThrow(
      'Claude Code did not say what the session can use',
    );
  });

  it('fails a refresh whose live calls fail instead of answering the poorer init list', async () => {
    const h = harness([[init, done]], { mcpStatus: new Error('Claude Code did not answer') });
    const reported = h.reported();
    await h.adapter.send(startTurn());
    await reported;
    await expect(h.adapter.send({ type: 'describeSession', threadId: 't1' })).rejects.toThrow(
      'Claude Code did not say what the session can use',
    );
  });

  it('answers null to a refresh before the session said anything', async () => {
    const gate: { release?: () => void } = {};
    const hold = new Promise<void>((resolve) => (gate.release = resolve));
    const h = harness([[{ hold }, init, done]]);
    const reported = h.reported();
    await h.adapter.send(startTurn());
    await expect(h.adapter.send({ type: 'describeSession', threadId: 't1' })).resolves.toBeNull();
    gate.release?.();
    await reported;
    expect(h.tools()).toHaveLength(1);
  });

  it('keeps commands that changed while the first list was being asked for', async () => {
    const answer: { give?: (status: McpServerStatus[]) => void } = {};
    const mcpStatus = new Promise<McpServerStatus[]>((resolve) => (answer.give = resolve));
    const h = harness([[init, commandsChanged, done]], { ...live, mcpStatus });
    const ended = new Promise<void>((resolve) =>
      h.adapter.onEvent((event) => event.type === 'turnCompleted' && resolve()),
    );
    const reported = h.reported();
    await h.adapter.send(startTurn());
    await ended;
    answer.give?.(status);
    await reported;
    expect(h.tools()).toHaveLength(1);
    expect(h.tools()[0]?.commands.map((command) => command.name)).toEqual(['steep']);
    expect(h.tools()[0]?.complete).toBe(true);
  });

  it('reports the init message alone, not complete, when a live call fails', async () => {
    const h = harness([[init, done]], { mcpStatus: new Error('Claude Code did not answer') });
    const reported = h.reported();
    await h.adapter.send(startTurn());
    await reported;
    const [tools] = h.tools();
    expect(tools?.complete).toBe(false);
    expect(
      tools?.mcpServers.map((server) => [server.name, server.state, server.tools.length]),
    ).toEqual([
      ['tea-docs', 'connected', 2],
      ['tea-tracker', 'failed', 0],
      ['tea-cloud', 'needsAuth', 0],
    ]);
    expect(tools?.commands.map((command) => command.name)).toEqual(['compact', 'brew-guide']);
    expect(tools?.agents).toEqual([{ name: 'Explore', description: '', model: null }]);
  });

  it('replaces the commands when Claude Code says they changed', async () => {
    const gate: { release?: () => void } = {};
    const hold = new Promise<void>((resolve) => (gate.release = resolve));
    const h = harness([[init, { hold }, commandsChanged, done]]);
    const first = h.reported();
    await h.adapter.send(startTurn());
    await first;
    const second = h.reported();
    gate.release?.();
    await second;
    expect(h.tools().at(-1)?.commands).toEqual([
      { name: 'steep', description: 'Steep a pot (invented)', argumentHint: '<tea>' },
    ]);
  });

  it('describes a live session again, and answers null without one, starting nothing', async () => {
    const h = harness([[init, done]]);
    await expect(h.adapter.send({ type: 'describeSession', threadId: 't1' })).resolves.toBeNull();
    expect(h.queries).toEqual([]);
    const reported = h.reported();
    await h.adapter.send(startTurn());
    await reported;
    const asked = (await h.adapter.send({
      type: 'describeSession',
      threadId: 't1',
    })) as SessionTools;
    expect(asked.mcpServers).toHaveLength(3);
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]?.calls.filter((call) => call === 'mcpServerStatus')).toHaveLength(2);
  });

  it('completes the turn when the init message lacks lists the SDK types name (Claude Code of another version)', async () => {
    const { skills, plugins, slash_commands, ...rest } = init.message as unknown as Record<
      string,
      unknown
    >;
    expect([skills, plugins, slash_commands].every(Array.isArray)).toBe(true);
    const sparse: FakeStep = {
      message: {
        ...rest,
        tools: ['Bash', 42, 'mcp__tea-docs__search_docs'],
        mcp_servers: [{ name: 'tea-docs', status: 'connected' }, { status: 'failed' }, null],
        agents: 'Explore',
      } as unknown as SDKMessage,
    };
    const h = harness([[sparse, done]], { mcpStatus: new Error('Claude Code did not answer') });
    const ended = new Promise<void>((resolve) =>
      h.adapter.onEvent((event) => event.type === 'turnCompleted' && resolve()),
    );
    const reported = h.reported();
    await h.adapter.send(startTurn());
    await ended;
    await reported;
    expect(h.events.some((event) => event.type === 'turnFailed')).toBe(false);
    const [tools] = h.tools();
    expect(tools).toMatchObject({
      complete: false,
      builtInTools: ['Bash'],
      skills: [],
      commands: [],
      agents: [],
    });
    // plugin_errors is still there: the plugin that did not load is listed with its error.
    expect(tools?.plugins.map((plugin) => [plugin.name, plugin.loaded])).toEqual([
      ['kettle-hooks@tea-market', false],
    ]);
    expect(tools?.mcpServers.map((server) => [server.name, server.tools.length])).toEqual([
      ['tea-docs', 1],
    ]);
  });

  it('falls back to the init list when a live answer is malformed, and nothing is left unhandled', async () => {
    const malformed = [
      {
        name: 'tea-docs',
        status: 'connected',
        tools: [{ description: 'A tool without a name' }, { name: 'search_docs' }],
      },
      { status: 'connected' },
    ] as unknown as McpServerStatus[];
    const h = harness([[init, done]], { mcpStatus: malformed });
    const reported = h.reported();
    await h.adapter.send(startTurn());
    await reported;
    const [tools] = h.tools();
    expect(
      tools?.mcpServers.map((server) => [server.name, server.tools.map((t) => t.name)]),
    ).toEqual([['tea-docs', ['search_docs']]]);
  });

  it('says the list is no longer live when Claude Code exits by itself between turns', async () => {
    const gate: { release?: () => void } = {};
    const hold = new Promise<void>((resolve) => (gate.release = resolve));
    const h = harness([
      [init, done, { hold }, { crash: 'Claude Code process exited with code 1' }],
    ]);
    const reported = h.reported();
    await h.adapter.send(startTurn());
    await reported;
    const gone = h.reported();
    gate.release?.();
    await gone;
    expect(h.events.some((event) => event.type === 'turnFailed')).toBe(false);
    expect(h.events.filter((event) => event.type === 'sessionTools').at(-1)).toEqual({
      type: 'sessionTools',
      threadId: 't1',
      tools: null,
    });
    await expect(h.adapter.send({ type: 'describeSession', threadId: 't1' })).resolves.toBeNull();
  });

  it('reports nothing for an assistant session', async () => {
    const h = harness([[init, done]]);
    const ended = new Promise<void>((resolve) =>
      h.adapter.onEvent((event) => event.type === 'turnCompleted' && resolve()),
    );
    await h.adapter.send(
      startTurn({
        toolset: { name: 'wow', url: 'http://127.0.0.1:4317/assistant/mcp', token: 'invented' },
        instructions: 'You operate wow only.',
      }),
    );
    await ended;
    expect(h.tools()).toEqual([]);
    await expect(h.adapter.send({ type: 'describeSession', threadId: 't1' })).resolves.toBeNull();
  });
});

describe('mcpAddress', () => {
  it('keeps the origin of a remote server and the file name of a local one', () => {
    expect(mcpAddress({ type: 'sse', url: 'http://127.0.0.1:7000/sse?token=x' })).toBe(
      'http://127.0.0.1:7000',
    );
    expect(mcpAddress({ command: 'C:\\Tools\\tea\\tea-tracker.exe', args: ['--x'] })).toBe(
      'tea-tracker.exe',
    );
    expect(mcpAddress({ command: 'npx -y @tea/server --api-key=sk-tea-123' })).toBe('npx');
    expect(mcpAddress({ type: 'sdk', name: 'in-process' })).toBeNull();
    expect(mcpAddress({ url: 'file:///etc/passwd' })).toBeNull();
    expect(mcpAddress(undefined)).toBeNull();
  });

  it('takes a Windows or POSIX path with a space as one program', () => {
    expect(mcpAddress({ command: 'C:\\Program Files\\nodejs\\node.exe' })).toBe('node.exe');
    expect(mcpAddress({ command: 'C:\\Users\\Jane Doe\\tools\\tea.exe' })).toBe('tea.exe');
    expect(
      mcpAddress({ command: '"C:\\Program Files\\Tea\\tea.exe" --token=sk-tea-777 --verbose' }),
    ).toBe('tea.exe');
    expect(mcpAddress({ command: 'C:\\Program Files\\Tea\\tea.exe --verbose' })).toBe('tea.exe');
    expect(mcpAddress({ command: '/opt/tea tools/bin/tea-server' })).toBe('tea-server');
    expect(mcpAddress({ command: 'npx -y @tea/server' })).toBe('npx');
    expect(mcpAddress({ command: 'node C:\\Tools\\tea.exe --x' })).toBe('node');
    expect(mcpAddress({ command: "'/opt/tea tools/bin/tea-server' --port 7" })).toBe('tea-server');
  });
});

describe('cleanReportedText', () => {
  it('reads a program path with a space as its file name in a failure', () => {
    const command = 'C:\\Users\\Jane Doe\\tools\\tea.exe';
    expect(cleanReportedText(`spawn ${command} ENOENT`, { command })).toBe('spawn tea.exe ENOENT');
    const quoted = '"C:\\Program Files\\Tea\\tea.exe" --token=sk-tea-777';
    expect(
      cleanReportedText('spawn C:\\Program Files\\Tea\\tea.exe ENOENT', { command: quoted }),
    ).toBe('spawn tea.exe ENOENT');
  });

  it('hides each argument of a whole command line written into command', () => {
    const command = 'npx -y @tea/server --api-key=hunter2-long-value';
    expect(
      cleanReportedText('error: unknown option --api-key=hunter2-long-value', { command }),
    ).toBe('error: unknown option [hidden]');
  });

  it('hides the configured URL also without its scheme, its path and its query values', () => {
    const url = 'https://mcp.tea.example/v1/sse?key=sk-tea-9&team=kettle-room';
    const cleaned = [
      'connect ECONNREFUSED mcp.tea.example/v1/sse?key=sk-tea-9&team=kettle-room',
      'GET /v1/sse failed',
      'key sk-tea-9 refused for kettle-room',
    ].map((text) => cleanReportedText(text, { type: 'sse', url }));
    expect(cleaned).toEqual([
      'connect ECONNREFUSED mcp.tea.example',
      'GET [hidden] failed',
      'key [hidden] refused for [hidden]',
    ]);
  });
});
