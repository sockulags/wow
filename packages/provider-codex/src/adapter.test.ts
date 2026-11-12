import type { ProviderEvent, ProviderInstance } from '@wow/contracts';
import {
  ProviderEvent as ProviderEventSchema,
  ProviderModel,
  providerChatOptions,
} from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import {
  fileChangeDiff,
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

describe('fileChangeDiff (agent workbench spec 33)', () => {
  it('gives an update its hunks, a new file all added lines and several files their headers', () => {
    expect(
      fileChangeDiff([
        {
          path: 'a.ts',
          kind: { type: 'update', move_path: null },
          diff: '--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n',
        },
      ]),
    ).toBe('@@ -1 +1 @@\n-x\n+y');
    expect(fileChangeDiff([{ path: 'new.ts', kind: { type: 'add' }, diff: 'one\ntwo\n' }])).toBe(
      '@@ -0,0 +1,2 @@\n+one\n+two',
    );
    expect(
      fileChangeDiff([
        { path: 'new.ts', kind: { type: 'add' }, diff: 'one\n' },
        { path: 'old.ts', kind: { type: 'delete' }, diff: 'gone\n' },
      ]),
    ).toBe(
      '--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+one\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone',
    );
    // A new file whose first line only looks like a diff's is still its content.
    expect(
      fileChangeDiff([{ path: 'notes.md', kind: { type: 'add' }, diff: '--- title\nbody\n' }]),
    ).toBe('@@ -0,0 +1,2 @@\n+--- title\n+body');
    expect(
      fileChangeDiff([{ path: 'new.ts', kind: { type: 'add' }, diff: '@@ -0,0 +1 @@\n+one\n' }]),
    ).toBe('@@ -0,0 +1 @@\n+one');
    expect(fileChangeDiff([])).toBeUndefined();
  });
});

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
        kind: 'command',
        command: 'pnpm test',
        cwd: '/work/demo',
      },
      expect.objectContaining({
        type: 'approvalRequested',
        threadId,
        approvalId: 'id-1',
        kind: 'command',
        summary: 'pnpm test',
        facts: expect.objectContaining({ kind: 'command', command: 'pnpm test' }),
      }),
    ]);

    await adapter.send({ type: 'answerApproval', approvalId: 'id-1', decision: 'allowSession' });
    expect(child.written.at(-1)).toEqual({ id: 0, result: { decision: 'acceptForSession' } });
    expect(take()).toEqual([
      { type: 'toolCallOutput', threadId, itemId: 'item-command', output: '> vitest run\n' },
      { type: 'toolCallOutput', threadId, itemId: 'item-command', output: 'Tests 12 passed\n' },
      {
        type: 'toolCallCompleted',
        threadId,
        itemId: 'item-command',
        status: 'ok',
        exitCode: 0,
        durationMs: 2100,
      },
      {
        type: 'toolCallStarted',
        threadId,
        itemId: 'item-patch',
        name: 'fileChange',
        input: { changes: [{ path: 'README.md', kind: 'update' }] },
        kind: 'edit',
        path: 'README.md',
        diff: '@@ -1 +1 @@\n-# Demo\n+# Demo app',
      },
      expect.objectContaining({
        type: 'approvalRequested',
        approvalId: 'id-2',
        kind: 'fileChange',
        summary: 'Edit README.md',
        facts: { kind: 'edit', path: 'README.md', diff: '@@ -1 +1 @@\n-# Demo\n+# Demo app' },
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
      {
        type: 'toolCallCompleted',
        threadId,
        itemId: 'item-patch',
        status: 'error',
        diff: '@@ -1 +1 @@\n-# Demo\n+# Demo app',
      },
      {
        type: 'questionAsked',
        threadId,
        questionId: 'id-3',
        question: 'Which title should the README use?',
        header: 'Title',
        askId: 'item-ask',
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
        askId: 'item-ask',
        options: [],
        multiSelect: false,
      },
    ]);

    // codex takes the answers of one request together, so nothing is sent after the first.
    const writes = child.written.length;
    await expect(
      adapter.send({
        type: 'answerQuestion',
        questionId: 'id-3',
        answer: { picked: ['Demo app'], text: '' },
      }),
    ).resolves.toEqual({ ok: true, waitingFor: 1 });
    expect(child.written).toHaveLength(writes);
    await adapter.send({
      type: 'answerQuestion',
      questionId: 'id-4',
      answer: { picked: [], text: 'no' },
    });
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
      // Live tokens while the turn runs (agent workbench spec 45), then the final count.
      { type: 'usage', threadId, inputTokens: 5200, outputTokens: 310, cachedInputTokens: 4000 },
      { type: 'contextUsage', threadId, usedTokens: 5510, maxTokens: 258400 },
      expect.objectContaining({ type: 'taskListUpdated' }),
      { type: 'usage', threadId, inputTokens: 5200, outputTokens: 310, cachedInputTokens: 4000 },
      { type: 'turnCompleted', threadId },
    ]);
    expect(child.mismatches).toEqual([]);
    expect(child.remaining).toEqual([]);
  });

  // Questions spec 6: codex takes a list of answers per question; the typed text is an answer of
  // its own after the picked labels.
  it.each([
    ['a choice', { picked: ['Demo application'], text: '' }, ['Demo application']],
    ['typed text', { picked: [], text: '  Demo kit  ' }, ['Demo kit']],
    [
      'a choice and typed text',
      { picked: ['Demo app'], text: 'with a short tagline' },
      ['Demo app', 'with a short tagline'],
    ],
  ])('answers a question with choices by %s, exactly', async (_name, reply, sent) => {
    const fixture = readFixture('turn-tools.jsonl');
    const { adapter, take, current } = setup(() => new ReplayCodexProcess(fixture));
    await adapter.send(startTurn);
    await adapter.send({ type: 'answerApproval', approvalId: 'id-1', decision: 'allowOnce' });
    await adapter.send({ type: 'answerApproval', approvalId: 'id-2', decision: 'deny' });
    const asked = take().filter((event) => event.type === 'questionAsked');
    expect(asked.map((event) => event.questionId)).toEqual(['id-3', 'id-4']);
    await adapter.send({ type: 'answerQuestion', questionId: 'id-3', answer: reply });
    await adapter.send({
      type: 'answerQuestion',
      questionId: 'id-4',
      answer: { picked: [], text: 'no' },
    });
    const child = current() as ReplayCodexProcess;
    expect(child.written.at(-1)).toEqual({
      id: 2,
      result: { answers: { title: { answers: sent }, badge: { answers: ['no'] } } },
    });
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

  // Agent workbench spec 51, 60: Codex takes no message into a running turn, so it waits for
  // the turn to end, and Codex reports no slash commands of its own.
  it('takes no message into a running turn and lists no commands', async () => {
    const { adapter } = setup(() => new ReplayCodexProcess([]));
    expect(await adapter.send({ type: 'handOver', threadId: 't1', prompt: 'Then this' })).toEqual({
      taken: false,
    });
    expect(await adapter.send({ type: 'listCommands', cwd: '/work/demo' })).toEqual([]);
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

  // Agent workbench spec 7, 8: description, default effort, default flag and image input come
  // from model/list; a hidden model is left out; a field this codex does not send stays absent.
  it('lists the model fields codex reports and leaves out hidden models', async () => {
    const { adapter } = setup(
      () =>
        new ScriptedCodex({
          ...baseAnswers,
          'model/list': () => ({
            data: [
              withInputs('a', ['text', 'image']),
              withInputs('b', ['text']),
              model('c'),
              withInputs('secret', ['text', 'image']),
            ].map((entry) => (entry.id === 'secret' ? { ...entry, hidden: true } : entry)),
            nextCursor: null,
          }),
        }),
    );
    const models = ProviderModel.array().parse(await adapter.send({ type: 'listModels' }));
    expect(models).toEqual([
      {
        id: 'a',
        label: 'A',
        description: 'a model',
        efforts: ['low'],
        defaultEffort: 'low',
        isDefault: true,
        imageInput: true,
      },
      expect.objectContaining({ id: 'b', isDefault: false, imageInput: false }),
      expect.objectContaining({ id: 'c' }),
    ]);
    expect(models[2]).not.toHaveProperty('imageInput');
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

const withInputs = (id: string, inputModalities: string[]) => ({ ...model(id), inputModalities });

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

// A release whose thread/start and thread/resume also take what a tools-only thread sends.
const withOptions = (method: 'thread/start' | 'thread/resume') => {
  const entry = codexProtocolFingerprint.methods[method];
  if (!entry) throw new Error(`no ${method} in the fingerprint`);
  return {
    ...entry,
    params: [
      ...entry.params,
      { path: 'config', shape: { type: 'object', required: false, nullable: true } },
      {
        path: 'developerInstructions',
        shape: { type: 'string', required: false, nullable: true },
      },
    ],
  } as const;
};

describe('CodexAdapter', () => {
  // Questions and models spec 13, 17: every step on Codex names a model, and the copy of that
  // fact in contracts agrees.
  it('requires a model on a step', () => {
    const { adapter } = setup(() => new ScriptedCodex(baseAnswers));
    expect(adapter.requiresModel).toBe(true);
    expect(providerChatOptions.codex.requiresModel).toBe(adapter.requiresModel);
  });

  // Agent workbench spec 53: Codex reads the image files wow stored, as `localImage` inputs
  // after the text; a message of images only sends no empty text.
  it('sends the images of a message as localImage inputs @agent-workbench-53', async () => {
    const { adapter, current } = setup(() => new ScriptedCodex(baseAnswers));
    const shot = '/home/demo/.wow/images/thread-1/0f8fad5b-d9cb-469f-a165-70867728950e.png';
    await adapter.send({
      ...startTurn,
      prompt: 'What is wrong here?',
      images: [{ path: shot, mediaType: 'image/png' }],
    });
    expect(written(current(), 'turn/start')?.['params']).toMatchObject({
      input: [
        { type: 'text', text: 'What is wrong here?', text_elements: [] },
        { type: 'localImage', path: shot },
      ],
    });
    await adapter.send({
      ...startTurn,
      threadId: 'thread-2',
      prompt: '',
      images: [{ path: shot, mediaType: 'image/png' }],
    });
    const turns = current().written.filter((message) => message['method'] === 'turn/start');
    expect(turns.at(-1)?.['params']).toMatchObject({ input: [{ type: 'localImage', path: shot }] });
  });

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

  const assistantTurn = {
    ...startTurn,
    threadId: 'assistant',
    cwd: '/home/demo/.wow/assistant',
    prompt: 'Set my work hours to 8 to 4',
    permissionMode: 'full-access',
    toolset: { name: 'wow', url: 'http://127.0.0.1:4317/assistant/mcp', token: 'invented-token' },
    instructions: 'You operate wow only.',
  } as const;
  const toolsOnlySettings = {
    cwd: '/home/demo/.wow/assistant',
    model: 'gpt-6.1-sol',
    // Whatever mode the turn names: nothing is written, nothing leaves, nobody is asked.
    approvalPolicy: 'never',
    sandbox: 'read-only',
    config: {
      mcp_servers: {
        wow: {
          url: 'http://127.0.0.1:4317/assistant/mcp',
          http_headers: { Authorization: 'Bearer invented-token' },
        },
      },
      web_search: 'disabled',
      // Codex's own tools that have a switch: commands, images, subagents, goals, apps, image
      // generation, computer and browser use, plugins, skill search, tool suggestions, sleep,
      // code mode, and the user's hooks; and questions to the user.
      features: {
        shell_tool: false,
        unified_exec: false,
        view_image: false,
        multi_agent: false,
        goals: false,
        apps: false,
        image_generation: false,
        computer_use: false,
        browser_use: false,
        browser_use_external: false,
        in_app_browser: false,
        plugins: false,
        remote_plugin: false,
        skill_search: false,
        tool_suggest: false,
        sleep_tool: false,
        code_mode_host: false,
        hooks: false,
      },
      tools: { experimental_request_user_input: { enabled: false } },
      // A command the agent runs sees none of the variables of wow or the instance.
      shell_environment_policy: { inherit: 'none' },
    },
    developerInstructions: 'You operate wow only.',
  };

  it('starts an assistant thread with the wow MCP server, a read-only sandbox without network and the given folder', async () => {
    const { adapter, current } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send(assistantTurn);
    expect(written(current(), 'thread/start')?.['params']).toEqual(toolsOnlySettings);
    expect(written(current(), 'turn/start')?.['params']).toEqual({
      threadId: 'codex-thread',
      input: [{ type: 'text', text: 'Set my work hours to 8 to 4', text_elements: [] }],
      cwd: '/home/demo/.wow/assistant',
      model: 'gpt-6.1-sol',
      effort: 'medium',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
  });

  it('resumes an assistant thread with the same tools-only settings', async () => {
    const { adapter, current } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send({ ...assistantTurn, resumeId: 'stored-session' });
    expect(written(current(), 'thread/start')).toBeUndefined();
    expect(written(current(), 'thread/resume')?.['params']).toEqual({
      threadId: 'stored-session',
      ...toolsOnlySettings,
      excludeTurns: true,
    });
  });

  it('declines every approval an assistant thread asks for, without asking the user', async () => {
    const { adapter, current, take } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send(assistantTurn);
    take();
    const ask = (id: number, method: string, params: Record<string, unknown>) =>
      current().emit({
        id,
        method,
        params: { threadId: 'codex-thread', turnId: 'turn-1', ...params },
      });
    ask(71, 'item/commandExecution/requestApproval', { itemId: 'c1', command: 'cat ~/.ssh/id' });
    ask(72, 'item/fileChange/requestApproval', { itemId: 'f1' });
    ask(73, 'item/permissions/requestApproval', {
      itemId: 'p1',
      permissions: { network: { enabled: true } },
    });
    const answers = current().written.filter((message) => !('method' in message));
    expect(answers).toEqual([
      { id: 71, result: { decision: 'decline' } },
      { id: 72, result: { decision: 'decline' } },
      { id: 73, result: { permissions: {}, scope: 'turn' } },
    ]);
    expect(take()).toEqual([]);
  });

  it('never turns an assistant thread into an ordinary one', async () => {
    const { adapter, current } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send(assistantTurn);
    current().emit({
      method: 'turn/completed',
      params: {
        threadId: 'codex-thread',
        turn: { id: 'turn-1', status: 'completed', error: null },
      },
    });
    await expect(adapter.send({ ...startTurn, threadId: 'assistant' })).rejects.toThrow(
      /app's tools only/,
    );
  });

  it('forgets a closed thread, so its next turn starts from what the command says', async () => {
    const { adapter, current } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send(assistantTurn);
    current().emit({
      method: 'turn/completed',
      params: {
        threadId: 'codex-thread',
        turn: { id: 'turn-1', status: 'completed', error: null },
      },
    });
    await expect(adapter.send({ type: 'closeThread', threadId: 'assistant' })).resolves.toEqual({
      closed: true,
    });
    await expect(adapter.send({ type: 'closeThread', threadId: 'assistant' })).resolves.toEqual({
      closed: false,
    });
    const starts = () =>
      current().written.filter((message) => message['method'] === 'thread/start');
    expect(starts()).toHaveLength(1);
    await adapter.send(assistantTurn);
    expect(starts()).toHaveLength(2);
    expect(written(current(), 'thread/resume')).toBeUndefined();
  });

  it('fails the assistant with a clear sentence on a codex that cannot take the MCP server', async () => {
    // The tested fingerprint describes what an ordinary thread sends: a codex with exactly that
    // has no `config` and no `developerInstructions` on thread/start.
    const schema = fakeSchema({ ...codexProtocolFingerprint, codexVersion: '0.0.1' });
    const { adapter, current, take } = setup(() => new ScriptedCodex(testAnswers('0.0.1')), {
      generateSchema: schema.generate,
    });
    const sentence = `codex 0.0.1 cannot be given wow's tools when a thread starts (it has no thread/start params.config, thread/start params.developerInstructions, thread/resume params.config, thread/resume params.developerInstructions), so the assistant cannot run on it. Update codex to ${codexProtocolVersion}.`;
    await expect(adapter.send(assistantTurn)).rejects.toThrow(sentence);
    expect(take()).toEqual([{ type: 'turnFailed', threadId: 'assistant', error: sentence }]);
    expect(written(current(), 'thread/start')).toBeUndefined();
    // Asked once per version; an ordinary thread still starts on this codex.
    await expect(adapter.send(assistantTurn)).rejects.toThrow(sentence);
    expect(schema.runs).toHaveLength(1);
    await adapter.send(startTurn);
    expect(written(current(), 'thread/start')?.['params']).toEqual({
      cwd: '/work/demo',
      model: 'gpt-6.1-sol',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
  });

  it('starts the assistant on another codex version whose schema has the options', async () => {
    const schema = fakeSchema({
      codexVersion: '0.0.1',
      methods: {
        ...codexProtocolFingerprint.methods,
        'thread/start': withOptions('thread/start'),
        'thread/resume': withOptions('thread/resume'),
      },
    });
    const { adapter, current } = setup(() => new ScriptedCodex(testAnswers('0.0.1')), {
      generateSchema: schema.generate,
    });
    await adapter.send(assistantTurn);
    expect(written(current(), 'thread/start')?.['params']).toEqual(toolsOnlySettings);
  });

  it('sends an ordinary thread exactly the settings it always had', async () => {
    const { adapter, current } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send(startTurn);
    expect(written(current(), 'thread/start')?.['params']).toEqual({
      cwd: '/work/demo',
      model: 'gpt-6.1-sol',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
    expect(written(current(), 'turn/start')?.['params']).toEqual({
      threadId: 'codex-thread',
      input: [{ type: 'text', text: 'Run the tests and fix the README', text_elements: [] }],
      cwd: '/work/demo',
      model: 'gpt-6.1-sol',
      effort: 'medium',
      approvalPolicy: 'on-request',
    });
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

  it('shows a command request with its folder and words the rule from the amendment codex proposes (spec 36, 38), and declines without a note (spec 37)', async () => {
    const { adapter, current, take } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send(startTurn);
    take();
    current().emit({
      id: 12,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'codex-thread',
        turnId: 'turn-1',
        itemId: 'c',
        startedAtMs: 0,
        environmentId: null,
        command: 'pnpm test --watch',
        cwd: '/work/demo/app',
        proposedExecpolicyAmendment: ['pnpm', 'test'],
      },
    });
    expect(take()).toEqual([
      expect.objectContaining({
        kind: 'command',
        facts: {
          kind: 'command',
          command: 'pnpm test --watch',
          cwd: '/work/demo/app',
          ruleHint: 'pnpm test',
        },
      }),
    ]);
    await adapter.send({
      type: 'answerApproval',
      approvalId: 'id-1',
      decision: 'deny',
      note: 'Run it once, not in watch mode.',
    });
    expect(current().written.at(-1)).toEqual({ id: 12, result: { decision: 'decline' } });
  });

  it('shows the command inside the shell line codex runs, keeping the line in the request', async () => {
    const { adapter, current, take } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send(startTurn);
    take();
    const params = {
      threadId: 'codex-thread',
      turnId: 'turn-1',
      itemId: 'c',
      startedAtMs: 0,
      environmentId: null,
      cwd: '/work/demo/app',
      commandActions: [{ type: 'unknown', command: 'pnpm test --watch' }],
    };
    current().emit({
      id: 13,
      method: 'item/commandExecution/requestApproval',
      params: { ...params, command: "/bin/zsh -lc 'pnpm test --watch'" },
    });
    current().emit({
      id: 14,
      method: 'item/commandExecution/requestApproval',
      params: { ...params, command: '/bin/zsh -lc "pnpm test && rm -rf ~"' },
    });
    const [wrapped, chained] = take();
    expect(wrapped).toMatchObject({
      facts: { kind: 'command', command: 'pnpm test --watch' },
      request: { command: "/bin/zsh -lc 'pnpm test --watch'" },
    });
    expect(chained).toMatchObject({ facts: { command: 'pnpm test && rm -rf ~' } });
    await adapter.send({ type: 'answerApproval', approvalId: 'id-1', decision: 'allowOnce' });
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

  // Should codex go on with a thread by itself, its turn is a turn of the thread like Claude's.
  it('reports a turn codex starts without a turn/start', async () => {
    const { adapter, take, current } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send(startTurn);
    current().emit({
      method: 'turn/completed',
      params: {
        threadId: 'codex-thread',
        turn: { id: 'turn-1', status: 'completed', error: null },
      },
    });
    take();
    current().emit({
      method: 'turn/started',
      params: {
        threadId: 'codex-thread',
        turn: { id: 'turn-2', status: 'inProgress', error: null },
      },
    });
    current().emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'codex-thread', turnId: 'turn-2', itemId: 'm2', delta: 'Done.' },
    });
    current().emit({
      method: 'turn/completed',
      params: {
        threadId: 'codex-thread',
        turn: { id: 'turn-2', status: 'completed', error: null },
      },
    });
    expect(take()).toEqual([
      { type: 'turnStartedByProvider', threadId: 'thread-1' },
      { type: 'textDelta', threadId: 'thread-1', itemId: 'm2', delta: 'Done.' },
      { type: 'turnCompleted', threadId: 'thread-1' },
    ]);
  });

  it('gives a failed command its exit code and time, and an MCP call its server and tool (agent workbench spec 27, 29)', async () => {
    const { adapter, take, current } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send(startTurn);
    take();
    const command = {
      type: 'commandExecution',
      id: 'cmd-1',
      pluginId: null,
      scriptPath: null,
      command: 'pnpm test',
      cwd: '/work/demo/app',
      processId: null,
      source: 'agent',
      commandActions: [{ type: 'unknown', command: 'pnpm test' }],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
      status: 'inProgress',
    };
    const mcp = {
      type: 'mcpToolCall',
      id: 'mcp-1',
      server: 'tracker',
      tool: 'find_issue',
      status: 'inProgress',
      arguments: { key: 'DEMO-42' },
      appContext: null,
      mcpAppUi: null,
      pluginId: null,
      readOnlyHint: null,
      result: null,
      error: null,
      durationMs: null,
    };
    const params = { threadId: 'codex-thread', turnId: 'turn-1' };
    current().emit({ method: 'item/started', params: { ...params, item: command } });
    current().emit({
      method: 'item/completed',
      params: {
        ...params,
        item: {
          ...command,
          status: 'failed',
          aggregatedOutput: '1 test failed\n',
          exitCode: 1,
          durationMs: 4200,
        },
      },
    });
    current().emit({ method: 'item/started', params: { ...params, item: mcp } });
    expect(take()).toEqual([
      {
        type: 'toolCallStarted',
        threadId: 'thread-1',
        itemId: 'cmd-1',
        name: 'command',
        input: { command: 'pnpm test', cwd: '/work/demo/app' },
        kind: 'command',
        command: 'pnpm test',
        cwd: '/work/demo/app',
      },
      { type: 'toolCallOutput', threadId: 'thread-1', itemId: 'cmd-1', output: '1 test failed\n' },
      {
        type: 'toolCallCompleted',
        threadId: 'thread-1',
        itemId: 'cmd-1',
        status: 'error',
        exitCode: 1,
        durationMs: 4200,
      },
      {
        type: 'toolCallStarted',
        threadId: 'thread-1',
        itemId: 'mcp-1',
        name: 'tracker/find_issue',
        input: { key: 'DEMO-42' },
        kind: 'mcp',
        server: 'tracker',
        tool: 'find_issue',
      },
    ]);
  });

  // Agent workbench spec 44: a spawned agent is a subagent row with its prompt and state; the
  // calls that report on it (wait) give its state and final message to that row. What the
  // agent's own thread sends, where it reaches wow, is nested under the row.
  it('shows a collab agent call with its prompt, state and final message, nesting its own calls', async () => {
    const { adapter, take, current } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send(startTurn);
    take();
    const spawn = {
      type: 'collabAgentToolCall',
      id: 'spawn-1',
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: 'codex-thread',
      receiverThreadIds: [],
      prompt: 'Explore the auth code and say where login is checked.',
      model: null,
      reasoningEffort: null,
      agentsStates: {},
    };
    const params = { threadId: 'codex-thread', turnId: 'turn-1' };
    current().emit({ method: 'item/started', params: { ...params, item: spawn } });
    current().emit({
      method: 'item/completed',
      params: {
        ...params,
        item: {
          ...spawn,
          status: 'completed',
          receiverThreadIds: ['agent-thread'],
          agentsStates: { 'agent-thread': { status: 'pendingInit', message: null } },
        },
      },
    });
    const agentParams = { threadId: 'agent-thread', turnId: 'agent-turn' };
    const read = {
      type: 'commandExecution',
      id: 'cmd-1',
      pluginId: null,
      scriptPath: null,
      command: 'rg login src',
      cwd: '/work/demo',
      processId: null,
      source: 'agent',
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
      status: 'inProgress',
    };
    current().emit({ method: 'item/started', params: { ...agentParams, item: read } });
    current().emit({
      method: 'item/completed',
      params: {
        ...agentParams,
        item: { ...read, status: 'completed', aggregatedOutput: 'src/auth.ts\n', exitCode: 0 },
      },
    });
    const wait = {
      ...spawn,
      id: 'wait-1',
      tool: 'wait',
      status: 'completed',
      receiverThreadIds: ['agent-thread'],
      prompt: null,
      agentsStates: {
        'agent-thread': { status: 'completed', message: 'Login is checked in src/auth.ts.' },
      },
    };
    current().emit({
      method: 'item/started',
      params: { ...params, item: { ...wait, status: 'inProgress' } },
    });
    current().emit({ method: 'item/completed', params: { ...params, item: wait } });
    // A closed agent that had finished stays finished.
    current().emit({
      method: 'item/completed',
      params: {
        ...params,
        item: {
          ...wait,
          id: 'close-1',
          tool: 'closeAgent',
          agentsStates: { 'agent-thread': { status: 'shutdown', message: null } },
        },
      },
    });
    expect(take()).toEqual([
      {
        type: 'toolCallStarted',
        threadId: 'thread-1',
        itemId: 'spawn-1',
        name: 'spawnAgent',
        input: { prompt: spawn.prompt, model: null },
        kind: 'subagent',
        prompt: spawn.prompt,
      },
      {
        type: 'toolCallCompleted',
        threadId: 'thread-1',
        itemId: 'spawn-1',
        status: 'ok',
        agentState: 'starting',
      },
      expect.objectContaining({
        type: 'toolCallStarted',
        itemId: 'agent-thread:cmd-1',
        kind: 'command',
        parentItemId: 'spawn-1',
      }),
      {
        type: 'toolCallOutput',
        threadId: 'thread-1',
        itemId: 'agent-thread:cmd-1',
        output: 'src/auth.ts\n',
      },
      {
        type: 'toolCallCompleted',
        threadId: 'thread-1',
        itemId: 'agent-thread:cmd-1',
        status: 'ok',
        exitCode: 0,
      },
      {
        type: 'toolCallCompleted',
        threadId: 'thread-1',
        itemId: 'spawn-1',
        status: 'ok',
        agentState: 'done',
        answer: 'Login is checked in src/auth.ts.',
      },
    ]);
    expect(providerChatOptions.codex.stopsTasks).toBe(false);
    await expect(
      adapter.send({ type: 'stopTask', threadId: 'thread-1', taskId: 'x' }),
    ).rejects.toThrow(/Codex cannot/);
  });

  // The fallback where nothing of the agent's own thread reaches wow: the row alone.
  it('shows a failed collab agent without a nested list when its thread sends nothing', async () => {
    const { adapter, take, current } = setup(() => new ScriptedCodex(baseAnswers));
    await adapter.send(startTurn);
    take();
    const params = { threadId: 'codex-thread', turnId: 'turn-1' };
    current().emit({
      method: 'item/completed',
      params: {
        ...params,
        item: {
          type: 'collabAgentToolCall',
          id: 'spawn-2',
          tool: 'spawnAgent',
          status: 'failed',
          senderThreadId: 'codex-thread',
          receiverThreadIds: ['agent-2'],
          prompt: 'Count the leaves.',
          model: null,
          reasoningEffort: null,
          agentsStates: { 'agent-2': { status: 'errored', message: 'No leaves found.' } },
        },
      },
    });
    expect(take()).toEqual([
      {
        type: 'toolCallCompleted',
        threadId: 'thread-1',
        itemId: 'spawn-2',
        status: 'error',
        agentState: 'failed',
        answer: 'No leaves found.',
      },
    ]);
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
