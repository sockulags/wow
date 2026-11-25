import type { ResolvedSetting } from '@wow/contracts';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appId, decodeServerInfoArg, encodeServerInfoArg } from '../app.js';
import { opensOutside, rendererFile } from './app-protocol.js';
import { readDesktopSettings } from './desktop-settings.js';
import { chatNotices, routeOf } from './notifications.js';
import { applicationMenu } from './app-menu.js';
import { trayMenu, traySummary, trayTooltip } from './tray-menu.js';

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

const chatRow = (id: string, threadId: string | null) => ({
  id,
  at: '2026-11-02T08:00:00.000Z',
  kind: 'waiting' as const,
  title: 'Needs you: Kettle timer',
  body: 'Allow pnpm test?',
  path: '/chat/t1',
  calendarItemId: null,
  threadId,
  approvalId: threadId === null ? null : 't1:tool-1',
});

describe('chatNotices', () => {
  it('stays quiet on the first snapshot and tells only new chat rows after it', () => {
    expect(chatNotices(undefined, [chatRow('n1', 't1')])).toEqual([]);
    expect(
      chatNotices(new Set(['n1']), [chatRow('n3', null), chatRow('n2', 't1'), chatRow('n1', 't1')]),
    ).toEqual([
      {
        id: 'n2',
        title: 'Needs you: Kettle timer',
        body: 'Allow pnpm test?',
        path: '/chat/t1',
        approvalId: 't1:tool-1',
      },
    ]);
  });

  it('reads the route of a window that shows the app', () => {
    expect(routeOf('wow://app/chat/t1', 'wow://app')).toBe('/chat/t1');
    expect(routeOf('https://example.com/chat/t1', 'wow://app')).toBeUndefined();
  });
});

describe('trayMenu', () => {
  it('offers open, new thread, pause and quit', () => {
    const entries = trayMenu({ serverReady: true, schedulerPaused: false, updateReady: undefined });
    expect(entries.map((entry) => (entry.kind === 'item' ? entry.label : '-'))).toEqual([
      'Open',
      'New thread',
      'Pause scheduler',
      '-',
      'Quit',
    ]);
    expect(trayTooltip({ serverReady: true, schedulerPaused: false, updateReady: undefined })).toBe(
      'wow',
    );
  });

  it('offers resume while paused and only quit while the server is not ready', () => {
    expect(
      trayMenu({ serverReady: true, schedulerPaused: true, updateReady: undefined })[2],
    ).toMatchObject({
      label: 'Resume scheduler',
      action: 'toggleScheduler',
    });
    const starting = trayMenu({
      serverReady: false,
      schedulerPaused: false,
      updateReady: undefined,
    });
    expect(
      starting.flatMap((entry) => (entry.kind === 'item' && entry.enabled ? [entry.action] : [])),
    ).toEqual(['quit']);
    expect(
      trayTooltip({ serverReady: false, schedulerPaused: false, updateReady: undefined }),
    ).toBe('wow (starting)');
  });

  it('offers "Restart to update" above Quit once an update is downloaded', () => {
    const entries = trayMenu({ serverReady: true, schedulerPaused: false, updateReady: '0.2.0' });
    expect(entries.at(-2)).toMatchObject({
      label: 'Restart to update (0.2.0)',
      action: 'installUpdate',
      enabled: true,
    });
    expect(trayTooltip({ serverReady: true, schedulerPaused: false, updateReady: '0.2.0' })).toBe(
      'wow (update 0.2.0 ready)',
    );
  });
});

describe('readDesktopSettings', () => {
  it('falls back to registry defaults for missing or invalid values', () => {
    expect(readDesktopSettings([])).toEqual({
      autostart: false,
      closeToTray: true,
      startMinimized: false,
      schedulerPaused: false,
      updatesEnabled: true,
      updateCheckIntervalMinutes: 240,
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

describe('opensOutside', () => {
  it('hands http, https and mailto links to the system and nothing else', () => {
    expect(opensOutside('https://docs.example.test/plan')).toBe(true);
    expect(opensOutside('http://docs.example.test/plan')).toBe(true);
    expect(opensOutside('mailto:team@example.test')).toBe(true);
    expect(opensOutside('MAILTO:team@example.test')).toBe(true);
    expect(opensOutside('file:///c:/secret.txt')).toBe(false);
    expect(opensOutside('javascript:alert(1)')).toBe(false);
    expect(opensOutside('wow://app/')).toBe(false);
  });
});

describe('tray summary', () => {
  it('says how many need you and what fires next', () => {
    const summary = traySummary(
      [{ state: 'needs_you' }, { state: 'idle' }, { state: 'needs_you' }],
      [
        { state: 'fired', runAt: '2026-11-02T09:00:00.000Z', calendarItemId: 'old' },
        { state: 'scheduled', runAt: '2026-11-02T17:30:00.000Z', calendarItemId: 'late' },
        { state: 'scheduled', runAt: '2026-11-02T15:30:00.000Z', calendarItemId: 'soon' },
      ],
      [
        { id: 'soon', title: 'Nightly triage' },
        { id: 'late', title: 'Release' },
      ],
      new Date('2026-11-02T12:00:00.000Z'),
      (instant) => instant.toISOString().slice(11, 16),
    );
    expect(summary).toEqual({ needsYou: 2, next: { title: 'Nightly triage', at: '15:30' } });
    const state = { serverReady: true, schedulerPaused: false, updateReady: undefined, ...summary };
    expect(trayMenu(state).slice(0, 2)).toMatchObject([
      { label: '2 need you', action: 'openChat' },
      { label: 'Next: Nightly triage at 15:30', action: 'openCalendar' },
    ]);
    expect(trayTooltip(state)).toBe('wow · 2 need you');
  });
});

describe('application menu', () => {
  it('drops the default zoom, reload and DevTools menu in packaged builds', () => {
    expect(applicationMenu('win32', true)).toBeNull();
    expect(applicationMenu('linux', true)).toBeNull();
    expect(applicationMenu('darwin', true)).toEqual([{ role: 'appMenu' }, { role: 'editMenu' }]);
    expect(applicationMenu('win32', false)).toBeUndefined();
  });
});
