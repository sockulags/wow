import type { ResolvedSetting, Workflow, WorkflowRun } from '@wow/contracts';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appId, decodeServerInfoArg, encodeServerInfoArg } from '../app.js';
import { rendererFile } from './app-protocol.js';
import { readDesktopSettings } from './desktop-settings.js';
import { runNotices, runStates } from './notifications.js';
import { trayMenu, trayTooltip } from './tray-menu.js';

const run = (
  id: string,
  state: WorkflowRun['state'],
  overrides: Partial<WorkflowRun> = {},
): WorkflowRun => ({
  id,
  workflowId: 'wf-feature',
  projectId: 'p1',
  calendarItemId: null,
  backlogItemId: null,
  state,
  currentStep: 1,
  steps: [
    { stepId: 's1', state: 'done', artifactsFound: [] },
    { stepId: 's2', state: 'waiting', artifactsFound: [] },
  ],
  startedAt: '2026-11-02T08:00:00.000Z',
  endedAt: null,
  ...overrides,
});

const workflow: Workflow = {
  id: 'wf-feature',
  name: 'Feature',
  templateKind: 'feature',
  steps: [],
  createdAt: '2026-11-01T08:00:00.000Z',
  updatedAt: '2026-11-01T08:00:00.000Z',
};

describe('app identity', () => {
  it('has a reverse-domain app id', () => {
    expect(appId).toMatch(/^[a-z]+(\.[a-z]+)+$/);
  });

  it('carries server.json to the preload through a renderer argument', () => {
    const info = { port: 4317, token: 'a b/c?d=e&f' };
    expect(decodeServerInfoArg(['--other', encodeServerInfoArg(info)])).toEqual(info);
    expect(decodeServerInfoArg(['--other'])).toBeUndefined();
  });
});

describe('runNotices', () => {
  it('stays quiet on the first snapshot', () => {
    expect(runNotices(undefined, [run('r1', 'waiting')], [workflow])).toEqual([]);
  });

  it('announces a new run, a run that waits for you and a run that failed', () => {
    const before = runStates([run('r1', 'running'), run('r2', 'running')]);
    const notices = runNotices(
      before,
      [run('r1', 'waiting'), run('r2', 'failed'), run('r3', 'running', { currentStep: 0 })],
      [workflow],
    );
    expect(notices).toEqual([
      { runId: 'r1', title: 'Waiting for you', body: 'Feature, step 2 of 2', path: '/workflows' },
      {
        runId: 'r2',
        title: 'Workflow run failed',
        body: 'Feature, step 2 of 2',
        path: '/workflows',
      },
      {
        runId: 'r3',
        title: 'Workflow run started',
        body: 'Feature, step 1 of 2',
        path: '/workflows',
      },
    ]);
  });

  it('says nothing for unchanged runs or states nobody waits on', () => {
    const before = runStates([run('r1', 'waiting'), run('r2', 'waiting')]);
    expect(runNotices(before, [run('r1', 'waiting'), run('r2', 'done')], [])).toEqual([]);
  });
});

describe('trayMenu', () => {
  it('offers open, new thread, pause and quit', () => {
    const entries = trayMenu({ serverReady: true, schedulerPaused: false });
    expect(entries.map((entry) => (entry.kind === 'item' ? entry.label : '-'))).toEqual([
      'Open',
      'New thread',
      'Pause scheduler',
      '-',
      'Quit',
    ]);
    expect(trayTooltip({ serverReady: true, schedulerPaused: false })).toBe('wow');
  });

  it('offers resume while paused and only quit while the server is not ready', () => {
    expect(trayMenu({ serverReady: true, schedulerPaused: true })[2]).toMatchObject({
      label: 'Resume scheduler',
      action: 'toggleScheduler',
    });
    const starting = trayMenu({ serverReady: false, schedulerPaused: false });
    expect(
      starting.flatMap((entry) => (entry.kind === 'item' && entry.enabled ? [entry.action] : [])),
    ).toEqual(['quit']);
    expect(trayTooltip({ serverReady: false, schedulerPaused: false })).toBe('wow (starting)');
  });
});

describe('readDesktopSettings', () => {
  it('falls back to registry defaults for missing or invalid values', () => {
    expect(readDesktopSettings([])).toEqual({
      autostart: false,
      closeToTray: true,
      startMinimized: false,
      schedulerPaused: false,
      notifications: true,
    });
    const resolved: ResolvedSetting[] = [
      { key: 'desktop.autostart', value: true, source: 'global' },
      { key: 'desktop.closeToTray', value: 'yes', source: 'global' },
      { key: 'scheduler.paused', value: true, source: 'global' },
    ];
    expect(readDesktopSettings(resolved)).toMatchObject({
      autostart: true,
      closeToTray: true,
      schedulerPaused: true,
    });
  });
});

describe('rendererFile', () => {
  const dir = path.resolve('renderer');

  it('serves files of the built web app and index.html for router paths', () => {
    expect(rendererFile(dir, 'wow://app/assets/index-1.js')).toBe(
      path.join(dir, 'assets', 'index-1.js'),
    );
    expect(rendererFile(dir, 'wow://app/')).toBe(path.join(dir, 'index.html'));
    expect(rendererFile(dir, 'wow://app/settings/desktop?x=1')).toBe(path.join(dir, 'index.html'));
  });

  it('refuses other hosts and paths outside the renderer directory', () => {
    expect(rendererFile(dir, 'wow://other/index.html')).toBeUndefined();
    // Dot segments, plain or encoded, stop at the renderer directory.
    expect(rendererFile(dir, 'wow://app/%2e%2e/%2e%2e/secret.txt')).toBe(
      path.join(dir, 'secret.txt'),
    );
    expect(rendererFile(dir, 'wow://app/assets/%2e%2e%2f%2e%2e%2fsecret.txt')).toBe(
      path.join(dir, 'secret.txt'),
    );
    expect(rendererFile(dir, 'wow://app/..%5c..%5csecret.txt')).toBeUndefined();
    expect(rendererFile(dir, 'not a url')).toBeUndefined();
  });
});
