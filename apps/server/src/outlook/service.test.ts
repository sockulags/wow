import type { CalendarItem, MailItem } from '@wow/contracts';
import { MockOutlookSource, loadFixtures, type Clock } from '@wow/outlook-bridge';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../core/engine.js';
import { snapshot } from '../core/subscriptions.js';
import { openDatabase, type Database } from '../db/database.js';
import { createLogger } from '../logger.js';
import { createHandlers, type Connection } from '../rpc/handlers.js';
import { route } from '../rpc/router.js';
import { SettingsService } from '../settings/service.js';
import { startOutlookService, type OutlookService } from './service.js';

// A clock whose timers never fire: the tests poll with refresh() instead of waiting.
const now = new Date('2026-11-04T10:00:00.000Z');
const frozen: Clock = { now: () => now, setTimeout: () => 0, clearTimeout: () => {} };

let database: Database;
let engine: Engine;
let settings: SettingsService;
let source: MockOutlookSource;
let service: OutlookService;
let ids = 0;

beforeEach(async () => {
  database = openDatabase(':memory:');
  engine = new Engine(database.db, { clock: () => now });
  settings = new SettingsService(database.db, engine);
  engine.dispatch('zone', {
    type: 'setting.set',
    key: 'calendar.zone',
    scope: 'global',
    value: 'Europe/Stockholm',
  });
  source = new MockOutlookSource({
    fixtures: await loadFixtures(),
    clock: frozen,
    zone: 'Europe/Stockholm',
  });
  service = await startOutlookService(
    'mock',
    {
      home: '/nowhere',
      settings,
      logger: createLogger(
        () => 'error',
        () => undefined,
      ),
      dispatch: (commandId, command) => engine.dispatch(commandId, command),
    },
    { source, clock: frozen },
  );
  await service.refresh();
});

afterEach(async () => {
  await service.stop();
  database.close();
});

const calendar = () => snapshot(database.db, { topic: 'calendarItems' }) as CalendarItem[];
const mail = () => snapshot(database.db, { topic: 'mailItems' }) as MailItem[];
const status = () => snapshot(database.db, { topic: 'outlookStatus' })[0];

describe('Outlook service', () => {
  it('stores the mock calendar and unread mail of the configured folders', () => {
    const standups = calendar().filter((item) => item.title === 'Team standup');
    // Monday to Friday of the current week plus the lookahead.
    expect(standups.length).toBeGreaterThanOrEqual(5);
    expect(new Set(standups.map((item) => item.id)).size).toBe(standups.length);
    expect(standups[0]).toMatchObject({
      source: 'outlook',
      zone: 'Europe/Stockholm',
      joinUrl: expect.stringContaining('teams.microsoft.com/l/meetup-join') as unknown,
    });
    expect(calendar().find((item) => item.title === 'Planning offsite')).toMatchObject({
      allDay: true,
    });
    expect(calendar().find((item) => item.title.startsWith('Canceled'))).toMatchObject({
      state: 'cancelled',
    });
    expect(mail().map((row) => row.subject)).toEqual([
      'Nightly build for lantern-web passed',
      "Notes before tomorrow's design review",
      'Offsite agenda draft',
    ]);
    expect(status()).toMatchObject({ lastError: null, unreadCount: 3 });
  });

  it('keeps the cache and records since when Outlook is unavailable', async () => {
    const before = calendar().length;
    source.setUnavailable('Outlook is not running');
    expect(await service.refresh()).toBe('failed');
    expect(status()).toMatchObject({
      lastError: 'Outlook is not running',
      unavailableSince: now.toISOString(),
    });
    expect(calendar()).toHaveLength(before);
    source.setUnavailable(null);
    expect(await service.refresh()).toBe('synced');
    expect(status()).toMatchObject({ lastError: null, unavailableSince: null });
  });

  it('opens a mail item in Outlook over RPC and reports a closed Outlook', async () => {
    const handlers = createHandlers({
      engine,
      subscriptions: undefined as never,
      workspaces: undefined as never,
      settings,
      secrets: undefined as never,
      db: undefined as never,
      skills: undefined as never,
      hosts: undefined as never,
      plans: undefined as never,
      workflows: undefined as never,
      providers: undefined as never,
      providerUpdates: undefined as never,
      trackers: undefined as never,
      detectProviders: () => Promise.resolve([]),
      discoverProjects: () => Promise.resolve([]),
      outlook: () => service,
      info: { version: '0.0.0', home: '/nowhere' },
    });
    const connection: Connection = { push: () => {}, subscriptionIds: new Set() };
    const call = (method: string, params: unknown) =>
      route(JSON.stringify({ id: `r${++ids}`, method, params }), handlers, connection, () => {});
    expect(await call('outlook.open', { entryId: 'mock-mail-build' })).toMatchObject({
      result: { opened: true },
    });
    expect(source.opened).toEqual(['mock-mail-build']);
    source.setUnavailable('Outlook is not running');
    expect(await call('outlook.open', { entryId: 'mock-mail-build' })).toMatchObject({
      error: { code: 'rejected', message: 'Outlook is not running' },
    });
    expect(await call('outlook.refresh', {})).toMatchObject({ result: { outcome: 'failed' } });
  });
});
