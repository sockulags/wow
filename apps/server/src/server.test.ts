import { ServerMessage, type RpcResponse, type SubscriptionPush } from '@wow/contracts';
import { SecretStore, defaultProtector, plainProtector } from '@wow/secrets';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { OutlookMode } from './hooks/index.js';
import { closeConnection, type Connection } from './rpc/handlers.js';
import { readServerInfo, startServer, type RunningServer } from './server.js';

let home: string;
let server: RunningServer;
let outlookModes: OutlookMode[];
let stoppedServices: string[];

interface Client {
  request(method: string, params?: unknown): Promise<RpcResponse>;
  send(raw: string): Promise<RpcResponse>;
  messages: ServerMessage[];
  nextPush(): Promise<SubscriptionPush>;
  close(): Promise<void>;
}

// Resolves on WebSocket events only: no sleeping or polling.
function connect(url: string): Promise<Client> {
  const socket = new WebSocket(url);
  const messages: ServerMessage[] = [];
  const waiting = new Map<string, (response: RpcResponse) => void>();
  const pushWaiters: ((push: SubscriptionPush) => void)[] = [];
  const pushes: SubscriptionPush[] = [];
  let nextId = 0;
  socket.on('message', (raw) => {
    const message = ServerMessage.parse(JSON.parse(String(raw)));
    messages.push(message);
    if ('subscription' in message) {
      const waiter = pushWaiters.shift();
      if (waiter) waiter(message);
      else pushes.push(message);
      return;
    }
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  const sendRaw = (raw: string, id: string) =>
    new Promise<RpcResponse>((resolve) => {
      waiting.set(id, resolve);
      socket.send(raw);
    });
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('open', () =>
      resolve({
        messages,
        request: (method, params = {}) => {
          const id = String((nextId += 1));
          return sendRaw(JSON.stringify({ id, method, params }), id);
        },
        send: (raw) => sendRaw(raw, '?'),
        nextPush: () => {
          const ready = pushes.shift();
          return ready ? Promise.resolve(ready) : new Promise((done) => pushWaiters.push(done));
        },
        close: () =>
          new Promise((done) => {
            socket.once('close', () => done());
            socket.close();
          }),
      }),
    );
  });
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'wow-server-'));
  outlookModes = [];
  stoppedServices = [];
  server = await startServer({
    home: path.join(home, '.wow'),
    env: { WOW_PROVIDERS: 'mock' },
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: home,
    watchSkills: () => ({ close: () => Promise.resolve() }),
    hooks: {
      outlook: (mode) => {
        outlookModes.push(mode);
        return Promise.resolve({
          mode,
          open: () => Promise.resolve(),
          refresh: () => Promise.resolve('synced' as const),
          stop: () => {
            stoppedServices.push('outlook');
            return Promise.resolve();
          },
        });
      },
    },
  });
});

afterEach(async () => {
  await server.stop();
  await rm(home, { recursive: true, force: true });
});

describe('startup', () => {
  it('writes server.json with the port and token', async () => {
    const info = await readServerInfo(server.home);
    expect(info).toMatchObject({ port: server.port, token: server.token, pid: process.pid });
  });

  it.runIf(process.platform !== 'win32')(
    'makes server.json readable only by the user',
    async () => {
      expect((await stat(path.join(server.home, 'server.json'))).mode & 0o777).toBe(0o600);
    },
  );

  it('starts the Outlook hook in mock mode off Windows and stops it on shutdown', async () => {
    expect(outlookModes).toEqual(['mock']);
    await server.stop();
    expect(stoppedServices).toEqual(['outlook']);
    await expect(access(path.join(server.home, 'server.json'))).rejects.toThrow(/ENOENT/);
  });

  it('hands out the mock provider adapter with WOW_PROVIDERS=mock', async () => {
    expect(server.providers.mock).toBe(true);
    const adapter = server.providers.create(
      {
        id: 'i1',
        kind: 'codex',
        name: 'Codex',
        binaryPath: 'codex',
        configDir: '/c',
        env: {},
        launchArgs: [],
        defaultModel: null,
        defaultEffort: null,
        defaultPermissionMode: null,
        status: 'unknown',
        account: null,
        version: null,
        statusMessage: null,
        update: null,
        updateRun: null,
      },
      {
        resolveEnv: () => Promise.resolve({}),
        testTimeoutMs: () => 1000,
        requestTimeoutMs: () => 1000,
      },
    );
    const done = new Promise<string>((resolve) =>
      adapter.onEvent((event) => {
        if (event.type === 'turnCompleted') resolve(event.threadId);
      }),
    );
    await adapter.send({
      type: 'startTurn',
      threadId: 't1',
      cwd: '/w',
      prompt: 'hi',
      model: 'm',
      effort: 'low',
      permissionMode: 'default',
    });
    expect(await done).toBe('t1');
  });
});

describe('authentication', () => {
  it('refuses a connection without the right token', async () => {
    await expect(connect(`ws://127.0.0.1:${server.port}/`)).rejects.toThrow(/401/);
    await expect(connect(`ws://127.0.0.1:${server.port}/?token=wrong`)).rejects.toThrow(/401/);
  });
});

describe('rpc', () => {
  let client: Client;

  beforeEach(async () => {
    client = await connect(server.url);
  });

  afterEach(async () => {
    await client.close();
  });

  it('answers server.info', async () => {
    const response = await client.request('server.info');
    expect(response).toMatchObject({ id: '1', result: { home: server.home, pid: process.pid } });
  });

  it('validates every request against the contracts', async () => {
    expect(await client.send('not json')).toMatchObject({
      id: '?',
      error: { code: 'parse_error' },
    });
    expect(await client.request('nope')).toMatchObject({ error: { code: 'unknown_method' } });
    expect(
      await client.request('dispatch', { commandId: 'c1', command: { type: 'project.create' } }),
    ).toMatchObject({ error: { code: 'invalid_params' } });
    expect(await client.request('server.info', { extra: true })).toMatchObject({
      error: { code: 'invalid_params' },
    });
    expect(await client.request('subscribe', { topic: 'threadItems' })).toMatchObject({
      error: { code: 'invalid_params' },
    });
  });

  it('reports rejected commands with their code', async () => {
    const response = await client.request('dispatch', {
      commandId: 'c1',
      command: { type: 'project.delete', projectId: 'missing' },
    });
    expect(response).toMatchObject({ error: { code: 'not_found', message: 'No project missing' } });
  });

  it('refuses a project whose folder is relative or does not exist', async () => {
    const missing = path.join(home, 'not-there');
    const create = (commandId: string, cwd: string) =>
      client.request('dispatch', {
        commandId,
        command: { type: 'project.create', projectId: 'p1', name: 'wow', cwd },
      });
    expect(await create('c1', 'relative/folder')).toMatchObject({
      error: { code: 'rejected', message: 'Use a full folder path, not relative/folder' },
    });
    expect(await create('c2', missing)).toMatchObject({
      error: { code: 'rejected', message: `No folder ${missing}` },
    });
    const file = path.join(home, 'a-file');
    await writeFile(file, '');
    expect(await create('c3', file)).toMatchObject({ error: { code: 'rejected' } });
    expect(await create('c4', home)).toMatchObject({ result: { duplicate: false } });
    expect(
      await client.request('dispatch', {
        commandId: 'c5',
        command: { type: 'project.update', projectId: 'p1', cwd: missing },
      }),
    ).toMatchObject({ error: { code: 'rejected', message: `No folder ${missing}` } });
  });

  it('pushes projection changes to subscribers after the command commits', async () => {
    const subscribed = await client.request('subscribe', { topic: 'projects' });
    if (!('result' in subscribed)) throw new Error('subscribe failed');
    const { subscriptionId, data } = subscribed.result as { subscriptionId: string; data: [] };
    expect(data).toEqual([]);

    const command = { type: 'project.create', projectId: 'p1', name: 'wow', cwd: home };
    const pushed = client.nextPush();
    const dispatched = await client.request('dispatch', { commandId: 'c1', command });
    expect(dispatched).toMatchObject({ result: { seqs: [1], duplicate: false } });
    expect(await pushed).toMatchObject({ subscription: subscriptionId, data: [{ id: 'p1' }] });

    const retried = await client.request('dispatch', { commandId: 'c1', command });
    expect(retried).toMatchObject({ result: { seqs: [1], duplicate: true } });
    expect(client.messages.filter((message) => 'subscription' in message)).toHaveLength(1);
  });

  it('rescans skills on request', async () => {
    const skillDir = path.join(home, '.claude', 'skills', 'tidy');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: tidy\ndescription: Tidy up\n---\n',
    );
    expect(await client.request('skills.refresh')).toMatchObject({
      result: { skills: [{ name: 'tidy', invocations: { claude: '/tidy', codex: '$tidy' } }] },
    });
  });

  it('lists the files expected artifact globs match in a project, for the builder', async () => {
    await mkdir(path.join(home, 'intents', 'demo'), { recursive: true });
    await writeFile(path.join(home, 'intents', 'demo', 'spec.md'), '# Spec\n');
    const command = { type: 'project.create', projectId: 'p1', name: 'wow', cwd: home };
    await client.request('dispatch', { commandId: 'c1', command });
    expect(
      await client.request('workflows.matchArtifacts', {
        projectId: 'p1',
        globs: ['intents/*/spec.md', 'missing/*.md'],
      }),
    ).toMatchObject({ result: { files: ['intents/demo/spec.md'] } });
    expect(
      await client.request('workflows.matchArtifacts', { projectId: 'nope', globs: ['*.md'] }),
    ).toMatchObject({ error: { code: 'not_found' } });
  });

  it('reports an unknown run when asked to detect its artifacts', async () => {
    expect(await client.request('workflowRuns.detectArtifacts', { runId: 'nope' })).toMatchObject({
      error: { code: 'not_found' },
    });
  });

  it('reads a file of a run through files.read, within the project folder and the size limit', async () => {
    const dispatch = (commandId: string, command: Record<string, unknown>) =>
      client.request('dispatch', { commandId, command });
    const project = path.join(home, 'project');
    await mkdir(path.join(project, 'review'), { recursive: true });
    await writeFile(path.join(project, 'review', 'notes.md'), '# Invented notes\n');
    await writeFile(path.join(home, 'beside.txt'), 'outside the project\n');
    await dispatch('c1', { type: 'project.create', projectId: 'p1', name: 'wow', cwd: project });
    await dispatch('c2', {
      type: 'providerInstance.create',
      providerInstanceId: 'mock',
      kind: 'claude',
      name: 'Mock',
      binaryPath: 'claude',
      configDir: '',
      env: {},
      launchArgs: [],
    });
    // A gate before the only step: the run exists and waits without starting a turn.
    await dispatch('c3', {
      type: 'workflow.create',
      workflowId: 'wf1',
      name: 'Review',
      steps: [
        {
          id: 's1',
          skillName: 'check-work',
          providerInstanceId: 'mock',
          model: 'mock-model',
          effort: 'default',
          permissionMode: 'default',
          gateBefore: true,
          gateAfter: false,
          expectedArtifacts: [],
        },
      ],
    });
    expect(
      await dispatch('c4', {
        type: 'workflowRun.start',
        runId: 'r1',
        workflowId: 'wf1',
        projectId: 'p1',
      }),
    ).toHaveProperty('result');

    expect(
      await client.request('files.read', { runId: 'r1', path: 'review/notes.md' }),
    ).toMatchObject({ result: { kind: 'markdown', text: '# Invented notes\n', size: 17 } });
    expect(
      await client.request('files.read', { runId: 'r1', path: '../beside.txt' }),
    ).toMatchObject({ result: { kind: 'refused', reason: 'outside' } });
    expect(await client.request('files.read', { runId: 'nope', path: 'a.md' })).toMatchObject({
      error: { code: 'not_found' },
    });
    expect(await client.request('files.read', { runId: 'r1', path: '' })).toMatchObject({
      error: { code: 'invalid_params' },
    });

    // The same run's changes: its folder is not a repository, which is an answer, not a fault.
    expect(await client.request('workflowRuns.diff', { runId: 'r1' })).toMatchObject({
      result: { status: 'noRepository', files: [], patch: null },
    });
    expect(await client.request('workflowRuns.diff', { runId: 'nope' })).toMatchObject({
      error: { code: 'not_found' },
    });

    await dispatch('c5', {
      type: 'setting.set',
      key: 'viewer.maxFileBytes',
      scope: 'global',
      value: 1000,
    });
    await writeFile(path.join(project, 'review', 'long.log'), 'x'.repeat(1001));
    expect(
      await client.request('files.read', { runId: 'r1', path: 'review/long.log' }),
    ).toMatchObject({ result: { kind: 'refused', reason: 'too_large' } });
  });

  it.each([
    { type: 'skills.sync', skills: [] },
    { type: 'plans.sync', intents: [] },
    {
      type: 'workflowRun.stepCompleted',
      runId: 'r1',
      stepId: 's1',
      finalMessage: '',
      artifactsFound: [],
    },
    { type: 'workflowRun.stepFailed', runId: 'r1', stepId: 's1', error: 'no' },
    { type: 'workflowRun.artifactsFound', runId: 'r1', found: [] },
    { type: 'workflowRun.baseRecorded', runId: 'r1', baseSha: 'a'.repeat(40), files: [] },
  ])('refuses the server-only command $type over RPC', async (command) => {
    expect(
      await client.request('dispatch', { commandId: `internal-${command.type}`, command }),
    ).toMatchObject({ error: { code: 'invalid_params' } });
  });

  it('runs a thread turn through the provider service and tests instances', async () => {
    const dispatch = (commandId: string, command: Record<string, unknown>) =>
      client.request('dispatch', { commandId, command });
    await dispatch('c1', {
      type: 'providerInstance.create',
      providerInstanceId: 'claude-work',
      kind: 'claude',
      name: 'Work',
      binaryPath: 'claude',
      configDir: '',
      env: {},
      launchArgs: [],
    });
    expect(
      await client.request('provider.test', { providerInstanceId: 'claude-work' }),
    ).toMatchObject({ result: { ok: true, version: 'mock' } });
    expect(
      await client.request('provider.listModels', { providerInstanceId: 'claude-work' }),
    ).toMatchObject({ result: [{ id: 'mock-model' }, { id: 'mock-model-large' }] });

    await dispatch('c2', {
      type: 'thread.create',
      threadId: 't1',
      providerInstanceId: 'claude-work',
      cwd: '/w',
      model: 'mock-model',
      effort: 'high',
      permissionMode: 'default',
    });
    const turnEnded = new Promise<void>((resolve) => {
      const off = server.engine.onCommit((commit) => {
        if (commit.events.some(({ event }) => event.kind === 'turn.ended')) {
          off();
          resolve();
        }
      });
    });
    await dispatch('c3', { type: 'thread.sendMessage', threadId: 't1', text: 'hello' });
    await turnEnded;
    const items = await client.request('subscribe', { topic: 'threadItems', threadId: 't1' });
    expect(items).toMatchObject({
      result: {
        data: [
          { kind: 'user', payload: { text: 'hello' } },
          { kind: 'assistant_text', payload: { text: 'hello' }, streaming: false },
          { kind: 'usage' },
        ],
      },
    });

    // Provider events only come from the server's own adapters.
    expect(
      await dispatch('c4', {
        type: 'provider.events',
        threadId: 't1',
        events: [{ type: 'turnCompleted', threadId: 't1' }],
      }),
    ).toMatchObject({ error: { code: 'invalid_params' } });
  });

  it('ends the subscriptions of a closed connection', () => {
    const connection: Connection = { push: () => undefined, subscriptionIds: new Set() };
    const opened = server.subscriptions.subscribe({ topic: 'settings' }, connection.push);
    connection.subscriptionIds.add(opened.subscriptionId);
    const before = server.subscriptions.size;
    closeConnection(connection, server.subscriptions);
    expect(server.subscriptions.size).toBe(before - 1);
  });

  it('resolves settings with their source', async () => {
    await client.request('dispatch', {
      commandId: 'c1',
      command: { type: 'setting.set', key: 'scheduler.tickSeconds', scope: 'global', value: 45 },
    });
    const response = await client.request('settings.resolve', {});
    if (!('result' in response)) throw new Error('settings.resolve failed');
    expect(response.result).toContainEqual({
      key: 'scheduler.tickSeconds',
      value: 45,
      source: 'global',
    });
    expect(response.result).toContainEqual({
      key: 'scheduler.missedPolicy',
      value: 'mark',
      source: 'default',
    });
  });

  it('stores secrets and returns a reference', async () => {
    expect(await client.request('secrets.set', { name: 'jira', value: 'tok' })).toMatchObject({
      result: { secretRef: 'jira' },
    });
    expect(await client.request('secrets.status')).toMatchObject({
      result: { protection: 'none', names: ['jira'] },
    });
    expect(await server.secrets.get('jira')).toBe('tok');
    expect(await client.request('secrets.delete', { name: 'jira' })).toMatchObject({
      result: { removed: true },
    });
  });
});

describe('secret store in the wow home', () => {
  it.runIf(process.platform !== 'win32')('writes secrets.json with mode 0600', async () => {
    await server.secrets.set('jira', 'tok');
    expect((await stat(path.join(server.home, 'secrets.json'))).mode & 0o777).toBe(0o600);
  });

  // The platform default: DPAPI through PowerShell. Runs on the windows-latest CI job.
  it.runIf(process.platform === 'win32')(
    'protects secrets with DPAPI on Windows',
    async () => {
      const store = new SecretStore({
        dir: server.home,
        protector: defaultProtector(process.platform, {
          timeoutMs: () => server.settings.get('advanced.secretsTimeoutMs'),
        }),
      });
      expect(store.protection).toBe('dpapi');
      await store.set('jira', 'plain-token-value');
      const raw = await readFile(path.join(server.home, 'secrets.json'), 'utf8');
      expect(raw).not.toContain('plain-token-value');
      expect(await store.get('jira')).toBe('plain-token-value');
    },
    30_000,
  );
});
