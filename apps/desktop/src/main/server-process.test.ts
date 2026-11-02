import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeLaunch, startFakeServer, temporaryHome } from '../test/fake-server.js';
import { ServerProcess, ServerStartError, serverInfoFileName, wowHome } from './server-process.js';

describe('ServerProcess', () => {
  let home: string;
  let remove: () => Promise<void>;
  let started: ServerProcess | undefined;

  beforeEach(async () => {
    ({ home, remove } = await temporaryHome());
  });

  afterEach(async () => {
    await started?.stop();
    started = undefined;
    await remove();
  });

  it('starts the server and reads its port and token from server.json', async () => {
    started = await startFakeServer(home);
    expect(started.running).toBe(true);
    expect(started.endpoint.port).toBeGreaterThan(0);
    expect(started.endpoint.token).not.toBe('');
  });

  it('ignores a server.json left by another process', async () => {
    await writeFile(
      path.join(home, serverInfoFileName),
      JSON.stringify({ port: 1, token: 'stale', pid: 1, startedAt: 'earlier' }),
    );
    started = await startFakeServer(home);
    expect(started.endpoint.token).not.toBe('stale');
    expect(started.endpoint.port).not.toBe(1);
  });

  it('stops the server over the IPC channel so it can remove server.json', async () => {
    started = await startFakeServer(home);
    await started.stop();
    expect(started.running).toBe(false);
    expect(existsSync(path.join(home, serverInfoFileName))).toBe(false);
  });

  it('kills a server that does not stop in time', async () => {
    started = await ServerProcess.start(
      fakeLaunch(home, { mode: 'ignore-shutdown', stopTimeoutMs: 200 }),
    );
    await started.stop();
    expect(started.running).toBe(false);
  });

  it('reports a server that exits before it is ready, with its output', async () => {
    const attempt = ServerProcess.start(fakeLaunch(home, { mode: 'exit-early' }));
    await expect(attempt).rejects.toBeInstanceOf(ServerStartError);
    await expect(attempt).rejects.toThrow(/code 3[\s\S]*failed on purpose/);
  });

  it('tells listeners when the server exits without being asked', async () => {
    started = await startFakeServer(home);
    const exited = new Promise<number | null>((resolve) => started?.onUnexpectedExit(resolve));
    process.kill(started.endpoint.pid);
    await exited;
    expect(started.running).toBe(false);
  });
});

describe('wowHome', () => {
  it('uses WOW_HOME when set and ~/.wow otherwise', () => {
    expect(wowHome({ WOW_HOME: 'some/dir' })).toBe(path.resolve('some/dir'));
    expect(path.basename(wowHome({}))).toBe('.wow');
  });
});
