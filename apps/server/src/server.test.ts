import { ServerMessage, type RpcResponse, type SubscriptionPush } from '@wow/contracts';
import { SecretStore, defaultProtector, plainProtector } from '@wow/secrets';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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
    hooks: {
      outlook: (mode) => {
        outlookModes.push(mode);
        return Promise.resolve({
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
    const adapter = server.providers.create({
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
    });
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

  it('pushes projection changes to subscribers after the command commits', async () => {
    const subscribed = await client.request('subscribe', { topic: 'projects' });
    if (!('result' in subscribed)) throw new Error('subscribe failed');
    const { subscriptionId, data } = subscribed.result as { subscriptionId: string; data: [] };
    expect(data).toEqual([]);

    const command = { type: 'project.create', projectId: 'p1', name: 'wow', cwd: '/w' };
    const pushed = client.nextPush();
    const dispatched = await client.request('dispatch', { commandId: 'c1', command });
    expect(dispatched).toMatchObject({ result: { seqs: [1], duplicate: false } });
    expect(await pushed).toMatchObject({ subscription: subscriptionId, data: [{ id: 'p1' }] });

    const retried = await client.request('dispatch', { commandId: 'c1', command });
    expect(retried).toMatchObject({ result: { seqs: [1], duplicate: true } });
    expect(client.messages.filter((message) => 'subscription' in message)).toHaveLength(1);
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
