import type {
  ProviderAdapterContext,
  ProviderCommand,
  ProviderEvent,
  ProviderInstance,
} from '@wow/contracts';
import { ProviderEvent as ProviderEventSchema } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter, extraArgs, providerKind } from './index.js';
import type { SDKMessage } from './sdk.js';
import {
  fakeQueryFunction,
  loadFixture,
  type FakeQuery,
  type FakeStep,
} from './testing/fake-query.js';

const instance: ProviderInstance = {
  id: 'claude-work',
  kind: 'claude',
  name: 'Work',
  binaryPath: '/opt/claude/bin/claude',
  configDir: '/home/me/.claude-work',
  env: { ANTHROPIC_API_KEY: { secretRef: 'work-key' } },
  launchArgs: ['--add-dir', '../shared', '--verbose'],
  defaultModel: 'sonnet',
  defaultEffort: 'high',
  defaultPermissionMode: 'default',
  status: 'unknown',
  version: null,
  statusMessage: null,
  account: null,
};

const context: ProviderAdapterContext = {
  resolveEnv: () => Promise.resolve({ ANTHROPIC_API_KEY: 'resolved-secret' }),
  testTimeoutMs: () => 60_000,
  requestTimeoutMs: () => 60_000,
};

const startTurn = (overrides: Partial<Extract<ProviderCommand, { type: 'startTurn' }>> = {}) =>
  ({
    type: 'startTurn',
    threadId: 't1',
    cwd: '/work/demo',
    prompt: 'What is in the readme?',
    model: 'sonnet',
    effort: 'high',
    permissionMode: 'default',
    ...overrides,
  }) satisfies ProviderCommand;

const result = (cost: number): FakeStep => ({
  message: {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: 'ok',
    stop_reason: 'end_turn',
    total_cost_usd: cost,
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 3,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-4000-8000-0000000000aa',
    session_id: 'sess-1',
  } as unknown as SDKMessage,
});

const assistantToolUse = (id: string, name: string, input: unknown): FakeStep => ({
  message: {
    type: 'assistant',
    message: {
      id: `msg_${id}`,
      type: 'message',
      role: 'assistant',
      model: 'sonnet',
      content: [{ type: 'tool_use', id, name, input }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-0000000000bb',
    session_id: 'sess-1',
  } as unknown as SDKMessage,
});

const toolResult = (id: string, toolUseResult: unknown): FakeStep => ({
  message: {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    parent_tool_use_id: null,
    tool_use_result: toolUseResult,
    session_id: 'sess-1',
  } as unknown as SDKMessage,
});

interface Harness {
  readonly adapter: ClaudeAdapter;
  readonly events: ProviderEvent[];
  readonly queries: FakeQuery[];
  next(type: ProviderEvent['type']): Promise<ProviderEvent>;
}

function harness(turns: FakeStep[][], onEvent?: (event: ProviderEvent) => void): Harness {
  const query = fakeQueryFunction(turns);
  const adapter = new ClaudeAdapter(instance, context, {
    query,
    baseEnv: { PATH: '/usr/bin' },
  });
  const events: ProviderEvent[] = [];
  const waiting: Array<{ type: ProviderEvent['type']; resolve: (event: ProviderEvent) => void }> =
    [];
  adapter.onEvent((event) => {
    // Every event the adapter emits must pass the contract schema.
    events.push(ProviderEventSchema.parse(event));
    onEvent?.(event);
    for (const entry of waiting.filter((candidate) => candidate.type === event.type)) {
      waiting.splice(waiting.indexOf(entry), 1);
      entry.resolve(event);
    }
  });
  return {
    adapter,
    events,
    queries: query.opened,
    next: (type) => new Promise((resolve) => waiting.push({ type, resolve })),
  };
}

describe('@wow/provider-claude', () => {
  it('is the claude provider', () => {
    expect(providerKind).toBe('claude');
  });

  it('streams a recorded turn: text, reasoning, tool call, approval, question, tasks, usage', async () => {
    const h = harness([loadFixture('turn.json')], (event) => {
      if (event.type === 'approvalRequested') {
        void h.adapter.send({
          type: 'answerApproval',
          approvalId: event.approvalId,
          decision: 'allowSession',
        });
      }
      if (event.type === 'questionAsked') {
        void h.adapter.send({
          type: 'answerQuestion',
          questionId: event.questionId,
          answer: 'README.md',
        });
      }
    });
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await done;

    expect(h.events).toEqual([
      { type: 'session', threadId: 't1', providerSessionId: 'sess-1' },
      { type: 'reasoningDelta', threadId: 't1', itemId: 'msg_1:0', delta: 'List the files first.' },
      { type: 'textDelta', threadId: 't1', itemId: 'msg_1:1', delta: 'Let me ' },
      { type: 'textDelta', threadId: 't1', itemId: 'msg_1:1', delta: 'look.' },
      {
        type: 'toolCallStarted',
        threadId: 't1',
        itemId: 'toolu_bash',
        name: 'Bash',
        input: { command: 'ls' },
      },
      {
        type: 'approvalRequested',
        threadId: 't1',
        approvalId: 'toolu_bash',
        kind: 'command',
        summary: 'Claude wants to run ls',
        request: { toolName: 'Bash', input: { command: 'ls' } },
      },
      { type: 'toolCallOutput', threadId: 't1', itemId: 'toolu_bash', output: 'README.md\nsrc' },
      { type: 'toolCallCompleted', threadId: 't1', itemId: 'toolu_bash', status: 'ok' },
      expect.objectContaining({ type: 'toolCallStarted', itemId: 'toolu_ask' }),
      {
        type: 'questionAsked',
        threadId: 't1',
        questionId: 'toolu_ask:0',
        question: 'Which file should I open?',
        options: [
          { label: 'README.md', description: 'The readme' },
          { label: 'src', description: 'The sources' },
        ],
        multiSelect: false,
      },
      {
        type: 'toolCallOutput',
        threadId: 't1',
        itemId: 'toolu_ask',
        output: 'User answered: README.md',
      },
      { type: 'toolCallCompleted', threadId: 't1', itemId: 'toolu_ask', status: 'ok' },
      expect.objectContaining({ type: 'toolCallStarted', itemId: 'toolu_todo', name: 'TodoWrite' }),
      {
        type: 'taskListUpdated',
        threadId: 't1',
        tasks: [
          { id: '1', content: 'Read README.md', status: 'in_progress' },
          { id: '2', content: 'Summarize it', status: 'pending' },
        ],
      },
      expect.objectContaining({ type: 'toolCallOutput', itemId: 'toolu_todo' }),
      expect.objectContaining({ type: 'toolCallCompleted', itemId: 'toolu_todo' }),
      {
        type: 'textDelta',
        threadId: 't1',
        itemId: 'msg_4:full:0',
        delta: 'The readme says hello.',
      },
      {
        type: 'usage',
        threadId: 't1',
        inputTokens: 125,
        outputTokens: 35,
        cachedInputTokens: 400,
        costUsd: 0.0123,
      },
      { type: 'contextUsage', threadId: 't1', usedTokens: 1500, maxTokens: 200_000 },
      { type: 'turnCompleted', threadId: 't1' },
    ]);

    const [query] = h.queries;
    expect(query?.prompts).toEqual(['What is in the readme?']);
    expect(query?.permissionResults).toEqual([
      {
        behavior: 'allow',
        updatedInput: { command: 'ls' },
        updatedPermissions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'ls' }],
            behavior: 'allow',
            destination: 'session',
          },
        ],
      },
      {
        behavior: 'allow',
        updatedInput: expect.objectContaining({
          answers: { 'Which file should I open?': 'README.md' },
        }),
      },
    ]);
  });

  it('starts Claude Code with the instance binary, config directory, env and launch args', async () => {
    const h = harness([[result(0.01)]]);
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn({ resumeId: 'sess-0', permissionMode: 'acceptEdits' }));
    await done;
    const options = h.queries[0]?.options;
    expect(options).toMatchObject({
      cwd: '/work/demo',
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'acceptEdits',
      resume: 'sess-0',
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      pathToClaudeCodeExecutable: '/opt/claude/bin/claude',
      extraArgs: { 'add-dir': '../shared', verbose: null },
      env: {
        PATH: '/usr/bin',
        CLAUDE_CONFIG_DIR: '/home/me/.claude-work',
        ANTHROPIC_API_KEY: 'resolved-secret',
      },
    });
    expect(options?.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it('keeps one session across turns and applies model, effort and permission changes', async () => {
    const h = harness([[result(0.01)], [result(0.03)]]);
    let done = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await done;
    done = h.next('turnCompleted');
    await h.adapter.send(
      startTurn({ prompt: 'And then?', model: 'opus', effort: 'low', permissionMode: 'plan' }),
    );
    await done;
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]?.prompts).toEqual(['What is in the readme?', 'And then?']);
    expect(h.queries[0]?.calls).toEqual(['setModel:opus', 'setPermissionMode:plan', 'effort:low']);
    // total_cost_usd is cumulative per session; each turn reports its own share.
    const costs = h.events.flatMap((event) => (event.type === 'usage' ? [event.costUsd] : []));
    expect(costs[0]).toBeCloseTo(0.01);
    expect(costs[1]).toBeCloseTo(0.02);
  });

  it('changes model and permission mode of a live session on request', async () => {
    const h = harness([[result(0)]]);
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await done;
    await h.adapter.send({ type: 'setModel', threadId: 't1', model: 'haiku' });
    await h.adapter.send({ type: 'setPermissionMode', threadId: 't1', permissionMode: 'plan' });
    expect(h.queries[0]?.calls).toEqual(['setModel:haiku', 'setPermissionMode:plan']);
    await expect(
      h.adapter.send({ type: 'setPermissionMode', threadId: 't1', permissionMode: 'yolo' }),
    ).rejects.toThrow(/Unknown Claude permission mode/);
  });

  it('interrupts a turn that waits for an approval and reports it interrupted', async () => {
    const steps = loadFixture('turn.json').slice(0, 7);
    const h = harness([steps]);
    const asked = h.next('approvalRequested');
    const interrupted = h.next('turnInterrupted');
    await h.adapter.send(startTurn());
    await asked;
    await h.adapter.send({ type: 'interrupt', threadId: 't1' });
    await interrupted;
    expect(h.queries[0]?.calls).toEqual(['interrupt']);
    expect(h.queries[0]?.permissionResults).toEqual([
      { behavior: 'deny', message: 'The turn was interrupted.', interrupt: true },
    ]);
    expect(h.events.map((event) => event.type)).not.toContain('turnCompleted');
    await expect(
      h.adapter.send({ type: 'answerApproval', approvalId: 'toolu_bash', decision: 'allowOnce' }),
    ).rejects.toThrow(/not waiting/);
  });

  it('reports an interrupt for a thread without a running turn', async () => {
    const h = harness([]);
    const interrupted = h.next('turnInterrupted');
    await h.adapter.send({ type: 'interrupt', threadId: 'gone' });
    expect(await interrupted).toEqual({ type: 'turnInterrupted', threadId: 'gone' });
  });

  it('denies a tool call the user denies', async () => {
    const steps = [...loadFixture('turn.json').slice(0, 8), result(0)];
    const h = harness([steps], (event) => {
      if (event.type === 'approvalRequested') {
        void h.adapter.send({
          type: 'answerApproval',
          approvalId: event.approvalId,
          decision: 'deny',
        });
      }
    });
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await done;
    expect(h.queries[0]?.permissionResults).toEqual([
      { behavior: 'deny', message: 'The user denied this request.' },
    ]);
  });

  it('follows TaskCreate and TaskUpdate as one task list', async () => {
    const h = harness([
      [
        assistantToolUse('toolu_c1', 'TaskCreate', { subject: 'Write tests', description: 'd' }),
        toolResult('toolu_c1', { task: { id: '7', subject: 'Write tests' } }),
        assistantToolUse('toolu_u1', 'TaskUpdate', { taskId: '7', status: 'completed' }),
        toolResult('toolu_u1', { success: true, taskId: '7', updatedFields: ['status'] }),
        result(0),
      ],
    ]);
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await done;
    const lists = h.events.flatMap((event) =>
      event.type === 'taskListUpdated' ? [event.tasks] : [],
    );
    expect(lists).toEqual([
      [{ id: '7', content: 'Write tests', status: 'pending' }],
      [{ id: '7', content: 'Write tests', status: 'completed' }],
    ]);
  });

  it('fails the turn when Claude Code exits mid-turn', async () => {
    const h = harness([
      [
        loadFixture('turn.json')[0] as FakeStep,
        { crash: 'Claude Code process exited with code 1' },
      ],
    ]);
    const failed = h.next('turnFailed');
    await h.adapter.send(startTurn());
    expect(await failed).toEqual({
      type: 'turnFailed',
      threadId: 't1',
      error: 'Claude Code process exited with code 1',
    });
    // The session is gone; the next turn opens a new query that resumes the same session.
    const again = h.next('turnFailed');
    await h.adapter.send(startTurn({ resumeId: 'sess-1' }));
    await again;
    expect(h.queries).toHaveLength(2);
    expect(h.queries[1]?.options.resume).toBe('sess-1');
  });

  it('rejects an effort Claude does not know', async () => {
    const h = harness([]);
    await expect(h.adapter.send(startTurn({ effort: 'extreme' }))).rejects.toThrow(
      /Unknown Claude effort/,
    );
    expect(h.queries).toHaveLength(0);
  });

  it('lists models through supportedModels() and closes the probe', async () => {
    const h = harness([]);
    expect(await h.adapter.send({ type: 'listModels' })).toEqual([
      {
        id: 'sonnet',
        label: 'Sonnet',
        description: 'Fast and capable',
        efforts: ['low', 'medium', 'high'],
      },
      { id: 'haiku', label: 'Haiku', description: 'Fastest', efforts: [] },
    ]);
    expect(h.queries[0]?.closed).toBe(true);
  });

  it('tests the instance with a trivial turn and reports account and version', async () => {
    const init = loadFixture('turn.json')[0] as FakeStep;
    const h = harness([[init, result(0.001)]]);
    expect(await h.adapter.send({ type: 'test' })).toEqual({
      ok: true,
      account: 'someone@example.com (Example)',
      version: '2.1.316',
      message: null,
    });
    expect(h.queries[0]?.options).toMatchObject({ maxTurns: 1, tools: [], persistSession: false });
    expect(h.queries[0]?.closed).toBe(true);
  });
});

describe('extraArgs', () => {
  it('maps flags with and without values', () => {
    expect(extraArgs(['--debug', '--add-dir=/x', '--model', 'opus'])).toEqual({
      debug: null,
      'add-dir': '/x',
      model: 'opus',
    });
  });

  it('refuses a value without a flag', () => {
    expect(() => extraArgs(['opus'])).toThrow(/not a --flag/);
  });
});
