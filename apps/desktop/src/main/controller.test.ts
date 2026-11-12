import type { AppNotification, WorkflowRun } from '@wow/contracts';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeLaunch, temporaryHome } from '../test/fake-server.js';
import { FakeShell, trayLabels } from '../test/fake-shell.js';
import { DesktopController, newThreadPath } from './controller.js';
import { RpcClient } from './rpc-client.js';
import { ServerProcess, serverInfoFileName } from './server-process.js';

// The main-process lifecycle against a fake server: a real child process, a real WebSocket and
// real settings round trips, with Electron replaced by FakeShell.

// The fake server's test-only method. It is not in the contracts, so the client has no schema for
// its answer and rejects it; the answer only matters as a sign the rows were pushed.
const setRows = (client: RpcClient, topic: string, rows: unknown[]) =>
  (client.request as (method: string, params: unknown) => Promise<unknown>)('test.setRows', {
    topic,
    rows,
  }).catch(() => undefined);

const waitingRun: WorkflowRun = {
  id: 'run-1',
  workflowId: 'wf-1',
  projectId: 'p1',
  calendarItemId: 'card-1',
  backlogItemId: null,
  state: 'waiting',
  currentStep: 0,
  steps: [{ stepId: 's1', state: 'waiting', artifactsFound: [] }],
  startedAt: '2026-11-02T08:00:00.000Z',
  endedAt: null,
};

describe('DesktopController', () => {
  let home: string;
  let remove: () => Promise<void>;
  let shell: FakeShell;
  let controller: DesktopController;
  let commandIds: number;
  // A second connection, standing in for the scheduler and the web app changing server state.
  let other: RpcClient | undefined;

  const create = (options: { launchedHidden?: boolean } = {}) =>
    new DesktopController({
      shell,
      launchedHidden: options.launchedHidden ?? false,
      newCommandId: () => `cmd-${++commandIds}`,
      startServer: () => ServerProcess.start(fakeLaunch(home)),
      connect: (endpoint) => RpcClient.connect(endpoint, () => undefined),
    });

  const connectOther = async () => {
    const server = controller.server;
    if (server === undefined) throw new Error('server not started');
    other = await RpcClient.connect(server.endpoint, () => undefined);
    return other;
  };

  beforeEach(async () => {
    ({ home, remove } = await temporaryHome());
    shell = new FakeShell();
    commandIds = 0;
    controller = create();
  });

  afterEach(async () => {
    other?.close();
    other = undefined;
    await controller.quit();
    await remove();
  });

  it('starts the server, shows the tray and opens the window with the server endpoint', async () => {
    await controller.start();
    // The tray is there before the server is up, with only Quit usable.
    const first = shell.calls[0];
    expect(first?.kind === 'setTray' ? trayLabels(first) : []).toEqual([
      'Open (disabled)',
      'New thread (disabled)',
      'Pause scheduler (disabled)',
      'Quit',
    ]);
    const server = controller.server;
    expect(server?.running).toBe(true);
    const opened = shell.last('openWindow');
    expect(opened?.endpoint).toEqual(server?.endpoint);
    expect(opened?.path).toBeUndefined();
    expect(trayLabels(shell.last('setTray'))).toEqual([
      'Open',
      'New thread',
      'Pause scheduler',
      'Quit',
    ]);
    // Autostart is off by default; the login item is set to match.
    expect(shell.last('setLoginItem')?.openAtLogin).toBe(false);
  });

  it('keeps the server running when the window closes to the tray, and the tray reopens it', async () => {
    await controller.start();
    const opens = shell.calls.filter((call) => call.kind === 'openWindow').length;
    expect(controller.windowClosing()).toBe('hide');
    expect(controller.server?.running).toBe(true);
    // A trigger firing while the window is hidden still reaches the main process.
    const client = await connectOther();
    let marker = shell.calls.length;
    await setRows(client, 'workflowRuns', [{ ...waitingRun, state: 'running' }]);
    const started = await shell.waitFor('notify', () => true, marker);
    expect(started.notice.title).toBe('Workflow run started');
    marker = shell.calls.length;
    await setRows(client, 'workflowRuns', [waitingRun]);
    const notified = await shell.waitFor('notify', () => true, marker);
    expect(notified.notice.title).toBe('Waiting for you');
    controller.trayAction('open');
    expect(shell.calls.filter((call) => call.kind === 'openWindow')).toHaveLength(opens + 1);
    notified.click();
    expect(shell.last('openWindow')?.path).toBe('/workflows');
  });

  it('quits on close when close-to-tray is off, and stops the server cleanly', async () => {
    await controller.start();
    const client = await connectOther();
    const marker = shell.calls.length;
    await setRows(client, 'settings', [{ key: 'desktop.closeToTray', value: false }]);
    await shell.waitFor('setTray', () => controller.settings?.closeToTray === false, marker);
    const server = controller.server;
    expect(controller.windowClosing()).toBe('close');
    await shell.waitFor('exit');
    expect(server?.running).toBe(false);
    expect(existsSync(path.join(home, serverInfoFileName))).toBe(false);
  });

  it('pauses and resumes the scheduler through the scheduler.paused setting', async () => {
    await controller.start();
    let marker = shell.calls.length;
    controller.trayAction('toggleScheduler');
    const paused = await shell.waitFor(
      'setTray',
      (call) => trayLabels(call).includes('Resume scheduler'),
      marker,
    );
    expect(paused.tooltip).toBe('wow (scheduler paused)');
    marker = shell.calls.length;
    controller.trayAction('toggleScheduler');
    await shell.waitFor('setTray', (call) => trayLabels(call).includes('Pause scheduler'), marker);
    expect(controller.settings?.schedulerPaused).toBe(false);
  });

  it('opens the chat for a new thread from the tray', async () => {
    await controller.start();
    controller.trayAction('newThread');
    expect(shell.last('openWindow')?.path).toBe(newThreadPath);
  });

  it('follows the autostart setting with the login item', async () => {
    await controller.start();
    const client = await connectOther();
    const marker = shell.calls.length;
    await setRows(client, 'settings', [{ key: 'desktop.autostart', value: true }]);
    const set = await shell.waitFor('setLoginItem', () => true, marker);
    expect(set.openAtLogin).toBe(true);
  });

  it('starts in the tray when launched by the login item', async () => {
    controller = create({ launchedHidden: true });
    await controller.start();
    expect(shell.last('openWindow')).toBeUndefined();
    controller.trayAction('open');
    expect(shell.last('openWindow')).toBeDefined();
  });

  it('sends no notification when notifications are off', async () => {
    await controller.start();
    const client = await connectOther();
    let marker = shell.calls.length;
    await setRows(client, 'settings', [{ key: 'scheduler.notifications', value: false }]);
    await shell.waitFor('setTray', () => controller.settings?.notifications === false, marker);
    marker = shell.calls.length;
    await setRows(client, 'workflowRuns', [waitingRun]);
    // The fake server answers test.setRows after pushing, and pushes arrive in order on the
    // controller's socket, so a request round trip on that socket is enough to have seen it.
    await controller.toggleScheduler();
    expect(shell.calls.slice(marker).some((call) => call.kind === 'notify')).toBe(false);
  });

  const needsYou: AppNotification = {
    id: 't1:needs-you:tool-1',
    at: '2026-11-02T08:00:00.000Z',
    kind: 'waiting',
    title: 'Needs you: Kettle timer',
    body: 'Allow pnpm test?',
    path: '/chat/t1',
    runId: null,
    calendarItemId: null,
    threadId: 't1',
    approvalId: 't1:tool-1',
  };

  it('shows a chat thread that needs you with Allow once and Deny, which answer the approval', async () => {
    await controller.start();
    const client = await connectOther();
    const marker = shell.calls.length;
    await setRows(client, 'notifications', [needsYou]);
    const shown = await shell.waitFor('notify', () => true, marker);
    expect(shown.notice).toMatchObject({
      title: 'Needs you: Kettle timer',
      body: 'Allow pnpm test?',
    });
    expect(shown.actions.map((action) => action.label)).toEqual(['Allow once', 'Deny']);
    shown.actions[0]?.run();
    // The answer goes out on the controller's socket; a round trip on it after the click means
    // the dispatch was sent before the toggle's.
    await controller.toggleScheduler();
    const dispatched: unknown = JSON.parse(
      await readFile(path.join(home, 'dispatched.json'), 'utf8'),
    );
    expect(dispatched).toEqual([
      { type: 'approval.answer', approvalId: 't1:tool-1', decision: 'allowOnce' },
    ]);
    shown.click();
    expect(shell.last('openWindow')?.path).toBe('/chat/t1');
  });

  it('shows no chat notification while that thread is on screen in a focused window', async () => {
    await controller.start();
    const client = await connectOther();
    shell.route = '/chat/t1';
    const marker = shell.calls.length;
    await setRows(client, 'notifications', [needsYou]);
    await controller.toggleScheduler();
    expect(shell.calls.slice(marker).some((call) => call.kind === 'notify')).toBe(false);
  });

  it('asks before restarting a server that died, and quits when told not to', async () => {
    await controller.start();
    const server = controller.server;
    if (server === undefined) throw new Error('server not started');
    process.kill(server.endpoint.pid);
    const asked = await shell.waitFor('askRestart');
    expect(asked.message).toMatch(/stopped unexpectedly/);
    await shell.waitFor('exit');
    expect(shell.last('closeWindow')).toBeDefined();
  });

  it('restarts a server that died when told to, and reopens the window on the new one', async () => {
    shell.restartAnswer = true;
    await controller.start();
    const first = controller.server;
    if (first === undefined) throw new Error('server not started');
    const marker = shell.calls.length;
    process.kill(first.endpoint.pid);
    const reopened = await shell.waitFor('openWindow', () => true, marker);
    expect(reopened.endpoint.pid).not.toBe(first.endpoint.pid);
    expect(controller.server?.running).toBe(true);
  });
});
