import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  ProviderCommand,
  ProviderInstance,
  ProviderToolset,
  ServerCommand,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approvals,
  providerInstances,
  questions,
  threadItems,
  threads,
  turns,
} from '../db/schema.js';
import { MockProviderAdapter } from '../hooks/index.js';
import { startServer, type RunningServer } from '../server.js';

// Agent orchestration U1 (spec 1, Security): a chat thread's turn carries wow's helper tools, and
// the helper endpoint answers only that thread's token while the thread may have them. All
// invented.

let root: string;
let server: RunningServer;
let adapters: MockProviderAdapter[];
let commandCount = 0;

const instance: ProviderInstance = {
  id: 'claude-work',
  kind: 'claude',
  name: 'claude-work',
  binaryPath: 'claude',
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: 'opus',
  defaultEffort: 'high',
  defaultPermissionMode: 'default',
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
};

const codex: ProviderInstance = {
  ...instance,
  id: 'codex-work',
  kind: 'codex',
  name: 'Codex at work',
  binaryPath: 'codex',
  defaultModel: 'gpt-6.1-sol',
  defaultEffort: 'medium',
  defaultPermissionMode: 'auto',
};

// The invented agents: "wait" keeps the turn running until it is stopped, and "approve" asks for
// an approval to run the tests.
const script = (command: ProviderCommand) => {
  if (command.type === 'interrupt')
    return [{ type: 'turnInterrupted' as const, threadId: command.threadId }];
  if (command.type !== 'startTurn') return [];
  if (/^approve/i.test(command.prompt)) {
    return [
      {
        type: 'approvalRequested' as const,
        threadId: command.threadId,
        approvalId: `${command.threadId}-approval`,
        kind: 'command' as const,
        summary: 'pnpm test',
        request: { command: 'pnpm test' },
      },
    ];
  }
  if (/which port/i.test(command.prompt)) {
    return [
      {
        type: 'questionAsked' as const,
        threadId: command.threadId,
        questionId: 'port',
        question: 'Which port?',
        options: [{ label: '4317' }, { label: '8080' }],
        multiSelect: false,
      },
    ];
  }
  return [
    {
      type: 'textDelta' as const,
      threadId: command.threadId,
      itemId: `${command.threadId}-a`,
      delta: 'Done',
    },
    ...(/wait/i.test(command.prompt)
      ? []
      : [{ type: 'turnCompleted' as const, threadId: command.threadId }]),
  ];
};

const dispatch = (command: ServerCommand) =>
  server.engine.dispatch(`test-${(commandCount += 1)}`, command);

const create = (threadId: string, projectId?: string) =>
  dispatch({
    type: 'thread.create',
    threadId,
    providerInstanceId: 'claude-work',
    ...(projectId ? { projectId } : {}),
    cwd: root,
    title: `Thread ${threadId}`,
    model: 'opus',
    effort: 'high',
    permissionMode: 'default',
  });

// Resolves on the commit after which the thread's last turn has ended: no sleeping or polling.
function turnEnds(threadId: string) {
  return new Promise<void>((resolve) => {
    const check = () => {
      const turn = server.database.db
        .select()
        .from(turns)
        .where(eq(turns.threadId, threadId))
        .all()
        .at(-1);
      if (turn && turn.state !== 'running') {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = server.engine.onCommit(check);
    check();
  });
}

async function turnOf(
  threadId: string,
  text = 'Look at the timer',
): Promise<Extract<ProviderCommand, { type: 'startTurn' }>> {
  dispatch({ type: 'thread.sendMessage', threadId, text });
  await turnEnds(threadId);
  await server.providerService.idle();
  const sent = adapters
    .flatMap((adapter) => adapter.sent)
    .filter(
      (command): command is Extract<ProviderCommand, { type: 'startTurn' }> =>
        command.type === 'startTurn' && command.threadId === threadId,
    )
    .at(-1);
  if (!sent) throw new Error(`no turn of ${threadId}`);
  return sent;
}

const startTurnsOf = (threadId: string) =>
  adapters
    .flatMap((adapter) => adapter.sent)
    .filter(
      (command): command is Extract<ProviderCommand, { type: 'startTurn' }> =>
        command.type === 'startTurn' && command.threadId === threadId,
    );

const threadRow = (threadId: string) =>
  server.database.db.select().from(threads).where(eq(threads.id, threadId)).get();

// A tool's answer as the agent reads it.
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const answer = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  return {
    isError: answer.isError === true,
    value: JSON.parse(answer.content[0]?.text ?? 'null') as Record<string, unknown>,
  };
}

// Resolves once the helper's first turn has gone out to its provider.
async function helperStarted(helperId: string) {
  await new Promise<void>((resolve) => {
    const check = () => {
      const turn = server.database.db
        .select()
        .from(turns)
        .where(eq(turns.threadId, helperId))
        .get();
      if (turn) {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = server.engine.onCommit(check);
    check();
  });
  await server.providerService.idle();
}

const listTools = (token: string | null, url: string) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

async function connect(tools: ProviderToolset): Promise<Client> {
  const client = new Client({ name: 'helper-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(tools.url), {
      requestInit: { headers: { authorization: `Bearer ${tools.token}` } },
    }),
  );
  return client;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'wow helper tools ')));
  adapters = [];
  server = await startServer({
    home: path.join(root, 'wow home'),
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: path.join(root, 'user'),
    watchSkills: () => ({ close: () => Promise.resolve() }),
    hooks: {
      providers: {
        claude: (row) => {
          const adapter = new MockProviderAdapter(row.kind, script);
          adapters.push(adapter);
          return adapter;
        },
        codex: (row) => {
          const adapter = new MockProviderAdapter(row.kind, script);
          adapters.push(adapter);
          return adapter;
        },
      },
    },
  });
  server.database.db.insert(providerInstances).values([instance, codex]).run();
  dispatch({ type: 'project.create', projectId: 'tea', name: 'Tea', cwd: root });
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('helper tools in a chat session (orchestration spec 1)', () => {
  it("gives a chat thread's turn the helper tools, the same token every turn, on the wow port", async () => {
    create('t1', 'tea');
    const first = await turnOf('t1');
    expect(first.helperTools).toMatchObject({
      name: 'wow',
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/threads\/mcp$/),
    });
    expect(first.toolset).toBeUndefined();
    const second = await turnOf('t1');
    expect(second.helperTools).toEqual(first.helperTools);
    create('t2', 'tea');
    expect((await turnOf('t2')).helperTools?.token).not.toBe(first.helperTools?.token);
  });

  it('answers the thread token with the tools, and nothing else at all', async () => {
    create('t1', 'tea');
    const tools = (await turnOf('t1')).helperTools;
    if (!tools) throw new Error('no helper tools');
    const client = await connect(tools);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'start_helper',
      'list_helpers',
      'read_helper',
      'merge_helpers',
      'write_to_helper',
      'answer_helper_question',
      'stop_helper',
    ]);
    await client.close();
    expect((await listTools(null, tools.url)).status).toBe(401);
    expect((await listTools('wrong', tools.url)).status).toBe(401);
    // Neither the app's own token nor the assistant's opens it.
    expect((await listTools(server.token, tools.url)).status).toBe(401);
    expect((await listTools(server.assistant.token, tools.url)).status).toBe(401);
    // Nor does the thread's token open the assistant's tools.
    expect((await listTools(tools.token, server.assistant.url)).status).toBe(401);
  });

  it('gives a thread without a project the tools too (orchestrator threads spec 3)', async () => {
    create('t1');
    expect((await turnOf('t1')).helperTools).toMatchObject({ name: 'wow' });
  });

  it("gives a workflow step's thread none", async () => {
    create('t1', 'tea');
    server.database.db.update(threads).set({ runId: 'run-1' }).where(eq(threads.id, 't1')).run();
    expect((await turnOf('t1')).helperTools).toBeUndefined();
  });
});

// A main thread on Claude in Accept edits, and a client of its helper tools.
async function mainThread() {
  create('t1', 'tea');
  dispatch({ type: 'thread.configure', threadId: 't1', permissionMode: 'acceptEdits' });
  const tools = (await turnOf('t1')).helperTools;
  if (!tools) throw new Error('no helper tools');
  return connect(tools);
}

describe('helper threads (orchestration spec 2 to 8)', () => {
  it('starts a Codex helper from a Claude thread in its folder, with the brief and no wider mode', async () => {
    const client = await mainThread();
    const started = await call(client, 'start_helper', {
      brief: 'Review the timer change\nLook at src/timer.ts only.',
      instance: 'Codex at work',
    });
    expect(started).toMatchObject({
      isError: false,
      value: { title: 'Review the timer change', isolation: 'folder', started: true },
    });
    const helperId = String(started.value['id']);
    await helperStarted(helperId);
    await turnEnds(helperId);
    expect(threadRow(helperId)).toMatchObject({
      parentThreadId: 't1',
      startedBy: 'helper',
      providerInstanceId: 'codex-work',
      cwd: root,
      model: 'gpt-6.1-sol',
      effort: 'medium',
      // Accept edits on Claude reaches as far as Auto on Codex.
      permissionMode: 'auto',
    });
    const [turn] = startTurnsOf(helperId);
    expect(turn).toMatchObject({
      prompt: 'Review the timer change\nLook at src/timer.ts only.',
      cwd: root,
    });
    // Above the deepest level a helper has helper tools of its own (orchestrator threads spec 4).
    expect(turn?.helperTools).toMatchObject({ name: 'wow' });
    const row = server.database.db
      .select()
      .from(threadItems)
      .where(eq(threadItems.threadId, 't1'))
      .all()
      .find((item) => item.kind === 'helper_started');
    expect(row?.payload).toMatchObject({
      helperThreadId: helperId,
      title: 'Review the timer change',
      instanceName: 'Codex at work',
      providerKind: 'codex',
      isolation: 'folder',
    });
    const listed = await call(client, 'list_helpers');
    expect(listed.value['helpers']).toMatchObject([
      { id: helperId, instance: 'Codex at work', provider: 'codex', state: 'idle' },
    ]);
    expect(listed.value['instances']).toEqual([
      { name: 'claude-work', provider: 'claude', connected: true, defaultModel: 'opus' },
      { name: 'Codex at work', provider: 'codex', connected: true, defaultModel: 'gpt-6.1-sol' },
    ]);
    expect((await call(client, 'read_helper', { id: helperId })).value).toMatchObject({
      lastAnswer: 'Done',
    });
    await client.close();
  });

  it('writes to a working helper, stops it, and keeps to the limits', async () => {
    const client = await mainThread();
    dispatch({ type: 'setting.set', key: 'chat.helpersPerThread', scope: 'global', value: 1 });
    const started = await call(client, 'start_helper', { brief: 'Wait for the build' });
    const helperId = String(started.value['id']);
    await helperStarted(helperId);
    expect(threadRow(helperId)?.state).toBe('working');
    const second = await call(client, 'start_helper', { brief: 'Another one' });
    expect(second).toMatchObject({ isError: true });
    expect(String(second.value['error'])).toContain('chat.helpersPerThread');
    expect(
      (await call(client, 'write_to_helper', { id: helperId, text: 'Also check the README' }))
        .isError,
    ).toBe(false);
    // Queued for the turn's end, or handed to the running turn where the provider takes it.
    const handed = server.database.db
      .select()
      .from(threadItems)
      .where(eq(threadItems.threadId, helperId))
      .all()
      .some((item) => JSON.stringify(item.payload).includes('Also check the README'));
    expect(handed || threadRow(helperId)?.queued?.text === 'Also check the README').toBe(true);
    expect((await call(client, 'stop_helper', { id: helperId })).isError).toBe(false);
    expect(
      adapters.flatMap((adapter) => adapter.sent).filter((command) => command.type === 'interrupt'),
    ).toEqual([{ type: 'interrupt', threadId: helperId }]);
    expect((await call(client, 'read_helper', { id: 'someone-else' })).isError).toBe(true);
    await client.close();
  });

  it('refuses its own copy outside Git, and every helper command from anyone but the tools', async () => {
    const client = await mainThread();
    const copy = await call(client, 'start_helper', { brief: 'Try it apart', isolation: 'copy' });
    expect(copy.isError).toBe(true);
    expect(
      server.database.db
        .select()
        .from(threads)
        .all()
        .filter((row) => row.startedBy === 'helper'),
    ).toEqual([]);
    expect(() =>
      dispatch({
        type: 'helper.start',
        threadId: 'h1',
        parentThreadId: 't1',
        title: 'Sneaky',
        brief: 'Start anyway',
        isolation: 'folder',
      }),
    ).toThrow(/helper tools/);
    expect(() =>
      server.engine.dispatch(
        'from-assistant',
        { type: 'helper.stop', threadId: 'h1', parentThreadId: 't1' },
        'assistant',
      ),
    ).toThrow(/helper tools/);
    await client.close();
  });
});

// Resolves once the main thread has had `count` turns.
async function mainTurns(count: number) {
  await new Promise<void>((resolve) => {
    const check = () => {
      if (startTurnsOf('t1').length >= count) {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = server.engine.onCommit(check);
    check();
  });
  await server.helperFollower.settled();
  await server.providerService.idle();
}

describe('following helpers (orchestration spec 3, 7)', () => {
  it("sends the helper's answer back to the main thread as a message from wow", async () => {
    const client = await mainThread();
    const started = await call(client, 'start_helper', {
      brief: 'Review the timer',
      instance: 'Codex at work',
    });
    await mainTurns(2);
    expect(startTurnsOf('t1')[1]?.prompt).toBe(
      `From wow: your helper "Review the timer" (id ${String(started.value['id'])}, on Codex at work) ended its turn. Its answer:\n\nDone`,
    );
    await client.close();
  });

  it("tells the main thread of the helper's question and lets its agent answer it", async () => {
    const client = await mainThread();
    const started = await call(client, 'start_helper', { brief: 'Which port should it use?' });
    const helperId = String(started.value['id']);
    await mainTurns(2);
    const told = startTurnsOf('t1')[1]?.prompt ?? '';
    expect(told).toContain(`your helper "Which port should it use?" (id ${helperId}`);
    expect(told).toContain('asks a question');
    expect(told).toContain('Which port?');
    const questionId = /question \(id ([^)]+)\)/.exec(told)?.[1] ?? '';
    const answered = await call(client, 'answer_helper_question', {
      id: helperId,
      questionId,
      reply: { picked: ['4317'], text: '' },
    });
    expect(answered.isError).toBe(false);
    expect(
      server.database.db.select().from(questions).where(eq(questions.id, questionId)).get()?.answer,
    ).toContain('4317');
    await client.close();
  });

  it('stops the working helpers with the main thread, tells nothing, and keeps the main thread from being put away', async () => {
    const client = await mainThread();
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Wait while it works' });
    const started = await call(client, 'start_helper', { brief: 'Wait for the build' });
    const helperId = String(started.value['id']);
    await helperStarted(helperId);
    expect(() => dispatch({ type: 'thread.setArchived', threadId: 't1', archived: true })).toThrow(
      /Wait for the build/,
    );
    dispatch({ type: 'thread.interrupt', threadId: 't1' });
    await turnEnds(helperId);
    await server.helperFollower.settled();
    await server.providerService.idle();
    expect(
      adapters
        .flatMap((adapter) => adapter.sent)
        .filter((command) => command.type === 'interrupt')
        .map((command) => command.threadId)
        .toSorted(),
    ).toEqual(['t1', helperId].toSorted());
    // A stopped helper tells its main thread nothing, so the main thread does not start again.
    expect(startTurnsOf('t1')).toHaveLength(2);
    await client.close();
  });
});

// Resolves on the commit after which `test` holds: no sleeping or polling.
function until(test: () => boolean) {
  return new Promise<void>((resolve) => {
    const check = () => {
      if (test()) {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = server.engine.onCommit(check);
    check();
  });
}

// Resolves once the thread has had `count` turns, and what followed them has settled.
async function turnsSent(threadId: string, count: number) {
  await until(() => startTurnsOf(threadId).length >= count);
  await server.helperFollower.settled();
  await server.providerService.idle();
}

// A main thread, its Codex helper, and a client of that helper's own helper tools.
async function helperWithTools(brief = 'Plan the timer change') {
  const client = await mainThread();
  const started = await call(client, 'start_helper', { brief, instance: 'Codex at work' });
  const helperId = String(started.value['id']);
  await helperStarted(helperId);
  const tools = startTurnsOf(helperId)[0]?.helperTools;
  if (!tools) throw new Error('the helper has no helper tools');
  return { client, helperId, tools, helperClient: await connect(tools) };
}

const runGit = (folder: string, ...args: string[]) =>
  execFileSync('git', ['-C', folder, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'none'), GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  });

async function repository(name: string) {
  const folder = path.join(root, name);
  await mkdir(folder);
  runGit(folder, 'init', '-q', '-b', 'main');
  // No line ending conversion, whatever the user's own git config says.
  await writeFile(path.join(folder, '.gitattributes'), '* -text\n');
  await writeFile(path.join(folder, 'README.md'), 'An invented repository.\n');
  runGit(folder, 'add', '.');
  runGit(
    folder,
    '-c',
    'user.name=Ada',
    '-c',
    'user.email=ada@example.invalid',
    'commit',
    '-qm',
    'Start',
  );
  return folder;
}

describe('helpers in depth (orchestrator threads spec 4 to 10)', () => {
  it('lets a helper start a helper of its own, which has none, down to chat.helperDepth', async () => {
    const { client, helperId, tools, helperClient } = await helperWithTools();
    const started = await call(helperClient, 'start_helper', {
      brief: 'Check the README',
      instance: 'claude-work',
    });
    expect(started.isError).toBe(false);
    const deepId = String(started.value['id']);
    await helperStarted(deepId);
    expect(threadRow(deepId)).toMatchObject({ parentThreadId: helperId, startedBy: 'helper' });
    expect(startTurnsOf(deepId)[0]?.helperTools).toBeUndefined();
    expect(() =>
      server.engine.dispatch(
        'too-deep',
        {
          type: 'helper.start',
          threadId: 'h-deeper',
          parentThreadId: deepId,
          title: 'Deeper',
          brief: 'Go deeper',
          isolation: 'folder',
        },
        'helper',
      ),
    ).toThrow(/chat\.helperDepth/);
    // At depth 1, the first helper is the deepest and loses its tools.
    dispatch({ type: 'setting.set', key: 'chat.helperDepth', scope: 'global', value: 1 });
    expect((await listTools(tools.token, tools.url)).status).toBe(401);
    await helperClient.close();
    await client.close();
  });

  it("sends a helper's answer to the helper that started it, not to the main thread", async () => {
    const { client, helperId, helperClient } = await helperWithTools();
    await turnsSent('t1', 2);
    const started = await call(helperClient, 'start_helper', { brief: 'Check the README' });
    const deepId = String(started.value['id']);
    await turnsSent(helperId, 2);
    expect(startTurnsOf(helperId)[1]?.prompt).toContain(
      `From wow: your helper "Check the README" (id ${deepId}`,
    );
    await turnsSent('t1', 3);
    expect(startTurnsOf('t1').some((turn) => turn.prompt.includes(deepId))).toBe(false);
    await helperClient.close();
    await client.close();
  });

  it('stops the whole tree with the main thread and keeps it from being marked done', async () => {
    const { client, helperId, helperClient } = await helperWithTools('Wait for the build');
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Wait while they work' });
    const started = await call(helperClient, 'start_helper', { brief: 'Wait for the tests' });
    const deepId = String(started.value['id']);
    await helperStarted(deepId);
    expect(() => dispatch({ type: 'thread.setDone', threadId: 't1', done: true })).toThrow(
      /helpers "Wait for the tests", "Wait for the build" work/,
    );
    dispatch({ type: 'thread.interrupt', threadId: 't1' });
    await turnEnds(deepId);
    await server.providerService.idle();
    expect(
      adapters
        .flatMap((adapter) => adapter.sent)
        .filter((command) => command.type === 'interrupt')
        .map((command) => command.threadId)
        .toSorted(),
    ).toEqual(['t1', helperId, deepId].toSorted());
    await helperClient.close();
    await client.close();
  });

  it('keeps to chat.helpersPerTree at every level', async () => {
    const { client, helperClient } = await helperWithTools('Wait for the build');
    dispatch({ type: 'setting.set', key: 'chat.helpersPerTree', scope: 'global', value: 1 });
    const refused = await call(helperClient, 'start_helper', { brief: 'Another one' });
    expect(refused.isError).toBe(true);
    expect(String(refused.value['error'])).toContain('chat.helpersPerTree');
    await helperClient.close();
    await client.close();
  });

  it('gives no helper in the tree a wider mode than the main thread', async () => {
    create('t1', 'tea');
    dispatch({ type: 'thread.configure', threadId: 't1', permissionMode: 'plan' });
    const mainTools = (await turnOf('t1')).helperTools;
    if (!mainTools) throw new Error('no helper tools');
    const client = await connect(mainTools);
    const first = await call(client, 'start_helper', { brief: 'Read the plan' });
    const firstId = String(first.value['id']);
    await helperStarted(firstId);
    expect(threadRow(firstId)?.permissionMode).toBe('plan');
    const tools = startTurnsOf(firstId)[0]?.helperTools;
    if (!tools) throw new Error('the helper has no helper tools');
    const helperClient = await connect(tools);
    const deep = await call(helperClient, 'start_helper', {
      brief: 'Read it too',
      instance: 'Codex at work',
    });
    const deepId = String(deep.value['id']);
    await helperStarted(deepId);
    expect(threadRow(deepId)?.permissionMode).toBe('read-only');
    await helperClient.close();
    await client.close();
  });

  it('works in a folder it names, and makes its own copy of the repository that holds it', async () => {
    const bell = await repository('bell');
    const client = await mainThread();
    const inFolder = await call(client, 'start_helper', { brief: 'Read the bell', folder: 'bell' });
    const inFolderId = String(inFolder.value['id']);
    await helperStarted(inFolderId);
    expect(threadRow(inFolderId)).toMatchObject({ cwd: bell, workingCopy: null });
    const copied = await call(client, 'start_helper', {
      brief: 'Ring the bell',
      folder: bell,
      isolation: 'copy',
    });
    expect(copied.isError).toBe(false);
    const copyId = String(copied.value['id']);
    await until(() => {
      const state = threadRow(copyId)?.workingCopy?.state;
      return state === 'ready' || state === 'failed';
    });
    const row = threadRow(copyId);
    expect(row?.workingCopy).toMatchObject({ state: 'ready', repository: bell });
    expect(row?.branch).toMatch(/^wow\/helper\/[0-9a-z]{6}$/);
    expect(runGit(bell, 'branch', '--list', 'wow/helper/*')).toContain(row?.branch ?? '?');
    expect(row?.cwd).not.toBe(bell);
    await client.close();
  });

  it("refuses a folder that is not there, is wow's own, or is outside Git for a copy", async () => {
    await mkdir(path.join(root, 'plain'));
    const client = await mainThread();
    const missing = await call(client, 'start_helper', { brief: 'Look', folder: 'nowhere' });
    expect(String(missing.value['error'])).toContain('There is no folder');
    const own = await call(client, 'start_helper', {
      brief: 'Look',
      folder: path.join(root, 'wow home'),
    });
    expect(String(own.value['error'])).toContain("wow's own folder");
    const plain = await call(client, 'start_helper', {
      brief: 'Look',
      folder: 'plain',
      isolation: 'copy',
    });
    expect(String(plain.value['error'])).toContain('is not in a Git repository');
    expect(
      server.database.db
        .select()
        .from(threads)
        .all()
        .filter((each) => each.startedBy === 'helper'),
    ).toEqual([]);
    await client.close();
  });

  it("makes a helper's copy from its repository's main worktree, never another thread's copy, and keeps that copy while a helper in it works", async () => {
    const bell = await repository('bell');
    await mkdir(path.join(bell, 'docs'));
    const client = await mainThread();
    // A subfolder names its repository: the copy is of the whole repository, and comes home to
    // its top level.
    const first = await call(client, 'start_helper', {
      brief: 'Ring the bell',
      folder: 'bell/docs',
      isolation: 'copy',
    });
    const firstId = String(first.value['id']);
    const ready = (id: string) =>
      until(() => {
        const state = threadRow(id)?.workingCopy?.state;
        return state === 'ready' || state === 'failed';
      });
    await ready(firstId);
    const branch = threadRow(firstId)?.branch ?? '?';
    expect(threadRow(firstId)?.workingCopy).toMatchObject({ state: 'ready', repository: bell });
    expect(runGit(bell, 'rev-parse', branch)).toBe(runGit(bell, 'rev-parse', 'HEAD'));
    await helperStarted(firstId);
    await turnEnds(firstId);
    const tools = startTurnsOf(firstId)[0]?.helperTools;
    if (!tools) throw new Error('the helper has no helper tools');
    const helperClient = await connect(tools);
    // A helper in the first copy's folder keeps that copy from being removed while it works.
    const sharing = await call(helperClient, 'start_helper', { brief: 'Wait for the bell' });
    const sharingId = String(sharing.value['id']);
    await helperStarted(sharingId);
    expect(threadRow(sharingId)?.cwd).toBe(threadRow(firstId)?.cwd);
    const holds = await server.workspaces.threadStatus(firstId);
    await expect(server.workspaces.removeThread(firstId, holds)).rejects.toThrow(
      /Helper "Wait for the bell" is working/,
    );
    // From inside that copy, a copy of its own is made from the repository, not from the copy.
    const second = await call(helperClient, 'start_helper', {
      brief: 'Ring it again',
      isolation: 'copy',
    });
    const secondId = String(second.value['id']);
    await ready(secondId);
    expect(threadRow(secondId)?.workingCopy).toMatchObject({ state: 'ready', repository: bell });
    await helperClient.close();
    await client.close();
  });
});

// The gate cards in the main thread, and how their requests stand.
const gateCards = (threadId = 't1') =>
  server.database.db
    .select()
    .from(threadItems)
    .where(eq(threadItems.threadId, threadId))
    .all()
    .filter((item) => item.kind === 'gate_card');

describe('gates in the main thread (orchestrator threads spec 14 to 17)', () => {
  it("draws a depth 2 helper's approval in the main thread, and answering it lets the helper go on", async () => {
    const client = await mainThread();
    const first = await call(client, 'start_helper', {
      brief: 'Plan the deploy',
      instance: 'Codex at work',
    });
    const firstId = String(first.value['id']);
    await helperStarted(firstId);
    const tools = startTurnsOf(firstId)[0]?.helperTools;
    if (!tools) throw new Error('the helper has no helper tools');
    const helperClient = await connect(tools);
    const deep = await call(helperClient, 'start_helper', {
      brief: 'Approve the release',
      instance: 'claude-work',
    });
    const deepId = String(deep.value['id']);
    await until(() => gateCards().length === 1);
    await server.helperFollower.settled();
    const approval = server.database.db
      .select()
      .from(approvals)
      .where(eq(approvals.threadId, deepId))
      .get();
    expect(gateCards()[0]?.payload).toMatchObject({
      fromThreadId: deepId,
      kind: 'approval',
      requestId: approval?.id,
      itemId: approval?.itemId,
      title: 'Approve the release',
      instanceName: 'claude-work',
      providerKind: 'claude',
      depth: 2,
      parentTitle: 'Plan the deploy',
    });
    // An approval is the user's alone: the helper that started it is not asked.
    expect(startTurnsOf(firstId).some((turn) => turn.prompt.includes('Approve the release'))).toBe(
      false,
    );
    // The card answers with the same command as the helper's own card.
    dispatch({ type: 'approval.answer', approvalId: approval?.id ?? '?', decision: 'allowOnce' });
    await server.providerService.idle();
    expect(
      server.database.db.select().from(approvals).where(eq(approvals.threadId, deepId)).get()
        ?.decision,
    ).toBe('allowOnce');
    expect(
      adapters
        .flatMap((adapter) => adapter.sent)
        .some(
          (command) =>
            command.type === 'answerApproval' && command.approvalId === `${deepId}-approval`,
        ),
    ).toBe(true);
    // A second follow of the same approval draws nothing more.
    dispatch({
      type: 'helper.followed',
      threadId: deepId,
      reason: 'approval',
      approvalId: approval?.id ?? '?',
    });
    expect(gateCards()).toHaveLength(1);
    await helperClient.close();
    await client.close();
  });

  it("draws a helper's question in the main thread and still tells the thread that started it", async () => {
    const client = await mainThread();
    const started = await call(client, 'start_helper', { brief: 'Which port should it use?' });
    const helperId = String(started.value['id']);
    await until(() => gateCards().length === 1);
    await mainTurns(2);
    const question = server.database.db
      .select()
      .from(questions)
      .where(eq(questions.threadId, helperId))
      .get();
    expect(gateCards()[0]?.payload).toMatchObject({
      fromThreadId: helperId,
      kind: 'question',
      requestId: question?.id,
      depth: 1,
    });
    expect(gateCards()[0]?.payload).not.toHaveProperty('parentTitle');
    expect(startTurnsOf('t1')[1]?.prompt).toContain('asks a question');
    dispatch({
      type: 'question.answer',
      answers: [{ questionId: question?.id ?? '?', reply: { picked: ['8080'], text: '' } }],
    });
    expect(
      server.database.db.select().from(questions).where(eq(questions.threadId, helperId)).get()
        ?.answer,
    ).toContain('8080');
    await client.close();
  });

  it('keeps the main composer open while a card waits, and draws nothing for a helper that only answers', async () => {
    const client = await mainThread();
    const asking = String(
      (await call(client, 'start_helper', { brief: 'Approve the release' })).value['id'],
    );
    const answering = String(
      (await call(client, 'start_helper', { brief: 'Read the changelog' })).value['id'],
    );
    await until(() => gateCards().length === 1);
    await turnEnds(answering);
    await mainTurns(2);
    expect(threadRow(asking)?.state).toBe('needs_you');
    const before = startTurnsOf('t1').length;
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'How far is it?' });
    await turnsSent('t1', before + 1);
    expect(startTurnsOf('t1').at(-1)?.prompt).toBe('How far is it?');
    // Followed again after the main thread moved to a new turn: still one card for the request.
    const approvalId =
      server.database.db.select().from(approvals).where(eq(approvals.threadId, asking)).get()?.id ??
      '?';
    dispatch({ type: 'helper.followed', threadId: asking, reason: 'approval', approvalId });
    expect(
      gateCards().map((item) => (item.payload as { fromThreadId: string }).fromThreadId),
    ).toEqual([asking]);
    await client.close();
  });
});

// Resolves once the thread's own copy is made, or could not be.
const copyMade = (threadId: string) =>
  until(() => {
    const state = threadRow(threadId)?.workingCopy?.state;
    return state === 'ready' || state === 'failed';
  });

// A copy helper of the main thread whose turn has ended, and an invented commit in its copy.
async function copyHelper(
  client: Client,
  folder: string,
  brief: string,
  file: string,
  ownBranch?: string,
) {
  const started = await call(client, 'start_helper', { brief, folder, isolation: 'copy' });
  const helperId = String(started.value['id']);
  await copyMade(helperId);
  await helperStarted(helperId);
  await turnEnds(helperId);
  const cwd = threadRow(helperId)?.cwd ?? '';
  // As a delivery skill does: its agent makes a branch of its own and commits there.
  if (ownBranch) runGit(cwd, 'checkout', '-q', '-b', ownBranch);
  await writeFile(path.join(cwd, file), `${brief}\n`);
  runGit(cwd, 'add', '.');
  runGit(
    cwd,
    '-c',
    'user.name=Ada',
    '-c',
    'user.email=ada@example.invalid',
    'commit',
    '-qm',
    brief,
  );
  return { helperId, cwd, branch: ownBranch ?? threadRow(helperId)?.branch ?? '?' };
}

describe("bringing helpers' work together (orchestrator threads spec 6, 11, 12)", () => {
  it('says where each helper’s work is, and starts a merge helper for two copies of one repository', async () => {
    const bell = await repository('bell');
    const client = await mainThread();
    const ring = await copyHelper(client, bell, 'Ring the bell', 'ring.md');
    const polish = await copyHelper(client, bell, 'Polish the bell', 'polish.md', 'polish/shine');
    expect((await call(client, 'read_helper', { id: polish.helperId })).value).toMatchObject({
      branch: 'polish/shine',
    });
    expect((await call(client, 'read_helper', { id: ring.helperId })).value).toMatchObject({
      folder: ring.cwd,
      repository: bell,
      branch: ring.branch,
      ownCopy: true,
      ahead: 1,
    });
    const merged = await call(client, 'merge_helpers', { ids: [ring.helperId, polish.helperId] });
    expect(merged).toMatchObject({
      isError: false,
      value: {
        isolation: 'copy',
        merges: [ring.branch, 'polish/shine'],
        commits: { [ring.branch]: 1, 'polish/shine': 1 },
      },
    });
    const mergeId = String(merged.value['id']);
    await copyMade(mergeId);
    await helperStarted(mergeId);
    expect(threadRow(mergeId)).toMatchObject({
      parentThreadId: 't1',
      title: 'Merge Ring the bell + Polish the bell',
      workingCopy: { state: 'ready', repository: bell },
    });
    expect(startTurnsOf(mergeId)[0]?.prompt).toContain(`- ${ring.branch}\n- ${polish.branch}`);
    expect(runGit(bell, 'status', '--porcelain')).toBe('');
    // What its agent does: merge both branches into its own and commit.
    const mergeCwd = threadRow(mergeId)?.cwd ?? '';
    runGit(
      mergeCwd,
      '-c',
      'user.name=Ada',
      '-c',
      'user.email=ada@example.invalid',
      'merge',
      '--no-edit',
      '-q',
      ring.branch,
      polish.branch,
    );
    expect((await call(client, 'read_helper', { id: mergeId })).value).toMatchObject({
      repository: bell,
      ahead: 3,
    });
    await client.close();
  });

  it('refuses to merge too few helpers, someone else’s, one without a copy, one at work, or two repositories', async () => {
    const bell = await repository('bell');
    const tower = await repository('tower');
    const client = await mainThread();
    const ring = await copyHelper(client, bell, 'Ring the bell', 'ring.md');
    const climb = await copyHelper(client, tower, 'Climb the tower', 'climb.md');
    const shared = String(
      (await call(client, 'start_helper', { brief: 'Read the bell', folder: bell })).value['id'],
    );
    await helperStarted(shared);
    await turnEnds(shared);
    const busy = String(
      (
        await call(client, 'start_helper', {
          brief: 'Wait for the bell',
          folder: bell,
          isolation: 'copy',
        })
      ).value['id'],
    );
    await copyMade(busy);
    await helperStarted(busy);
    const refusal = async (ids: string[]) => {
      const answer = await call(client, 'merge_helpers', { ids });
      expect(answer.isError).toBe(true);
      return String(answer.value['error'] ?? JSON.stringify(answer.value));
    };
    expect(await refusal([ring.helperId])).toMatch(/ids/);
    expect(await refusal([ring.helperId, ring.helperId])).toContain('at least two');
    expect(await refusal([ring.helperId, 'someone-else'])).toContain('You have no helper');
    expect(await refusal([ring.helperId, shared])).toContain('no working copy of its own');
    expect(await refusal([ring.helperId, busy])).toContain('still working');
    const loose = await copyHelper(client, bell, 'Loosen the bell', 'loose.md');
    runGit(loose.cwd, 'checkout', '-q', '--detach');
    expect(await refusal([ring.helperId, loose.helperId])).toContain('on no branch');
    expect(await refusal([ring.helperId, climb.helperId])).toContain('different repositories');
    expect(
      server.database.db
        .select()
        .from(threads)
        .all()
        .filter((row) => row.title.startsWith('Merge ')),
    ).toEqual([]);
    await client.close();
  });
});
