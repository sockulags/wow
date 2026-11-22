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
import { providerInstances, threads, turns } from '../db/schema.js';
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

async function turnOf(threadId: string): Promise<Extract<ProviderCommand, { type: 'startTurn' }>> {
  dispatch({ type: 'thread.sendMessage', threadId, text: 'Look at the timer' });
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
          const adapter = new MockProviderAdapter(row.kind, (command) =>
            command.type === 'startTurn'
              ? [
                  { type: 'textDelta', threadId: command.threadId, itemId: 'a', delta: 'Done' },
                  { type: 'turnCompleted', threadId: command.threadId },
                ]
              : [],
          );
          adapters.push(adapter);
          return adapter;
        },
      },
    },
  });
  server.database.db.insert(providerInstances).values([instance]).run();
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
    expect((await client.listTools()).tools).toEqual([]);
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
