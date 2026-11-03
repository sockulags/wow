import {
  RpcResponse,
  type ProviderInstance,
  type ProviderTestResult,
  type ProviderUpdate,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { snapshot } from '../core/subscriptions.js';
import { MockProviderAdapter } from '../hooks/providers.js';
import { startServer, type RunningServer } from '../server.js';
import { createNpmRunner } from './update.js';

// "Update Codex" over RPC with a fake npm: a node script that prints what npm prints, records its
// arguments, and "installs" the tested codex by writing a marker the mock adapter's test reads.

let dir: string;
let server: RunningServer;

const fakeNpm = `
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify('__DIR__')};
fs.writeFileSync(path.join(dir, 'args.json'), JSON.stringify(process.argv.slice(2)));
process.stdout.write('added 1 package in 2s\\n');
process.stderr.write('npm warn invented warning\\n');
if (fs.existsSync(path.join(dir, 'fail'))) process.exit(1);
fs.writeFileSync(path.join(dir, 'installed'), '');
`;

const offer: ProviderUpdate = {
  method: 'npm',
  targetVersion: '0.166.0',
  reason: 'incompatible',
  packageSpec: '@openai/codex@0.166.0',
  prefix: null,
};

const testResult = (): ProviderTestResult =>
  existsSync(path.join(dir, 'installed'))
    ? { ok: true, account: 'API key', version: '0.166.0', message: null, update: null }
    : {
        ok: false,
        account: null,
        version: '0.150.0',
        message: 'codex 0.150.0 is not compatible with wow. Update codex to 0.166.0.',
        update: offer,
      };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-update-'));
  const script = path.join(dir, 'npm.cjs');
  await writeFile(script, fakeNpm.replace('"__DIR__"', JSON.stringify(dir)));
  server = await startServer({
    home: path.join(dir, '.wow'),
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: dir,
    watchSkills: () => ({ close: () => Promise.resolve() }),
    runNpm: createNpmRunner({ file: process.execPath, prefixArgs: [script] }),
    hooks: {
      providers: {
        codex: () => new MockProviderAdapter('codex', undefined, testResult),
        claude: () => new MockProviderAdapter('claude'),
      },
    },
  });
  for (const [id, kind] of [
    ['codex-a', 'codex'],
    ['codex-b', 'codex'],
    ['claude-a', 'claude'],
  ] as const) {
    server.engine.dispatch(`create-${id}`, {
      type: 'providerInstance.create',
      providerInstanceId: id,
      kind,
      name: id,
      binaryPath: kind === 'codex' ? 'C:\\Users\\demo\\AppData\\Roaming\\npm\\codex.cmd' : '',
      configDir: '',
      env: {},
      launchArgs: [],
    });
  }
});

afterEach(async () => {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

async function rpc(method: string, params: unknown): Promise<RpcResponse> {
  const socket = new WebSocket(server.url);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const answer = new Promise<RpcResponse>((resolve) =>
    socket.once('message', (raw) => resolve(RpcResponse.parse(JSON.parse(String(raw))))),
  );
  socket.send(JSON.stringify({ id: '1', method, params }));
  const response = await answer;
  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    socket.close();
  });
  return response;
}

const instance = (id: string) =>
  (snapshot(server.database.db, { topic: 'providerInstances' }) as ProviderInstance[]).find(
    (row) => row.id === id,
  );

describe('provider.update', () => {
  it('runs npm, stores its output, and tests every instance on that binary again', async () => {
    await expect(rpc('provider.test', { providerInstanceId: 'codex-a' })).resolves.toMatchObject({
      result: { ok: false, update: offer },
    });
    expect(instance('codex-a')).toMatchObject({ status: 'error', update: offer, updateRun: null });

    await expect(rpc('provider.update', { providerInstanceId: 'codex-a' })).resolves.toEqual({
      id: '1',
      result: { command: 'npm install -g @openai/codex@0.166.0' },
    });
    expect(instance('codex-a')?.updateRun).toMatchObject({ state: 'running', output: '' });
    await server.providerUpdates.idle('codex-a');

    expect(JSON.parse(await readFile(path.join(dir, 'args.json'), 'utf8'))).toEqual([
      'install',
      '-g',
      '@openai/codex@0.166.0',
    ]);
    const updated = instance('codex-a');
    expect(updated?.updateRun).toMatchObject({
      state: 'succeeded',
      command: 'npm install -g @openai/codex@0.166.0',
      targetVersion: '0.166.0',
      message: null,
      endedAt: expect.any(String),
    });
    expect(updated?.updateRun?.output).toContain('added 1 package in 2s');
    expect(updated?.updateRun?.output).toContain('npm warn invented warning');
    // Tested again after the install, with the other instance on the same binary.
    expect(updated).toMatchObject({ status: 'ready', version: '0.166.0', update: null });
    expect(instance('codex-b')).toMatchObject({ status: 'ready', version: '0.166.0' });
    expect(instance('claude-a')).toMatchObject({ status: 'unknown' });
  });

  it('reports a failed npm and leaves the last test as it was', async () => {
    await writeFile(path.join(dir, 'fail'), '');
    await rpc('provider.test', { providerInstanceId: 'codex-a' });
    await rpc('provider.update', { providerInstanceId: 'codex-a' });
    await server.providerUpdates.idle('codex-a');
    expect(instance('codex-a')).toMatchObject({
      status: 'error',
      update: offer,
      updateRun: { state: 'failed', message: 'npm exited with code 1. See its output above.' },
    });
  });

  it('refuses an instance without an npm update, and a second update while one runs', async () => {
    await expect(rpc('provider.update', { providerInstanceId: 'codex-a' })).resolves.toMatchObject({
      error: { code: 'rejected', message: expect.stringContaining('has no update wow can run') },
    });
    await expect(rpc('provider.update', { providerInstanceId: 'nope' })).resolves.toMatchObject({
      error: { code: 'not_found' },
    });
    await rpc('provider.test', { providerInstanceId: 'codex-a' });
    await rpc('provider.update', { providerInstanceId: 'codex-a' });
    await expect(rpc('provider.update', { providerInstanceId: 'codex-a' })).resolves.toMatchObject({
      error: { code: 'conflict' },
    });
    await server.providerUpdates.idle('codex-a');
  });

  it('marks an update cut off by a server stop as failed at the next start', async () => {
    server.engine.dispatch('cut-off', {
      type: 'providerInstance.recordUpdate',
      providerInstanceId: 'codex-a',
      progress: {
        phase: 'started',
        command: 'npm install -g @openai/codex@0.166.0',
        targetVersion: '0.166.0',
        at: new Date().toISOString(),
      },
    });
    server.providerUpdates.recover();
    expect(instance('codex-a')?.updateRun).toMatchObject({
      state: 'failed',
      message: expect.stringContaining('The server stopped while the update ran'),
    });
  });
});
