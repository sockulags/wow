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
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { providerInstances, questions, threadItems, threads, turns } from '../db/schema.js';
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

// The invented agents: "wait" keeps the turn running until it is stopped.
const script = (command: ProviderCommand) => {
  if (command.type === 'interrupt')
    return [{ type: 'turnInterrupted' as const, threadId: command.threadId }];
  if (command.type !== 'startTurn') return [];
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

  it('gives none with chat.helpers off for the project, and refuses the token from then on', async () => {
    create('t1', 'tea');
    const tools = (await turnOf('t1')).helperTools;
    if (!tools) throw new Error('no helper tools');
    dispatch({
      type: 'setting.set',
      key: 'chat.helpers',
      scope: 'project:tea',
      value: false,
    });
    expect((await turnOf('t1')).helperTools).toBeUndefined();
    expect((await listTools(tools.token, tools.url)).status).toBe(401);
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
    // A helper has no helpers of its own.
    expect(turn?.helperTools).toBeUndefined();
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
