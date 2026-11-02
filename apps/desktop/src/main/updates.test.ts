import type { Thread, UpdateState } from '@wow/contracts';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeLaunch, temporaryHome } from '../test/fake-server.js';
import { FakeShell, trayLabels } from '../test/fake-shell.js';
import { FakeTimers, FakeUpdater } from '../test/fake-updater.js';
import { DesktopController, updatesPath } from './controller.js';
import { RpcClient } from './rpc-client.js';
import { ServerProcess, serverInfoFileName } from './server-process.js';
import { restartWarning } from './updates.js';

// Auto-update (behavior 35, plan U17) through the controller: a real fake server child, the
// settings it serves, and a fake updater and fake interval timers instead of electron-updater.

const setRows = (client: RpcClient, topic: string, rows: unknown[]) =>
  (client.request as (method: string, params: unknown) => Promise<unknown>)('test.setRows', {
    topic,
    rows,
  }).catch(() => undefined);

const workingThread: Thread = {
  id: 't1',
  projectId: 'p1',
  cwd: '/work',
  branch: null,
  providerInstanceId: 'claude',
  providerSessionId: null,
  title: 'Fix the bug',
  model: 'opus',
  effort: 'high',
  permissionMode: 'default',
  state: 'working',
  pinned: false,
  runId: null,
  stepId: null,
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
};

describe('auto-update', () => {
  let home: string;
  let remove: () => Promise<void>;
  let shell: FakeShell;
  let updater: FakeUpdater;
  let timers: FakeTimers;
  let controller: DesktopController;
  let other: RpcClient | undefined;

  const create = (settings: Record<string, unknown> = {}) =>
    new DesktopController({
      shell,
      launchedHidden: false,
      newCommandId: () => 'cmd',
      startServer: () => ServerProcess.start(fakeLaunch(home, { settings })),
      connect: (endpoint) => RpcClient.connect(endpoint, () => undefined),
      updates: {
        updater,
        currentVersion: '0.1.0',
        timers,
        now: () => new Date('2026-11-02T09:00:00.000Z'),
      },
    });

  const connectOther = async () => {
    const server = controller.server;
    if (server === undefined) throw new Error('server not started');
    other = await RpcClient.connect(server.endpoint, () => undefined);
    return other;
  };

  const states = (after = 0): UpdateState[] =>
    shell.calls
      .slice(after)
      .flatMap((call) => (call.kind === 'setUpdateState' ? [call.state] : []));

  // An update found and downloaded by the next check.
  const releaseAvailable = () => {
    updater.onCheck = () => {
      updater.emit({ type: 'available', version: '0.2.0' });
      updater.emit({ type: 'progress', percent: 12.4 });
      updater.emit({ type: 'progress', percent: 87.9 });
      updater.emit({ type: 'downloaded', version: '0.2.0' });
    };
  };

  beforeEach(async () => {
    ({ home, remove } = await temporaryHome());
    shell = new FakeShell();
    updater = new FakeUpdater();
    timers = new FakeTimers();
    controller = create();
  });

  afterEach(async () => {
    other?.close();
    other = undefined;
    await controller.quit();
    await remove();
  });

  it('checks at start and again every check interval', async () => {
    await controller.start();
    expect(updater.checks).toBe(1);
    expect(timers.intervals).toEqual([240 * 60_000]);
    expect(controller.updateState).toMatchObject({
      status: 'idle',
      enabled: true,
      currentVersion: '0.1.0',
      checkedAt: '2026-11-02T09:00:00.000Z',
    });
    timers.fire();
    expect(updater.checks).toBe(2);

    // A new interval applies at once, without another check.
    const client = await connectOther();
    const marker = shell.calls.length;
    await setRows(client, 'settings', [{ key: 'updates.checkIntervalMinutes', value: 60 }]);
    await shell.waitFor('setTray', () => timers.intervals[0] === 60 * 60_000, marker);
    expect(updater.checks).toBe(2);
  });

  it('never checks while updates are off, and checks when they are turned on', async () => {
    controller = create({ 'updates.enabled': false });
    await controller.start();
    expect(updater.checks).toBe(0);
    expect(timers.intervals).toEqual([]);
    expect(controller.updateState?.enabled).toBe(false);
    await controller.checkForUpdates();
    expect(updater.checks).toBe(0);

    const client = await connectOther();
    const marker = shell.calls.length;
    await setRows(client, 'settings', [{ key: 'updates.enabled', value: true }]);
    await shell.waitFor('setUpdateState', (call) => call.state.enabled, marker);
    expect(updater.checks).toBe(1);
    expect(timers.intervals).toHaveLength(1);
  });

  it('turning updates off stops the interval', async () => {
    await controller.start();
    const client = await connectOther();
    const marker = shell.calls.length;
    await setRows(client, 'settings', [{ key: 'updates.enabled', value: false }]);
    await shell.waitFor('setUpdateState', (call) => !call.state.enabled, marker);
    expect(timers.intervals).toEqual([]);
    timers.fire();
    expect(updater.checks).toBe(1);
  });

  it('hands download progress and the ready state to the web app, the tray and a notification', async () => {
    releaseAvailable();
    const marker = shell.calls.length;
    await controller.start();
    expect(
      states(marker).map(
        (state) => `${state.status}${state.percent === null ? '' : ` ${state.percent}`}`,
      ),
    ).toEqual(['idle', 'checking', 'available 0', 'downloading 12', 'downloading 88', 'ready 100']);
    expect(controller.updateState).toMatchObject({ status: 'ready', version: '0.2.0' });
    expect(trayLabels(shell.last('setTray'))).toContain('Restart to update (0.2.0)');
    const notice = shell.last('notify');
    expect(notice?.notice).toMatchObject({ title: 'wow 0.2.0 is ready', path: updatesPath });
    notice?.click();
    expect(shell.last('openWindow')?.path).toBe(updatesPath);
    // A downloaded update is not looked for again.
    timers.fire();
    expect(updater.checks).toBe(1);
  });

  it('"Restart to update" stops the server before the installer starts', async () => {
    releaseAvailable();
    await controller.start();
    const server = controller.server;
    let serverRunningAtInstall: boolean | undefined;
    let serverInfoAtInstall: boolean | undefined;
    updater.onInstall = () => {
      serverRunningAtInstall = server?.running;
      serverInfoAtInstall = existsSync(path.join(home, serverInfoFileName));
    };
    controller.trayAction('installUpdate');
    await controller.quit();
    expect(updater.installs).toBe(1);
    expect(serverRunningAtInstall).toBe(false);
    expect(serverInfoAtInstall).toBe(false);
    expect(controller.installingUpdate).toBe(true);
    // Nothing asked: no work was running. The installer quits the app, not the controller.
    expect(shell.last('confirmUpdateRestart')).toBeUndefined();
    expect(shell.last('exit')).toBeUndefined();
  });

  it('says so when a turn is running and leaves everything as it was when the user declines', async () => {
    releaseAvailable();
    await controller.start();
    const client = await connectOther();
    let marker = shell.calls.length;
    await setRows(client, 'threads', [workingThread]);
    // Pushes arrive in order on the controller's socket; a round trip there has seen this one.
    await controller.toggleScheduler();
    await shell.waitFor('setTray', () => true, marker);
    shell.updateRestartAnswer = false;
    marker = shell.calls.length;
    await controller.installUpdate();
    const asked = await shell.waitFor('confirmUpdateRestart', () => true, marker);
    expect(asked.message).toMatch(/^1 thread has a turn running\./);
    expect(updater.installs).toBe(0);
    expect(controller.server?.running).toBe(true);

    shell.updateRestartAnswer = true;
    await controller.installUpdate();
    expect(updater.installs).toBe(1);
  });

  it('keeps the app running and shows the error when a check fails', async () => {
    updater.onCheck = () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    };
    await controller.start();
    expect(controller.updateState).toMatchObject({
      status: 'error',
      error: 'net::ERR_INTERNET_DISCONNECTED',
    });
    expect(states().at(-1)?.error).toBe('net::ERR_INTERNET_DISCONNECTED');
    expect(controller.server?.running).toBe(true);
    expect(shell.last('exit')).toBeUndefined();
    // The next interval tries again.
    releaseAvailable();
    timers.fire();
    expect(controller.updateState).toMatchObject({ status: 'ready', error: null });
  });

  it('starts the server again and shows the error when the installer cannot start', async () => {
    releaseAvailable();
    await controller.start();
    const first = controller.server;
    updater.onInstall = () => {
      throw new Error('installer missing');
    };
    const marker = shell.calls.length;
    await controller.installUpdate();
    const reopened = await shell.waitFor('openWindow', () => true, marker);
    expect(reopened.path).toBe(updatesPath);
    expect(reopened.endpoint.pid).not.toBe(first?.endpoint.pid);
    expect(controller.server?.running).toBe(true);
    expect(controller.installingUpdate).toBe(false);
    expect(controller.updateState).toMatchObject({ status: 'error', error: 'installer missing' });
    expect(shell.last('exit')).toBeUndefined();
  });

  it('does nothing in a build without an updater', async () => {
    controller = new DesktopController({
      shell,
      launchedHidden: false,
      newCommandId: () => 'cmd',
      startServer: () => ServerProcess.start(fakeLaunch(home)),
      connect: (endpoint) => RpcClient.connect(endpoint, () => undefined),
    });
    await controller.start();
    expect(controller.updateState).toBeUndefined();
    await controller.checkForUpdates();
    await controller.installUpdate();
    expect(shell.last('setUpdateState')).toBeUndefined();
    expect(controller.server?.running).toBe(true);
  });
});

describe('restartWarning', () => {
  it('names running turns and workflow runs, and nothing when all is quiet', () => {
    expect(restartWarning([{ state: 'idle' }], [{ state: 'waiting' }])).toBeUndefined();
    expect(
      restartWarning([{ state: 'working' }, { state: 'needs_you' }], [{ state: 'running' }]),
    ).toMatch(/^2 threads have turns running and 1 workflow run is running\. /);
  });
});
