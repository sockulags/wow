import type {
  ProviderAdapterContext,
  ProviderCommand,
  ProviderEvent,
  ProviderInstance,
} from '@wow/contracts';
import {
  ProviderEvent as ProviderEventSchema,
  ProviderModel,
  providerChatOptions,
} from '@wow/contracts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  update: null,
  updateRun: null,
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

const assistantText = (id: string, text: string): FakeStep => ({
  message: {
    type: 'assistant',
    message: {
      id: `msg_${id}`,
      type: 'message',
      role: 'assistant',
      model: 'sonnet',
      content: [{ type: 'text', text }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-0000000000cc',
    session_id: 'sess-1',
  } as unknown as SDKMessage,
});

// What Claude Code reports as running in the background after a change (the whole list).
const backgroundChanged = (
  tasks: Array<{ id: string; description: string; ambient?: boolean; type?: string }>,
): FakeStep => ({
  message: {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: tasks.map((task) => ({
      task_id: task.id,
      task_type: task.type ?? 'local_agent',
      description: task.description,
      ...(task.ambient ? { ambient: true } : {}),
    })),
    uuid: '00000000-0000-4000-8000-0000000000dd',
    session_id: 'sess-1',
  } as unknown as SDKMessage,
});

// Claude Code's notice that a background task ended, which it then answers in a turn.
const taskNotification = (
  id: string,
  status: 'completed' | 'failed' | 'stopped' = 'completed',
): FakeStep => ({
  message: {
    type: 'system',
    subtype: 'task_notification',
    task_id: id,
    status,
    output_file: '',
    summary: 'Done',
    uuid: '00000000-0000-4000-8000-0000000000de',
    session_id: 'sess-1',
  } as unknown as SDKMessage,
});

const released = () => {
  const gate: { release?: () => void } = {};
  const hold = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  return { step: { hold } satisfies FakeStep, release: () => gate.release?.() };
};

const initStep = () => loadFixture('turn.json')[0] as FakeStep;

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

const boundary = (
  trigger: 'manual' | 'auto',
  preTokens: number,
  postTokens?: number,
): FakeStep => ({
  message: {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: {
      trigger,
      pre_tokens: preTokens,
      ...(postTokens === undefined ? {} : { post_tokens: postTokens }),
    },
    uuid: '00000000-0000-4000-8000-0000000000c1',
    session_id: 'sess-1',
  } as unknown as SDKMessage,
});

describe('@wow/provider-claude', () => {
  it('is the claude provider', () => {
    expect(providerKind).toBe('claude');
  });

  // Questions and models spec 13, 17: a step on Claude Code may leave the model to it, and the
  // copy of that fact in contracts agrees.
  it('does not require a model on a step', () => {
    const { adapter } = harness([]);
    expect(adapter.requiresModel).toBe(false);
    expect(providerChatOptions.claude.requiresModel).toBe(adapter.requiresModel);
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
          answer: { picked: ['README.md'], text: '' },
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
        kind: 'command',
        command: 'ls',
      },
      {
        type: 'approvalRequested',
        threadId: 't1',
        approvalId: 'toolu_bash',
        kind: 'command',
        summary: 'Claude wants to run ls',
        request: { toolName: 'Bash', input: { command: 'ls' } },
        facts: { kind: 'command', command: 'ls', ruleHint: 'ls' },
      },
      { type: 'toolCallOutput', threadId: 't1', itemId: 'toolu_bash', output: 'README.md\nsrc' },
      { type: 'toolCallCompleted', threadId: 't1', itemId: 'toolu_bash', status: 'ok' },
      expect.objectContaining({ type: 'toolCallStarted', itemId: 'toolu_ask' }),
      {
        type: 'questionAsked',
        threadId: 't1',
        questionId: 'toolu_ask:0',
        question: 'Which file should I open?',
        header: 'File',
        askId: 'toolu_ask',
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
        // The model of the init message (agent workbench spec 9).
        model: 'claude-sonnet-4-5',
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

  // Questions spec 6: Claude Code takes one text per question, the picked labels and then the
  // typed text, as its own "Other" sends it; a "(Recommended)" choice is marked and keeps its label.
  it.each([
    ['a choice', { picked: ['Vitest (Recommended)'], text: '' }, 'Vitest (Recommended)'],
    [
      'typed text',
      { picked: [], text: ' node:test, no extra package ' },
      'node:test, no extra package',
    ],
    [
      'a choice and typed text',
      { picked: ['Jest'], text: 'only for the old package' },
      'Jest, only for the old package',
    ],
    ['several choices', { picked: ['Unit', 'End to end'], text: '' }, 'Unit, End to end'],
  ])('answers AskUserQuestion by %s, exactly', async (_name, reply, sent) => {
    const several = reply.picked.includes('Unit');
    const question = several
      ? {
          question: 'Which tests should run?',
          header: 'Tests',
          options: [
            { label: 'Unit', description: 'Fast' },
            { label: 'End to end', description: 'Slow' },
          ],
          multiSelect: true,
        }
      : {
          question: 'Which test runner?',
          header: 'Runner',
          options: [
            { label: 'Jest', description: 'Older' },
            { label: 'Vitest (Recommended)', description: 'Fits Vite' },
          ],
          multiSelect: false,
        };
    const input = { questions: [question] };
    const h = harness(
      [
        [
          initStep(),
          assistantToolUse('toolu_q', 'AskUserQuestion', input),
          { permission: { toolName: 'AskUserQuestion', input, toolUseID: 'toolu_q' } },
          result(0.01),
        ],
      ],
      (event) => {
        if (event.type === 'questionAsked') {
          void h.adapter.send({
            type: 'answerQuestion',
            questionId: event.questionId,
            answer: reply,
          });
        }
      },
    );
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await done;
    const asked = h.events.find((event) => event.type === 'questionAsked');
    expect(asked).toMatchObject({
      header: question.header,
      askId: 'toolu_q',
      multiSelect: several,
      options: several
        ? question.options
        : [
            { label: 'Jest', description: 'Older' },
            { label: 'Vitest (Recommended)', description: 'Fits Vite', recommended: true },
          ],
    });
    expect(h.queries[0]?.permissionResults).toEqual([
      {
        behavior: 'allow',
        updatedInput: { ...input, answers: { [question.question]: sent } },
      },
    ]);
  });

  it('reports a failed Bash call as an error with its command and no exit code (agent workbench spec 27)', async () => {
    const failed: FakeStep = {
      message: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_t', content: '1 failed', is_error: true },
          ],
        },
        parent_tool_use_id: null,
        tool_use_result: { stdout: '', stderr: '1 failed', interrupted: false },
        session_id: 'sess-1',
      } as unknown as SDKMessage,
    };
    const h = harness([
      [assistantToolUse('toolu_t', 'Bash', { command: 'pnpm test' }), failed, result(0)],
    ]);
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await done;
    expect(h.events.filter((event) => event.type.startsWith('toolCall'))).toEqual([
      {
        type: 'toolCallStarted',
        threadId: 't1',
        itemId: 'toolu_t',
        name: 'Bash',
        input: { command: 'pnpm test' },
        kind: 'command',
        command: 'pnpm test',
      },
      { type: 'toolCallOutput', threadId: 't1', itemId: 'toolu_t', output: '1 failed' },
      { type: 'toolCallCompleted', threadId: 't1', itemId: 'toolu_t', status: 'error' },
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

  const toolset = {
    name: 'wow',
    url: 'http://127.0.0.1:4317/assistant/mcp',
    token: 'invented-token',
  };
  const assistantTurn = () =>
    startTurn({
      cwd: '/home/me/.wow/assistant',
      prompt: 'Set my work hours to 8 to 4',
      permissionMode: 'bypassPermissions',
      toolset,
      instructions: 'You operate wow only.',
    });

  it('starts an assistant turn with the wow tools only, no settings and the given folder', async () => {
    const h = harness([[result(0.01)]]);
    const done = h.next('turnCompleted');
    await h.adapter.send(assistantTurn());
    await done;
    const options = h.queries[0]?.options;
    expect(options).toMatchObject({
      cwd: '/home/me/.wow/assistant',
      mcpServers: {
        wow: {
          type: 'http',
          url: 'http://127.0.0.1:4317/assistant/mcp',
          headers: { Authorization: 'Bearer invented-token' },
        },
      },
      strictMcpConfig: true,
      // No built-in tool at all: nothing that reads or writes files, runs commands or fetches.
      tools: [],
      allowedTools: ['mcp__wow__*'],
      settingSources: [],
      // The instance's launch arguments (--add-dir here) are left out too.
      extraArgs: {},
      systemPrompt: 'You operate wow only.',
      // Whatever mode the turn names, an assistant turn denies what is not allowed.
      permissionMode: 'dontAsk',
      env: { CLAUDE_CONFIG_DIR: '/home/me/.claude-work', ANTHROPIC_API_KEY: 'resolved-secret' },
    });
    expect(options?.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options?.additionalDirectories).toBeUndefined();
    expect(options?.plugins).toBeUndefined();
  });

  it('denies an assistant turn every tool that is not one of the wow tools', async () => {
    const h = harness([
      [
        {
          permission: {
            toolName: 'Bash',
            input: { command: 'cat ~/.ssh/id_ed25519' },
            toolUseID: 'a',
          },
        },
        { permission: { toolName: 'Read', input: { file_path: '/etc/hosts' }, toolUseID: 'b' } },
        { permission: { toolName: 'mcp__other__read_file', input: {}, toolUseID: 'c' } },
        { permission: { toolName: 'mcp__wow__read_settings', input: {}, toolUseID: 'd' } },
        result(0),
      ],
    ]);
    const done = h.next('turnCompleted');
    await h.adapter.send(assistantTurn());
    await done;
    expect(h.queries[0]?.permissionResults.map((answer) => answer.behavior)).toEqual([
      'deny',
      'deny',
      'deny',
      'allow',
    ]);
    // Nothing was asked of the user.
    expect(h.events.some((event) => event.type === 'approvalRequested')).toBe(false);
  });

  it('keeps an assistant session on its own mode and never turns it into an ordinary one', async () => {
    const h = harness([[result(0)], [result(0)]]);
    let done = h.next('turnCompleted');
    await h.adapter.send(assistantTurn());
    await done;
    await h.adapter.send({
      type: 'setPermissionMode',
      threadId: 't1',
      permissionMode: 'bypassPermissions',
    });
    done = h.next('turnCompleted');
    await h.adapter.send(assistantTurn());
    await done;
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]?.calls).toEqual([]);
    await expect(h.adapter.send(startTurn())).rejects.toThrow(/app's tools only/);
  });

  it('reopens an assistant session with the new instruction text, going on with its conversation', async () => {
    const h = harness([[initStep(), result(0)], [result(0)]]);
    let done = h.next('turnCompleted');
    await h.adapter.send(assistantTurn());
    await done;
    done = h.next('turnCompleted');
    await h.adapter.send({ ...assistantTurn(), instructions: 'You operate wow only. Be brief.' });
    await done;
    expect(h.queries).toHaveLength(2);
    expect(h.queries[0]?.closed).toBe(true);
    expect(h.queries[1]?.options).toMatchObject({
      systemPrompt: 'You operate wow only. Be brief.',
      resume: 'sess-1',
      tools: [],
      settingSources: [],
    });
    // The same text again keeps the session.
    done = h.next('turnCompleted');
    await h.adapter.send({ ...assistantTurn(), instructions: 'You operate wow only. Be brief.' });
    await done;
    expect(h.queries).toHaveLength(2);
  });

  it("closes a thread's session on closeThread, and the next turn opens a fresh one", async () => {
    const h = harness([[initStep(), result(0)]]);
    const done = h.next('turnCompleted');
    await h.adapter.send(assistantTurn());
    await done;
    await h.adapter.send({ type: 'closeThread', threadId: 't1' });
    expect(h.queries[0]?.closed).toBe(true);
    // Closing what is not there is not an error.
    await h.adapter.send({ type: 'closeThread', threadId: 't1' });
    const again = h.next('turnCompleted');
    await h.adapter.send(assistantTurn());
    await again;
    expect(h.queries).toHaveLength(2);
    expect(h.queries[1]?.options.resume).toBeUndefined();
    expect(h.events.filter((event) => event.type === 'turnFailed')).toEqual([]);
  });

  // Agent workbench spec 46: a compact boundary becomes a compaction with trigger and counts;
  // without post_tokens only the count before is given.
  it("reports Claude Code's compact boundary as a compaction", async () => {
    const h = harness([
      [initStep(), boundary('auto', 152_000, 18_000), boundary('manual', 40_000), result(0)],
    ]);
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn({ prompt: '/compact' }));
    await done;
    expect(h.events.filter((event) => event.type === 'compacted')).toEqual([
      {
        type: 'compacted',
        threadId: 't1',
        trigger: 'auto',
        preTokens: 152_000,
        postTokens: 18_000,
      },
      { type: 'compacted', threadId: 't1', trigger: 'manual', preTokens: 40_000 },
    ]);
  });

  it('sends an ordinary turn exactly the options it always had', async () => {
    const h = harness([[result(0.01)]]);
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await done;
    const options = h.queries[0]?.options ?? {};
    expect(Object.keys(options).toSorted()).toEqual([
      'canUseTool',
      'cwd',
      'effort',
      'env',
      'extraArgs',
      'includePartialMessages',
      'model',
      'pathToClaudeCodeExecutable',
      'permissionMode',
      'settingSources',
      'stderr',
    ]);
    expect(options).toMatchObject({
      cwd: '/work/demo',
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'default',
      includePartialMessages: true,
      settingSources: ['user', 'project', 'local'],
      pathToClaudeCodeExecutable: '/opt/claude/bin/claude',
      extraArgs: { 'add-dir': '../shared', verbose: null },
      env: {
        PATH: '/usr/bin',
        CLAUDE_AGENT_SDK_CLIENT_APP: 'wow',
        CLAUDE_CONFIG_DIR: '/home/me/.claude-work',
        ANTHROPIC_API_KEY: 'resolved-secret',
      },
    });
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

  it('sends the note of a denial as its message (agent workbench spec 37)', async () => {
    const steps = [...loadFixture('turn.json').slice(0, 8), result(0)];
    const h = harness([steps], (event) => {
      if (event.type === 'approvalRequested') {
        void h.adapter.send({
          type: 'answerApproval',
          approvalId: event.approvalId,
          decision: 'deny',
          note: 'Use pnpm, not npm.',
        });
      }
    });
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await done;
    expect(h.queries[0]?.permissionResults).toEqual([
      { behavior: 'deny', message: 'Use pnpm, not npm.' },
    ]);
  });

  it('draws an Edit as a diff from its input, then from its result patch (spec 33)', async () => {
    const input = { file_path: '/work/demo/src/timer.ts', old_string: 'a\nb', new_string: 'a\nc' };
    const written: FakeStep = {
      message: {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_e', content: 'ok' }],
        },
        parent_tool_use_id: null,
        tool_use_result: {
          filePath: '/work/demo/src/timer.ts',
          structuredPatch: [
            { oldStart: 3, oldLines: 2, newStart: 3, newLines: 2, lines: [' a', '-b', '+c'] },
          ],
        },
        session_id: 'sess-1',
      } as unknown as SDKMessage,
    };
    const created = { file_path: '/work/demo/src/new.ts', content: 'one\ntwo\n' };
    const h = harness([
      [
        assistantToolUse('toolu_e', 'Edit', input),
        written,
        assistantToolUse('toolu_w', 'Write', created),
        result(0),
      ],
    ]);
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await done;
    const started = h.events.filter((event) => event.type === 'toolCallStarted');
    expect(started).toEqual([
      expect.objectContaining({
        kind: 'edit',
        path: '/work/demo/src/timer.ts',
        diff: '@@ -1,2 +1,2 @@\n-a\n-b\n+a\n+c',
      }),
      expect.objectContaining({
        kind: 'edit',
        path: '/work/demo/src/new.ts',
        diff: '@@ -0,0 +1,2 @@\n+one\n+two',
      }),
    ]);
    expect(h.events.find((event) => event.type === 'toolCallCompleted')).toEqual({
      type: 'toolCallCompleted',
      threadId: 't1',
      itemId: 'toolu_e',
      status: 'ok',
      diff: '@@ -3,2 +3,2 @@\n a\n-b\n+c',
    });
  });

  it('asks to leave plan mode as a plan approval and starts in the chosen mode (spec 42)', async () => {
    const plan = '1. Read the timer\n2. Add a bell';
    const h = harness(
      [
        [
          {
            permission: { toolName: 'ExitPlanMode', input: { plan }, toolUseID: 'toolu_plan' },
          },
          { permission: { toolName: 'ExitPlanMode', input: {}, toolUseID: 'toolu_plan2' } },
          result(0),
        ],
      ],
      (event) => {
        if (event.type !== 'approvalRequested') return;
        void h.adapter.send(
          event.approvalId === 'toolu_plan'
            ? {
                type: 'answerApproval',
                approvalId: event.approvalId,
                decision: 'allowOnce',
                permissionMode: 'acceptEdits',
              }
            : {
                type: 'answerApproval',
                approvalId: event.approvalId,
                decision: 'deny',
                note: 'Plan the tests too.',
              },
        );
      },
    );
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn({ permissionMode: 'plan' }));
    await done;
    const asked = h.events.filter((event) => event.type === 'approvalRequested');
    expect(asked).toEqual([
      expect.objectContaining({ kind: 'plan', facts: { kind: 'other', plan } }),
      // The request did not carry the plan: wow falls back to the conversation's text.
      expect.objectContaining({ kind: 'plan', facts: {} }),
    ]);
    expect(h.queries[0]?.permissionResults).toEqual([
      {
        behavior: 'allow',
        updatedInput: { plan },
        updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      },
      { behavior: 'deny', message: 'Plan the tests too.' },
    ]);
    // The session already is in the new mode, so the thread's own mode change sends nothing.
    await h.adapter.send({
      type: 'setPermissionMode',
      threadId: 't1',
      permissionMode: 'acceptEdits',
    });
    expect(h.queries[0]?.calls).not.toContain('setPermissionMode:acceptEdits');
  });

  it('shows an MCP request as its server, tool and arguments (spec 36)', async () => {
    const h = harness(
      [
        [
          {
            permission: {
              toolName: 'mcp__github__create_issue',
              input: { title: 'Bell' },
              toolUseID: 'toolu_m',
            },
          },
          result(0),
        ],
      ],
      (event) => {
        if (event.type === 'approvalRequested')
          void h.adapter.send({
            type: 'answerApproval',
            approvalId: event.approvalId,
            decision: 'allowOnce',
          });
      },
    );
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await done;
    expect(h.events.find((event) => event.type === 'approvalRequested')).toEqual(
      expect.objectContaining({
        kind: 'tool',
        facts: {
          kind: 'mcp',
          server: 'github',
          tool: 'create_issue',
          arguments: { title: 'Bell' },
        },
      }),
    );
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

  // Claude Code goes on by itself once a background agent ends: more output and a second result
  // arrive on the open stream without a startTurn.
  it('reports a turn Claude Code starts by itself after its background work ends', async () => {
    const later = released();
    const h = harness([
      [
        assistantText('1', 'I started a background agent.'),
        backgroundChanged([
          { id: 'bg-1', description: 'Count the tea leaves' },
          { id: 'mem', description: 'Memory', ambient: true },
        ]),
        result(0.01),
        later.step,
        backgroundChanged([]),
        assistantText('2', 'The agent counted 42 leaves.'),
        result(0.03),
      ],
    ]);
    const first = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await first;
    expect(h.events.filter((event) => event.type === 'backgroundTasks')).toEqual([
      {
        type: 'backgroundTasks',
        threadId: 't1',
        tasks: [{ id: 'bg-1', description: 'Count the tea leaves', agent: true, kind: 'agent' }],
      },
    ]);
    const before = h.events.length;
    const second = h.next('turnCompleted');
    later.release();
    await second;
    expect(h.events.slice(before)).toEqual([
      { type: 'backgroundTasks', threadId: 't1', tasks: [] },
      { type: 'turnStartedByProvider', threadId: 't1' },
      {
        type: 'textDelta',
        threadId: 't1',
        itemId: 'msg_2:full:0',
        delta: 'The agent counted 42 leaves.',
      },
      expect.objectContaining({ type: 'usage', costUsd: expect.closeTo(0.02) }),
      { type: 'contextUsage', threadId: 't1', usedTokens: 1500, maxTokens: 200_000 },
      { type: 'turnCompleted', threadId: 't1' },
    ]);
    expect(h.queries[0]?.prompts).toEqual(['What is in the readme?']);
  });

  it('starts no turn for a background agent that was stopped', async () => {
    const later = released();
    const h = harness([
      [
        backgroundChanged([{ id: 'bg-1', description: 'Count the tea leaves' }]),
        result(0),
        later.step,
        taskNotification('bg-1', 'stopped'),
        backgroundChanged([]),
      ],
    ]);
    const first = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await first;
    const before = h.events.length;
    const cleared = h.next('backgroundTasks');
    later.release();
    await cleared;
    expect(h.events.slice(before).map((event) => event.type)).toEqual(['backgroundTasks']);
  });

  it('starts the turn that answers a background agent before the agent leaves the list', async () => {
    const later = released();
    const h = harness([
      [
        backgroundChanged([
          { id: 'bg-1', description: 'Count the tea leaves' },
          { id: 'sh-1', description: 'npm run dev', type: 'local_bash' },
        ]),
        result(0),
        later.step,
        taskNotification('sh-1'),
        backgroundChanged([{ id: 'bg-1', description: 'Count the tea leaves' }]),
        taskNotification('bg-1'),
        backgroundChanged([]),
        assistantText('2', 'The agent counted 42 leaves.'),
        result(0),
      ],
    ]);
    const first = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await first;
    expect(h.events.find((event) => event.type === 'backgroundTasks')).toEqual({
      type: 'backgroundTasks',
      threadId: 't1',
      tasks: [
        { id: 'bg-1', description: 'Count the tea leaves', agent: true, kind: 'agent' },
        { id: 'sh-1', description: 'npm run dev', kind: 'command' },
      ],
    });
    const before = h.events.length;
    const second = h.next('turnCompleted');
    later.release();
    await second;
    expect(
      h.events
        .slice(before)
        .map((event) =>
          event.type === 'backgroundTasks' ? `background ${event.tasks.length}` : event.type,
        ),
    ).toEqual([
      'background 1',
      'turnStartedByProvider',
      'background 0',
      'textDelta',
      'usage',
      'contextUsage',
      'turnCompleted',
    ]);
  });

  it('stops a turn Claude Code started by itself', async () => {
    const later = released();
    const stopped = released();
    const h = harness([
      [
        backgroundChanged([{ id: 'bg-1', description: 'Count the tea leaves' }]),
        result(0),
        later.step,
        backgroundChanged([]),
        assistantText('2', 'Counting'),
        stopped.step,
        result(0),
      ],
    ]);
    const first = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await first;
    const streamed = h.next('textDelta');
    later.release();
    await streamed;
    const interrupted = h.next('turnInterrupted');
    await h.adapter.send({ type: 'interrupt', threadId: 't1' });
    stopped.release();
    expect(await interrupted).toEqual({ type: 'turnInterrupted', threadId: 't1' });
    expect(h.queries[0]?.calls).toEqual(['interrupt']);
    expect(h.events.map((event) => event.type)).not.toContain('turnFailed');
  });

  it('fails the turn background work would have started when Claude Code exits', async () => {
    const h = harness([
      [
        backgroundChanged([{ id: 'bg-1', description: 'Count the tea leaves' }]),
        result(0),
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
    const types = h.events.map((event) => event.type);
    expect(types.slice(types.indexOf('turnCompleted'))).toEqual([
      'turnCompleted',
      'backgroundTasks',
      'turnStartedByProvider',
      'turnFailed',
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

  // Agent workbench spec 51: a message written during the turn goes into the session's input
  // the way Claude Code's own queue takes it, so the server shows it sent.
  it('hands a message to the running turn with priority next', async () => {
    const later = released();
    const h = harness([
      [assistantText('1', 'Reading the readme.'), later.step, result(0.01)],
      [assistantText('2', 'And the summary.'), result(0.02)],
    ]);
    const started = h.next('textDelta');
    await h.adapter.send(startTurn());
    await started;
    expect(
      await h.adapter.send({ type: 'handOver', threadId: 't1', prompt: 'Then sum it up' }),
    ).toEqual({ taken: true });
    const first = h.next('turnCompleted');
    later.release();
    await first;
    // The fake answers the message after the result, as a turn Claude Code starts by itself.
    await h.next('turnCompleted');
    expect(h.events).toContainEqual({ type: 'turnStartedByProvider', threadId: 't1' });
    expect(h.queries[0]?.prompts).toEqual(['What is in the readme?', 'Then sum it up']);
    expect(h.queries[0]?.priorities).toEqual([undefined, 'next']);
  });

  // Agent workbench spec 53: the images wow stored go to Claude Code as base64 image blocks in
  // the user message, before its text.
  it('sends the images of a message as image blocks before the text @agent-workbench-53', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'wow claude images '));
    const screenshot = path.join(folder, 'a.png');
    const photo = path.join(folder, 'b.jpg');
    await writeFile(screenshot, Buffer.from('invented png bytes'));
    await writeFile(photo, Buffer.from('invented jpeg bytes'));
    try {
      const h = harness([[result(0.01)]]);
      const done = h.next('turnCompleted');
      await h.adapter.send(
        startTurn({
          prompt: 'What is wrong here?',
          images: [
            { path: screenshot, mediaType: 'image/png' },
            { path: photo, mediaType: 'image/jpeg' },
          ],
        }),
      );
      await done;
      expect(h.queries[0]?.messages[0]?.message).toEqual({
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: Buffer.from('invented png bytes').toString('base64'),
            },
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: Buffer.from('invented jpeg bytes').toString('base64'),
            },
          },
          { type: 'text', text: 'What is wrong here?' },
        ],
      });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('sends a message without images as plain text, as before', async () => {
    const h = harness([[result(0.01)]]);
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await done;
    expect(h.queries[0]?.messages[0]?.message).toEqual({
      role: 'user',
      content: 'What is in the readme?',
    });
  });

  it('takes no message when no turn runs', async () => {
    const h = harness([[result(0.01)], [result(0.02)]]);
    expect(await h.adapter.send({ type: 'handOver', threadId: 't1', prompt: 'Hello' })).toEqual({
      taken: false,
    });
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await done;
    expect(await h.adapter.send({ type: 'handOver', threadId: 't1', prompt: 'Late' })).toEqual({
      taken: false,
    });
    expect(h.queries[0]?.prompts).toEqual(['What is in the readme?']);
  });

  // Spec 60: Claude Code's own commands for the thread's folder, from a probe opened there.
  it("lists Claude Code's commands from a probe in the folder and closes it", async () => {
    const h = harness([]);
    expect(await h.adapter.send({ type: 'listCommands', cwd: '/work/demo' })).toEqual([
      { name: 'compact', description: 'Clear history but keep a summary' },
      {
        name: 'release-notes',
        description: 'Write the release notes (invented)',
        argumentHint: '<version>',
      },
    ]);
    expect(h.queries[0]?.options.cwd).toBe('/work/demo');
    expect(h.queries[0]?.closed).toBe(true);
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

  // Agent workbench spec 7, 8: Claude Code gives label, description and efforts, but no default
  // effort, no default flag and no image input, so those stay absent and nothing is guessed.
  it('shows the description and leaves the fields Claude Code does not report empty', async () => {
    const h = harness([]);
    const models = ProviderModel.array().parse(await h.adapter.send({ type: 'listModels' }));
    expect(models[0]?.description).toBe('Fast and capable');
    for (const model of models) {
      expect(model).not.toHaveProperty('defaultEffort');
      expect(model).not.toHaveProperty('isDefault');
      expect(model).not.toHaveProperty('imageInput');
    }
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

// A subagent's own messages, as Claude Code marks them with the Agent call they belong to.
const nested = (parent: string, step: FakeStep): FakeStep => {
  if (!('message' in step)) return step;
  return { message: { ...step.message, parent_tool_use_id: parent } as SDKMessage };
};

const taskProgress = (id: string, fields: { summary?: string; last_tool_name?: string }) =>
  ({
    message: {
      type: 'system',
      subtype: 'task_progress',
      task_id: id,
      description: 'Count the tea leaves',
      usage: { total_tokens: 10, tool_uses: 4, duration_ms: 1000 },
      ...fields,
      uuid: '00000000-0000-4000-8000-0000000000df',
      session_id: 'sess-1',
    } as unknown as SDKMessage,
  }) satisfies FakeStep;

describe('@wow/provider-claude subagents and background work (agent workbench U11)', () => {
  // Agent workbench spec 44: the Agent call is a subagent row; the subagent's calls and text
  // come under it, and its result gives the count, the time and the answer.
  it('nests a subagent’s three tool calls and its text under the Agent call, with count, time and answer', async () => {
    const h = harness([
      [
        assistantToolUse('agent-1', 'Agent', {
          description: 'explore the auth code',
          prompt: 'Find where the login is checked.',
          subagent_type: 'Explore',
        }),
        {
          message: {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'partial' },
            },
            parent_tool_use_id: 'agent-1',
            uuid: '00000000-0000-4000-8000-0000000000e0',
            session_id: 'sess-1',
          } as unknown as SDKMessage,
        },
        nested('agent-1', assistantToolUse('sub-1', 'Grep', { pattern: 'login', path: 'src' })),
        nested('agent-1', toolResult('sub-1', {})),
        nested('agent-1', assistantToolUse('sub-2', 'Read', { file_path: '/work/demo/src/a.ts' })),
        nested('agent-1', toolResult('sub-2', {})),
        nested('agent-1', assistantToolUse('sub-3', 'Bash', { command: 'pnpm test auth' })),
        nested('agent-1', toolResult('sub-3', {})),
        nested('agent-1', assistantText('sub-text', 'The check is in src/auth.ts.')),
        toolResult('agent-1', {
          status: 'completed',
          agentId: 'a1',
          prompt: 'Find where the login is checked.',
          content: [{ type: 'text', text: 'Login is checked in `src/auth.ts`.' }],
          totalToolUseCount: 3,
          totalDurationMs: 92_000,
          totalTokens: 1000,
          usage: {},
        }),
        assistantText('2', 'The subagent found it.'),
        result(0.01),
      ],
    ]);
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await done;
    const tools = h.events.filter(
      (event) => event.type === 'toolCallStarted' || event.type === 'textDelta',
    );
    expect(tools).toEqual([
      expect.objectContaining({
        type: 'toolCallStarted',
        itemId: 'agent-1',
        name: 'Agent',
        kind: 'subagent',
        description: 'explore the auth code',
        prompt: 'Find where the login is checked.',
        agentType: 'Explore',
      }),
      expect.objectContaining({ itemId: 'sub-1', kind: 'search', parentItemId: 'agent-1' }),
      expect.objectContaining({ itemId: 'sub-2', kind: 'read', parentItemId: 'agent-1' }),
      expect.objectContaining({ itemId: 'sub-3', kind: 'command', parentItemId: 'agent-1' }),
      {
        type: 'textDelta',
        threadId: 't1',
        itemId: 'msg_sub-text:full:0',
        delta: 'The check is in src/auth.ts.',
        parentItemId: 'agent-1',
      },
      expect.objectContaining({ type: 'textDelta', delta: 'The subagent found it.' }),
    ]);
    expect(tools[0]).not.toHaveProperty('parentItemId');
    expect(
      h.events.filter((event) => event.type === 'toolCallCompleted').map((event) => event.itemId),
    ).toEqual(['sub-1', 'sub-2', 'sub-3', 'agent-1']);
    expect(
      h.events.find((event) => event.type === 'toolCallCompleted' && event.itemId === 'agent-1'),
    ).toEqual({
      type: 'toolCallCompleted',
      threadId: 't1',
      itemId: 'agent-1',
      status: 'ok',
      toolCount: 3,
      durationMs: 92_000,
      answer: 'Login is checked in `src/auth.ts`.',
    });
  });

  it('reads Task, the older name of the subagent tool, and gives no count for a subagent sent to the background', async () => {
    const h = harness([
      [
        assistantToolUse('agent-1', 'Task', { description: 'count leaves', prompt: 'Count.' }),
        toolResult('agent-1', {
          status: 'async_launched',
          agentId: 'a1',
          description: 'count leaves',
          prompt: 'Count.',
          outputFile: '/tmp/out',
        }),
        result(0),
      ],
    ]);
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await done;
    expect(h.events.find((event) => event.type === 'toolCallStarted')).toMatchObject({
      kind: 'subagent',
      description: 'count leaves',
    });
    expect(h.events.find((event) => event.type === 'toolCallCompleted')).toEqual({
      type: 'toolCallCompleted',
      threadId: 't1',
      itemId: 'agent-1',
      status: 'ok',
    });
  });

  // A background subagent goes on after the turn: its messages have no row to go under and start
  // no turn of their own.
  it('drops a background subagent’s messages once the turn has ended, starting no turn', async () => {
    const later = released();
    const h = harness([
      [
        backgroundChanged([{ id: 'bg-agent', description: 'Count the tea leaves' }]),
        result(0),
        later.step,
        nested('bg-agent', assistantToolUse('sub-1', 'Read', { file_path: '/work/demo/a.ts' })),
        nested('bg-agent', toolResult('sub-1', {})),
        backgroundChanged([]),
      ],
    ]);
    const first = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await first;
    const before = h.events.length;
    const cleared = h.next('backgroundTasks');
    later.release();
    await cleared;
    expect(h.events.slice(before).map((event) => event.type)).toEqual(['backgroundTasks']);
  });

  // Spec 90: a chip opens to the latest a task reported; the list that follows keeps it.
  it('keeps the latest progress of a background task as its last output', async () => {
    const h = harness([
      [
        backgroundChanged([{ id: 'bg-1', description: 'Count the tea leaves' }]),
        taskProgress('bg-1', { last_tool_name: 'Grep' }),
        taskProgress('bg-1', { summary: 'Counted 30 leaves so far' }),
        taskProgress('other', { summary: 'Not listed' }),
        backgroundChanged([
          { id: 'bg-1', description: 'Count the tea leaves' },
          { id: 'sh-1', description: 'pnpm dev', type: 'local_bash' },
        ]),
        result(0),
      ],
    ]);
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await done;
    expect(
      h.events.flatMap((event) => (event.type === 'backgroundTasks' ? [event.tasks] : [])),
    ).toEqual([
      [{ id: 'bg-1', description: 'Count the tea leaves', agent: true, kind: 'agent' }],
      [
        {
          id: 'bg-1',
          description: 'Count the tea leaves',
          agent: true,
          kind: 'agent',
          lastOutput: 'Grep · 4 tool calls',
        },
      ],
      [
        {
          id: 'bg-1',
          description: 'Count the tea leaves',
          agent: true,
          kind: 'agent',
          lastOutput: 'Counted 30 leaves so far',
        },
      ],
      [
        {
          id: 'bg-1',
          description: 'Count the tea leaves',
          agent: true,
          kind: 'agent',
          lastOutput: 'Counted 30 leaves so far',
        },
        { id: 'sh-1', description: 'pnpm dev', kind: 'command' },
      ],
    ]);
  });

  // Spec 90: Stop on a chip and Ctrl+B go to the live query as Claude Code's own stopTask and
  // backgroundTasks.
  it('stops a background task and sends a running call to the background through the live query', async () => {
    const later = released();
    const h = harness([[later.step, result(0)]]);
    const done = h.next('turnCompleted');
    await h.adapter.send(startTurn());
    await h.adapter.send({ type: 'stopTask', threadId: 't1', taskId: 'bg-1' });
    await h.adapter.send({ type: 'toBackground', threadId: 't1', itemId: 'tool-7' });
    await h.adapter.send({ type: 'toBackground', threadId: 't1' });
    await expect(
      h.adapter.send({ type: 'toBackground', threadId: 't1', itemId: 'none-running' }),
    ).rejects.toThrow(/Nothing of this turn runs in the foreground/);
    expect(h.queries[0]?.calls).toEqual([
      'stopTask:bg-1',
      'backgroundTasks:tool-7',
      'backgroundTasks:',
      'backgroundTasks:none-running',
    ]);
    later.release();
    await done;
    await expect(
      h.adapter.send({ type: 'stopTask', threadId: 'other', taskId: 'bg-1' }),
    ).rejects.toThrow(/not running for thread other/);
    expect(
      providerChatOptions.claude.stopsTasks && providerChatOptions.claude.sendsToBackground,
    ).toBe(true);
  });
});
