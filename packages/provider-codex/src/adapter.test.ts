import type { ProviderEvent, ProviderInstance } from '@wow/contracts';
import { ProviderEvent as ProviderEventSchema } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import {
  CodexAdapter,
  codexVersionFromUserAgent,
  type CodexAdapterOptions,
  type CodexVersionVerdict,
} from './adapter.js';
import { CompatibilityCache, type GenerateSchema } from './compat/check.js';
import type { ProtocolFingerprint } from './compat/schema.js';
import { synthesizeSchema, writeSchema } from './compat/synthesize.js';
import type { InstallIo } from './install.js';
import type { CodexLaunch, CommandLaunch, RunCommand } from './process.js';
import { codexProtocolFingerprint } from './protocol/generated/fingerprint.js';
import { codexProtocolVersion } from './protocol/generated/index.js';
import {
  FakeCodexProcess,
  ManualTimers,
  ReplayCodexProcess,
  readFixture,
  type FixtureEntry,
} from './testing.js';

const instance: ProviderInstance = {
  id: 'codex-work',
  kind: 'codex',
  name: 'Codex (work)',
  binaryPath: '/opt/codex/bin/codex',
  configDir: '/home/demo/.codex',
  env: { CODEX_LOG: 'warn' },
  launchArgs: ['-c', 'model_reasoning_summary="auto"'],
  defaultModel: 'gpt-6.1-sol',
  defaultEffort: 'medium',
  defaultPermissionMode: 'auto',
  status: 'unknown',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
};

// Follows the generated version, so regenerating for a new codex keeps these tests meaningful.
const agentOf = (version: string) => `wow/${version} (Demo OS; x86_64) linux (wow; 0.0.0)`;
const userAgent = agentOf(codexProtocolVersion);

// An invented codex install for the update offer: npm put it under /opt/codex, which is also
// where `npm prefix -g` points.
const npmInstall: InstallIo = {
  platform: 'linux',
  env: {},
  exists: (file) => file === '/opt/codex/lib/node_modules/@openai/codex/package.json',
  realpath: (file) => file,
};

// The generate-json-schema of a fake codex: writes an invented schema made from a fingerprint
// (the tested one unless a test says otherwise) and counts the runs.
function fakeSchema(fingerprint: ProtocolFingerprint | Error = codexProtocolFingerprint) {
  const runs: string[] = [];
  const generate: GenerateSchema = async (launch, outDir) => {
    runs.push(launch.binaryPath);
    if (fingerprint instanceof Error) throw fingerprint;
    await writeSchema(synthesizeSchema(fingerprint), outDir);
  };
  return { generate, runs };
}

function fakeNpm(prefix = '/opt/codex') {
  const launches: CommandLaunch[] = [];
  const run: RunCommand = (launch) => {
    launches.push(launch);
    return Promise.resolve({
      code: 0,
      stdout: `${prefix}\n`,
      stderr: '',
      timedOut: false,
      startError: null,
    });
  };
  return { run, launches };
}

type Answer = (params: Record<string, unknown>) => unknown;

// Answers requests by method; a method without an answer is left hanging.
class ScriptedCodex extends FakeCodexProcess {
  readonly #answers: Record<string, Answer>;
  constructor(answers: Record<string, Answer>) {
    super();
    this.#answers = answers;
  }
  protected override received(message: Record<string, unknown>): void {
    const method = message['method'];
    if (typeof method !== 'string' || !('id' in message)) return;
    const answer = this.#answers[method];
    if (answer)
      this.emit({
        id: message['id'],
        result: answer(message['params'] as Record<string, unknown>),
      });
  }
}

function setup(makeProcess: () => FakeCodexProcess, options: Partial<CodexAdapterOptions> = {}) {
  const processes: FakeCodexProcess[] = [];
  const launches: CodexLaunch[] = [];
  let ids = 0;
  const timers = new ManualTimers();
  const adapter = new CodexAdapter({
    instance,
    requestTimeoutMs: () => 30_000,
    baseEnv: { PATH: '/usr/bin', CODEX_HOME: '/somewhere/else' },
    timers,
    newId: () => `id-${++ids}`,
    spawn: (launch) => {
      launches.push(launch);
      const child = makeProcess();
      processes.push(child);
      return child;
    },
    generateSchema: fakeSchema().generate,
    runCommand: fakeNpm().run,
    installIo: npmInstall,
    ...options,
  });
  const events: ProviderEvent[] = [];
  adapter.onEvent((event) => {
    // Every event the adapter emits must pass the shared contract.
    events.push(ProviderEventSchema.parse(event));
  });
  const take = (): ProviderEvent[] => events.splice(0);
  const current = (): FakeCodexProcess => {
    const child = processes.at(-1);
    if (!child) throw new Error('no app-server started');
    return child;
  };
  return { adapter, events, take, processes, launches, timers, current };
}

const startTurn = {
  type: 'startTurn',
  threadId: 'thread-1',
  cwd: '/work/demo',
  prompt: 'Run the tests and fix the README',
  model: 'gpt-6.1-sol',
  effort: 'medium',
  permissionMode: 'auto',
} as const;

const written = (child: FakeCodexProcess, method: string) =>
  child.written.find((message) => message['method'] === method);

describe('CodexAdapter with recorded sessions', () => {
  it('streams a turn with reasoning, a plan, tools, approvals, questions and usage', async () => {
    const fixture = readFixture('turn-tools.jsonl');
    const { adapter, take, current, launches } = setup(() => new ReplayCodexProcess(fixture));

    await expect(adapter.send(startTurn)).resolves.toEqual({
      providerSessionId: '01a1a000-0000-7000-8000-000000000001',
      turnId: '01a1a000-0000-7000-8000-000000000002',
    });
    const child = current() as ReplayCodexProcess;
    expect(launches).toEqual([
      {
        binaryPath: '/opt/codex/bin/codex',
        launchArgs: ['-c', 'model_reasoning_summary="auto"'],
        env: { PATH: '/usr/bin', CODEX_HOME: '/home/demo/.codex', CODEX_LOG: 'warn' },
      },
    ]);
    expect(written(child, 'thread/start')?.['params']).toEqual({
      cwd: '/work/demo',
      model: 'gpt-6.1-sol',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
    expect(written(child, 'turn/start')?.['params']).toEqual({
      threadId: '01a1a000-0000-7000-8000-000000000001',
      input: [{ type: 'text', text: 'Run the tests and fix the README', text_elements: [] }],
      cwd: '/work/demo',
      model: 'gpt-6.1-sol',
      effort: 'medium',
      approvalPolicy: 'on-request',
    });
    const threadId = 'thread-1';
    expect(take()).toEqual([
      { type: 'session', threadId, providerSessionId: '01a1a000-0000-7000-8000-000000000001' },
      { type: 'reasoningDelta', threadId, itemId: 'item-reasoning', delta: 'Checking the test ' },
      { type: 'reasoningDelta', threadId, itemId: 'item-reasoning', delta: 'script first.' },
      {
        type: 'taskListUpdated',
        threadId,
        tasks: [
          {
            id: '01a1a000-0000-7000-8000-000000000002-0',
            content: 'Run the tests',
            status: 'in_progress',
          },
          {
            id: '01a1a000-0000-7000-8000-000000000002-1',
            content: 'Fix the README',
            status: 'pending',
          },
        ],
      },
      {
        type: 'toolCallStarted',
        threadId,
        itemId: 'item-command',
        name: 'command',
        input: { command: 'pnpm test', cwd: '/work/demo' },
      },
      expect.objectContaining({
        type: 'approvalRequested',
        threadId,
        approvalId: 'id-1',
        kind: 'command',
        summary: 'pnpm test',
      }),
    ]);

    await adapter.send({ type: 'answerApproval', approvalId: 'id-1', decision: 'allowSession' });
    expect(child.written.at(-1)).toEqual({ id: 0, result: { decision: 'acceptForSession' } });
    expect(take()).toEqual([
      { type: 'toolCallOutput', threadId, itemId: 'item-command', output: '> vitest run\n' },
      { type: 'toolCallOutput', threadId, itemId: 'item-command', output: 'Tests 12 passed\n' },
      { type: 'toolCallCompleted', threadId, itemId: 'item-command', status: 'ok' },
      {
        type: 'toolCallStarted',
        threadId,
        itemId: 'item-patch',
        name: 'fileChange',
        input: { changes: [{ path: 'README.md', kind: 'update' }] },
      },
      expect.objectContaining({
        type: 'approvalRequested',
        approvalId: 'id-2',
        kind: 'fileChange',
        summary: 'Edit README.md',
        request: expect.objectContaining({
          changes: [expect.objectContaining({ path: 'README.md' })],
        }),
      }),
    ]);

    await adapter.send({ type: 'answerApproval', approvalId: 'id-2', decision: 'deny' });
    expect(child.written.at(-1)).toEqual({ id: 1, result: { decision: 'decline' } });
    // A declined patch has no streamed output, so its diff is reported once at completion.
    expect(take()).toEqual([
      {
        type: 'toolCallOutput',
        threadId,
        itemId: 'item-patch',
        output: '@@ -1 +1 @@\n-# Demo\n+# Demo app\n',
      },
      { type: 'toolCallCompleted', threadId, itemId: 'item-patch', status: 'error' },
      {
        type: 'questionAsked',
        threadId,
        questionId: 'id-3',
        question: 'Title: Which title should the README use?',
        options: [
          { label: 'Demo app', description: 'Short' },
          { label: 'Demo application', description: 'Long' },
        ],
        multiSelect: false,
      },
      {
        type: 'questionAsked',
        threadId,
        questionId: 'id-4',
        question: 'Add a build badge?',
        options: [],
        multiSelect: false,
      },
    ]);

    // codex takes the answers of one request together, so nothing is sent after the first.
    const writes = child.written.length;
    await expect(
      adapter.send({ type: 'answerQuestion', questionId: 'id-3', answer: 'Demo app' }),
    ).resolves.toEqual({ ok: true, waitingFor: 1 });
    expect(child.written).toHaveLength(writes);
    await adapter.send({ type: 'answerQuestion', questionId: 'id-4', answer: 'no' });
    expect(child.written.at(-1)).toEqual({
      id: 2,
      result: { answers: { title: { answers: ['Demo app'] }, badge: { answers: ['no'] } } },
    });
    expect(take()).toEqual([
      { type: 'textDelta', threadId, itemId: 'item-message', delta: 'Tests pass. ' },
      {
        type: 'textDelta',
        threadId,
        itemId: 'item-message',
        delta: 'I left the README as it was.',
      },
      { type: 'contextUsage', threadId, usedTokens: 5510, maxTokens: 258400 },
      expect.objectContaining({ type: 'taskListUpdated' }),
      { type: 'usage', threadId, inputTokens: 5200, outputTokens: 310, cachedInputTokens: 4000 },
      { type: 'turnCompleted', threadId },
    ]);
    expect(child.mismatches).toEqual([]);
    expect(child.remaining).toEqual([]);
  });

  it('interrupts a running turn (recorded from codex 0.166.0)', async () => {
    const fixture = readFixture('turn-interrupt.jsonl');
    const { adapter, take, current } = setup(() => new ReplayCodexProcess(fixture));
    await adapter.send({ ...startTurn, prompt: 'Say hi' });
    const threadId = 'thread-1';
    // The retried stream errors (willRetry) are not failures.
    expect(take()).toEqual([
      {
        type: 'session',
        threadId,
        providerSessionId: '01a1995d-22de-7fe1-adcf-2038dfc05f2a',
      },
    ]);
    await expect(adapter.send({ type: 'interrupt', threadId })).resolves.toEqual({
      interrupted: true,
    });
    const child = current() as ReplayCodexProcess;
    expect(written(child, 'turn/interrupt')?.['params']).toEqual({
      threadId: '01a1995d-22de-7fe1-adcf-2038dfc05f2a',
      turnId: '01a1995d-22f3-7a62-ace7-4bf9f1578299',
    });
    expect(take()).toEqual([{ type: 'turnInterrupted', threadId }]);
    expect(child.mismatches).toEqual([]);
    expect(child.remaining).toEqual([]);
    await expect(adapter.send({ type: 'interrupt', threadId })).resolves.toEqual({
      interrupted: false,
    });
  });

  it('fails Test with a login hint when codex has no account (recorded from codex 0.166.0)', async () => {
    // Once the protocol moves to a newer codex, the recording is a compatible older version.
    const fixture = readFixture('test-not-logged-in.jsonl');
    const { adapter, current } = setup(() => new ReplayCodexProcess(fixture));
    await expect(adapter.send({ type: 'test' })).rejects.toMatchObject({
      code: 'auth',
      message: expect.stringContaining('codex is not logged in'),
    });
    expect(adapter.serverVersion).toBe('0.166.0');
    expect((current() as ReplayCodexProcess).mismatches).toEqual([]);
  });

  it('lists models from the recorded model/list answer', async () => {
    const recorded = readFixture('test-not-logged-in.jsonl');
    // Same session without the account check in between.
    const fixture = recorded.filter(
      (entry: FixtureEntry) => entry.msg['method'] !== 'account/read' && entry.msg['id'] !== 2,
    );
    const { adapter } = setup(() => new ReplayCodexProcess(fixture));
    const models = (await adapter.send({ type: 'listModels' })) as { id: string }[];
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]).toMatchObject({
      id: 'gpt-6.1-sol',
      label: 'GPT-6.1-Sol',
      efforts: expect.arrayContaining(['low', 'medium', 'high']),
    });
  });
});

const model = (id: string, hidden = false) => ({
  id,
  model: id,
  displayName: id.toUpperCase(),
  description: `${id} model`,
  hidden,
  supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }],
  defaultReasoningEffort: 'low',
  isDefault: id === 'a',
});

const baseAnswers: Record<string, Answer> = {
  initialize: () => ({ userAgent, codexHome: '/home/demo/.codex' }),
  'thread/start': () => ({ thread: { id: 'codex-thread' } }),
  'thread/resume': (params) => ({ thread: { id: params['threadId'] } }),
  'turn/start': () => ({ turn: { id: 'turn-1', status: 'inProgress' } }),
};

const testAnswers = (version: string): Record<string, Answer> => ({
  ...baseAnswers,
  initialize: () => ({ userAgent: agentOf(version) }),
  'account/read': () => ({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }),
  'model/list': () => ({ data: [model('a')], nextCursor: null }),
});

describe('CodexAdapter', () => {
  it('passes Test with the account, version and paged models', async () => {
    const { adapter } = setup(
      () =>
        new ScriptedCodex({
          ...baseAnswers,
          'account/read': () => ({
            account: { type: 'chatgpt', email: 'demo@example.invalid', planType: 'pro' },
            requiresOpenaiAuth: true,
          }),
          'model/list': (params) =>
            params['cursor'] === null
              ? { data: [model('a'), model('hidden', true)], nextCursor: 'page-2' }
              : { data: [model('b')], nextCursor: null },
        }),
    );
    await expect(adapter.send({ type: 'test' })).resolves.toEqual({
      ok: true,
      account: 'demo@example.invalid',
      version: codexProtocolVersion,
      message: null,
      update: null,
      models: [
        {
          id: 'a',
          label: 'A',
          description: 'a model',
          efforts: ['low'],
          defaultEffort: 'low',
          isDefault: true,
        },
        expect.objectContaining({ id: 'b', isDefault: false }),
      ],
    });
  });

  it('passes Test on an older codex whose schema is compatible, once per version', async () => {
    const schema = fakeSchema({ ...codexProtocolFingerprint, codexVersion: '0.0.1' });
    const npm = fakeNpm();
    const compatibility = new CompatibilityCache<CodexVersionVerdict>();
    const options = { generateSchema: schema.generate, runCommand: npm.run, compatibility };
    const { adapter } = setup(() => new ScriptedCodex(testAnswers('0.0.1')), options);
    const result = await adapter.send({ type: 'test' });
    expect(result).toMatchObject({
      ok: true,
      account: 'API key',
      version: '0.0.1',
      message: `codex 0.0.1 differs from the tested ${codexProtocolVersion}; compatible.`,
      update: {
        method: 'npm',
        reason: 'older',
        targetVersion: codexProtocolVersion,
        packageSpec: `@openai/codex@${codexProtocolVersion}`,
        prefix: null,
      },
    });
    expect(schema.runs).toEqual(['/opt/codex/bin/codex']);
    expect(npm.launches.map((launch) => [launch.file, ...launch.args])).toEqual([
      ['npm', 'prefix', '-g'],
    ]);

    // A second adapter for the same binary and version (after an edit) reuses the answer.
    const again = setup(() => new ScriptedCodex(testAnswers('0.0.1')), options);
    await expect(again.adapter.send({ type: 'test' })).resolves.toMatchObject({ ok: true });
    expect(schema.runs).toHaveLength(1);
  });

  it('turns keep working on a compatible version and drop notifications they do not know', async () => {
    const { adapter, take, current } = setup(() => new ScriptedCodex(testAnswers('0.0.1')));
    await adapter.send(startTurn);
    take();
    current().emit({ method: 'thread/goal/updated' });
    current().emit({ method: 'item/started', params: null });
    current().emit({ method: 'thread/goal/updated', params: { threadId: 'codex-thread' } });
    current().emit({
      method: 'turn/plan/updated',
      params: {
        threadId: 'codex-thread',
        turnId: 'turn-1',
        plan: [{ step: 'Read', status: 'blocked' }],
      },
    });
    current().emit({
      method: 'turn/completed',
      params: {
        threadId: 'codex-thread',
        turn: { id: 'turn-1', status: 'completed', error: null },
      },
    });
    expect(take()).toEqual([
      {
        type: 'taskListUpdated',
        threadId: 'thread-1',
        tasks: [{ id: 'turn-1-0', content: 'Read', status: 'pending' }],
      },
      { type: 'turnCompleted', threadId: 'thread-1' },
    ]);
  });

  it('fails Test on a codex whose schema is incompatible, with what changed and an update', async () => {
    const methods = { ...codexProtocolFingerprint.methods };
    delete methods['turn/interrupt'];
    const turnStart = methods['turn/start'];
    if (!turnStart) throw new Error('turn/start is not in the fingerprint');
    methods['turn/start'] = {
      ...turnStart,
      result: turnStart.result.map((field) =>
        field.path === 'turn.id' ? { ...field, shape: { ...field.shape, type: 'number' } } : field,
      ),
    };
    const schema = fakeSchema({ codexVersion: '0.0.1', methods });
    const npm = fakeNpm('/usr/local');
    const { adapter, current } = setup(() => new ScriptedCodex(testAnswers('0.0.1')), {
      generateSchema: schema.generate,
      runCommand: npm.run,
    });
    await expect(adapter.send({ type: 'test' })).resolves.toEqual({
      ok: false,
      account: null,
      version: '0.0.1',
      message: `codex 0.0.1 is not compatible with wow, which is tested with codex ${codexProtocolVersion}: turn/start result.turn.id changed from string to number; turn/interrupt is missing (renamed or removed). Update codex to ${codexProtocolVersion}.`,
      update: {
        method: 'npm',
        reason: 'incompatible',
        targetVersion: codexProtocolVersion,
        packageSpec: `@openai/codex@${codexProtocolVersion}`,
        // npm on PATH installs elsewhere, so the update names this install's prefix.
        prefix: '/opt/codex',
      },
      models: [],
    });
    expect(written(current(), 'account/read')).toBeUndefined();
  });

  it('fails Test with a clear message when codex cannot describe its protocol', async () => {
    const { CodexError } = await import('./connection.js');
    const schema = fakeSchema(
      new CodexError('unsupported', "error: unrecognized subcommand 'generate-json-schema'"),
    );
    const { adapter } = setup(() => new ScriptedCodex(testAnswers('0.0.1')), {
      generateSchema: schema.generate,
      installIo: { ...npmInstall, exists: () => false },
    });
    const result = await adapter.send({ type: 'test' });
    expect(result).toMatchObject({
      ok: false,
      version: '0.0.1',
      message: expect.stringContaining(
        `codex 0.0.1 cannot describe its app-server protocol ("codex app-server generate-json-schema" failed: error: unrecognized subcommand 'generate-json-schema')`,
      ),
      update: {
        method: 'manual',
        instruction: expect.stringContaining('/opt/codex/bin/codex'),
      },
    });
  });

  it('passes Test on a newer compatible codex without offering an update', async () => {
    const { adapter } = setup(() => new ScriptedCodex(testAnswers('999.0.0')));
    await expect(adapter.send({ type: 'test' })).resolves.toMatchObject({
      ok: true,
      version: '999.0.0',
      message: `codex 999.0.0 differs from the tested ${codexProtocolVersion}; compatible.`,
      update: null,
    });
  });

  it('fails the running turn when the app-server exits and resumes the thread in a new one', async () => {
    const { adapter, take, processes, current } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send(startTurn);
    take();
    current().exit('codex app-server exited (code 3): panic');
    expect(processes[0]?.killed).toBe(true);
    expect(take()).toEqual([
      {
        type: 'turnFailed',
        threadId: 'thread-1',
        error: 'codex app-server exited (code 3): panic',
      },
    ]);

    await adapter.send(startTurn);
    expect(adapter.starts).toBe(2);
    expect(written(current(), 'thread/start')).toBeUndefined();
    expect(written(current(), 'thread/resume')?.['params']).toMatchObject({
      threadId: 'codex-thread',
      cwd: '/work/demo',
      excludeTurns: true,
    });
    expect(take()).toEqual([
      { type: 'session', threadId: 'thread-1', providerSessionId: 'codex-thread' },
    ]);
  });

  it('resumes a stored session id after an app restart', async () => {
    const { adapter, current } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send({ ...startTurn, resumeId: 'stored-session' });
    expect(written(current(), 'thread/resume')?.['params']).toMatchObject({
      threadId: 'stored-session',
    });
  });

  it('reports a failed turn with the error codex gave', async () => {
    const { adapter, take, current } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send(startTurn);
    take();
    current().emit({
      method: 'error',
      params: {
        error: { message: 'Quota exceeded', additionalDetails: null },
        willRetry: false,
        threadId: 'codex-thread',
        turnId: 'turn-1',
      },
    });
    current().emit({
      method: 'turn/completed',
      params: { threadId: 'codex-thread', turn: { id: 'turn-1', status: 'failed', error: null } },
    });
    expect(take()).toEqual([{ type: 'turnFailed', threadId: 'thread-1', error: 'Quota exceeded' }]);
  });

  it('sends a sandbox policy only when the permission mode changed since the thread started', async () => {
    const { adapter, current } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send(startTurn);
    current().emit({
      method: 'turn/completed',
      params: {
        threadId: 'codex-thread',
        turn: { id: 'turn-1', status: 'completed', error: null },
      },
    });
    await expect(
      adapter.send({
        type: 'setPermissionMode',
        threadId: 'thread-1',
        permissionMode: 'read-only',
      }),
    ).resolves.toEqual({ appliesTo: 'nextTurn' });
    await adapter.send({ ...startTurn, permissionMode: 'read-only', model: 'gpt-6.1-mini' });
    const turns = current().written.filter((message) => message['method'] === 'turn/start');
    expect(turns[0]?.['params']).not.toHaveProperty('sandboxPolicy');
    expect(turns[1]?.['params']).toMatchObject({
      model: 'gpt-6.1-mini',
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
  });

  it('rejects an unknown permission mode and reports the turn as failed', async () => {
    const { adapter, take } = setup(() => new ScriptedCodex(baseAnswers));
    await expect(adapter.send({ ...startTurn, permissionMode: 'yolo' })).rejects.toMatchObject({
      code: 'state',
      message: expect.stringContaining('read-only, auto, untrusted, full-access'),
    });
    expect(take()).toEqual([expect.objectContaining({ type: 'turnFailed', threadId: 'thread-1' })]);
  });

  it('times out a request codex does not answer and starts a fresh app-server next time', async () => {
    let wrote: ((method: unknown) => void) | null = null;
    // Silent app-server that tells the test when the adapter wrote to it.
    class Silent extends FakeCodexProcess {
      protected override received(message: Record<string, unknown>): void {
        wrote?.(message['method']);
      }
    }
    const nextWrite = () => new Promise((resolve) => (wrote = resolve));
    const { adapter, timers, processes } = setup(() => new Silent());
    let writing = nextWrite();
    const turn = adapter.send(startTurn);
    await expect(writing).resolves.toBe('initialize');
    timers.fireAll();
    await expect(turn).rejects.toMatchObject({
      code: 'timeout',
      message: 'codex did not answer "initialize" within 30000 ms',
    });
    expect(processes[0]?.killed).toBe(true);
    writing = nextWrite();
    const again = adapter.send({ type: 'listModels' });
    await writing;
    expect(adapter.starts).toBe(2);
    timers.fireAll();
    await expect(again).rejects.toMatchObject({ code: 'timeout' });
    expect(timers.pending).toBe(0);
  });

  it('declines server requests it does not handle so codex does not wait', async () => {
    const { adapter, current } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send(startTurn);
    current().emit({
      id: 7,
      method: 'mcpServer/elicitation/request',
      params: { threadId: 'codex-thread' },
    });
    expect(current().written.at(-1)).toEqual({
      id: 7,
      error: { code: -32601, message: 'wow does not handle mcpServer/elicitation/request' },
    });
  });

  it('grants or withholds requested permissions', async () => {
    const { adapter, take, current } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send(startTurn);
    take();
    const permissions = { network: { enabled: true }, fileSystem: null };
    const ask = (id: number) =>
      current().emit({
        id,
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'codex-thread',
          turnId: 'turn-1',
          itemId: 'item',
          environmentId: null,
          startedAtMs: 0,
          cwd: '/work/demo',
          reason: 'Needs network',
          permissions,
        },
      });
    ask(10);
    expect(take()).toEqual([expect.objectContaining({ kind: 'tool', summary: 'Needs network' })]);
    await adapter.send({ type: 'answerApproval', approvalId: 'id-1', decision: 'allowSession' });
    expect(current().written.at(-1)).toEqual({
      id: 10,
      result: { permissions: { network: { enabled: true } }, scope: 'session' },
    });
    ask(11);
    await adapter.send({ type: 'answerApproval', approvalId: 'id-2', decision: 'deny' });
    expect(current().written.at(-1)).toEqual({
      id: 11,
      result: { permissions: {}, scope: 'turn' },
    });
    await expect(
      adapter.send({ type: 'answerApproval', approvalId: 'id-2', decision: 'deny' }),
    ).rejects.toMatchObject({ code: 'state' });
  });

  it('forgets an approval codex resolved on its own', async () => {
    const { adapter, current } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send(startTurn);
    current().emit({
      id: 4,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'codex-thread', turnId: 'turn-1', itemId: 'p', startedAtMs: 0 },
    });
    current().emit({
      method: 'serverRequest/resolved',
      params: { threadId: 'codex-thread', requestId: 4 },
    });
    await expect(
      adapter.send({ type: 'answerApproval', approvalId: 'id-1', decision: 'allowOnce' }),
    ).rejects.toMatchObject({ code: 'state' });
  });

  it('needs resolveEnv for secret environment values', async () => {
    const secretInstance = { ...instance, env: { OPENAI_API_KEY: { secretRef: 'openai' } } };
    const blocked = setup(() => new ScriptedCodex(baseAnswers), { instance: secretInstance });
    await expect(blocked.adapter.send({ type: 'listModels' })).rejects.toMatchObject({
      message: expect.stringContaining('OPENAI_API_KEY'),
    });
    const resolved = setup(
      () =>
        new ScriptedCodex({ ...baseAnswers, 'model/list': () => ({ data: [], nextCursor: null }) }),
      {
        instance: secretInstance,
        resolveEnv: async () => ({ OPENAI_API_KEY: 'sk-test' }),
      },
    );
    await resolved.adapter.send({ type: 'listModels' });
    expect(resolved.launches[0]?.env['OPENAI_API_KEY']).toBe('sk-test');
  });

  it('ignores lines that are not JSON-RPC and notifications for other threads', async () => {
    const { adapter, take, current } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send(startTurn);
    take();
    current().emit('WARNING: proceeding, even though we could not create PATH aliases');
    current().emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'someone-else', turnId: 't', itemId: 'i', delta: 'x' },
    });
    expect(take()).toEqual([]);
  });
});

describe('codexVersionFromUserAgent', () => {
  it('reads the version after the originator', () => {
    expect(codexVersionFromUserAgent(userAgent)).toBe(codexProtocolVersion);
    expect(codexVersionFromUserAgent('codex_cli_rs/0.167.0-alpha.1 (Windows 11)')).toBe(
      '0.167.0-alpha.1',
    );
    expect(codexVersionFromUserAgent('unknown')).toBeNull();
  });
});
