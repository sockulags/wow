import { beforeAll, describe, expect, it } from 'vitest';
import { loadFixtures, type OutlookFixtures } from './fixtures.js';
import { MockOutlookSource } from './mock-source.js';
import {
  OutlookSync,
  diffCalendar,
  diffMail,
  type OutlookCalendarEntry,
  type OutlookFailure,
  type OutlookMailEntry,
  type OutlookSink,
  type OutlookSnapshot,
  type OutlookSyncSettings,
} from './sync.js';
import { FakeClock } from './testing.js';

const zone = 'Europe/Stockholm';

let fixtures: OutlookFixtures;
beforeAll(async () => {
  fixtures = await loadFixtures();
});

// Stands in for the server: applies diffs to in-memory tables the way it applies them to SQLite.
class TableSink implements OutlookSink {
  calendar = new Map<string, OutlookCalendarEntry>();
  mail = new Map<string, OutlookMailEntry>();
  status: {
    lastSyncAt: string | null;
    lastError: OutlookFailure | null;
    bridgeVersion: string | null;
  } = {
    lastSyncAt: null,
    lastError: null,
    bridgeVersion: null,
  };
  snapshots: OutlookSnapshot[] = [];

  synced(snapshot: OutlookSnapshot): void {
    this.snapshots.push(snapshot);
    const calendar = diffCalendar([...this.calendar.values()], snapshot);
    for (const id of calendar.remove) this.calendar.delete(id);
    for (const row of calendar.upsert) this.calendar.set(row.id, row);
    const mail = diffMail([...this.mail.values()], snapshot.mail);
    for (const id of mail.remove) this.mail.delete(id);
    for (const row of mail.upsert) this.mail.set(row.id, row);
    this.status = {
      lastSyncAt: snapshot.at,
      lastError: null,
      bridgeVersion: snapshot.bridgeVersion,
    };
  }

  failed(failure: OutlookFailure): void {
    this.status = { ...this.status, lastError: failure };
  }
}

function setup(overrides: Partial<OutlookSyncSettings> = {}) {
  // Wednesday 4 November 2026, 10:00 in Stockholm.
  const clock = new FakeClock('2026-11-04T09:00:00Z');
  const source = new MockOutlookSource({ fixtures, clock, zone });
  const sink = new TableSink();
  let settings: OutlookSyncSettings = {
    pollSeconds: 60,
    zone,
    firstDayOfWeek: 'monday',
    lookaheadDays: 6,
    folders: ['Inbox'],
    mailRail: true,
    mailLimit: 50,
    ...overrides,
  };
  const sync = new OutlookSync({ source, sink, clock, settings: () => settings });
  const change = (next: Partial<OutlookSyncSettings>) => {
    settings = { ...settings, ...next };
  };
  return { clock, source, sink, sync, change };
}

describe('OutlookSync', () => {
  it('stores one row per occurrence with unique ids, Teams links and cancelled state', async () => {
    const { sync, sink } = setup();
    expect(await sync.syncOnce()).toBe('synced');
    const rows = [...sink.calendar.values()];
    expect(rows.filter((row) => row.externalId.startsWith('mock-standup@'))).toHaveLength(7);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(sink.calendar.get('outlook:mock-design-review')).toMatchObject({
      title: 'Design review: search panel',
      start: '2026-11-05T09:00:00.000Z',
      zone,
      state: 'scheduled',
    });
    expect(sink.calendar.get('outlook:mock-design-review')?.joinUrl).toContain(
      'teams.microsoft.com',
    );
    expect(sink.calendar.get('outlook:mock-architecture-sync')?.state).toBe('cancelled');
    expect(sink.calendar.get('outlook:mock-offsite')?.allDay).toBe(true);
    expect([...sink.mail.keys()]).toEqual([
      'outlook-mail:mock-mail-build',
      'outlook-mail:mock-mail-review',
      'outlook-mail:mock-mail-offsite',
    ]);
    expect(sink.snapshots[0]?.unreadCount).toBe(3);
    expect(sink.status).toEqual({
      lastSyncAt: '2026-11-04T09:00:00.000Z',
      lastError: null,
      bridgeVersion: 'mock-1',
    });
  });

  it('reflects a moved and a deleted meeting on the next poll and keeps rows outside the window', async () => {
    const { sync, sink, source } = setup();
    await sync.syncOnce();
    const old = { ...(sink.calendar.get('outlook:mock-lunch') as OutlookCalendarEntry) };
    sink.calendar.set('outlook:last-month', {
      ...old,
      id: 'outlook:last-month',
      externalId: 'last-month',
      start: '2026-10-01T10:00:00.000Z',
      end: '2026-10-01T11:00:00.000Z',
    });
    source.setFixtures({
      appointments: fixtures.appointments
        .filter((item) => item.entryId !== 'mock-one-on-one')
        .map((item) => (item.entryId === 'mock-lunch' ? { ...item, time: '12:30' } : item)),
      messages: fixtures.messages.filter((message) => message.entryId !== 'mock-mail-build'),
    });
    await sync.syncOnce();
    expect(sink.calendar.get('outlook:mock-lunch')?.start).toBe('2026-11-04T11:30:00.000Z');
    expect([...sink.calendar.keys()].some((id) => id.startsWith('outlook:mock-one-on-one'))).toBe(
      false,
    );
    expect(sink.calendar.has('outlook:last-month')).toBe(true);
    expect(sink.mail.has('outlook-mail:mock-mail-build')).toBe(false);
  });

  it('keeps cached rows and reports since when Outlook became unavailable', async () => {
    const { sync, sink, source, clock } = setup();
    await sync.syncOnce();
    const cached = sink.calendar.size;
    source.setUnavailable('Outlook is not running');
    clock.advance(60_000);
    expect(await sync.syncOnce()).toBe('failed');
    clock.advance(60_000);
    await sync.syncOnce();
    expect(sink.calendar.size).toBe(cached);
    expect(sink.status.lastError).toEqual({
      at: '2026-11-04T09:02:00.000Z',
      code: 'unavailable',
      message: 'Outlook is not running',
      unavailableSince: '2026-11-04T09:01:00.000Z',
    });
    source.setUnavailable(null);
    await sync.syncOnce();
    expect(sink.status.lastError).toBeNull();
    expect(sink.status.lastSyncAt).toBe('2026-11-04T09:02:00.000Z');
  });

  it('reads the profile each poll and windows the week from it when settings say "outlook"', async () => {
    const { sync, sink, source } = setup({ zone: 'outlook', firstDayOfWeek: 'outlook' });
    source.setFixtures({
      ...fixtures,
      profile: { ...fixtures.profile, timeZoneId: 'Tokyo Standard Time', firstDayOfWeek: 0 },
    });
    await sync.syncOnce();
    const snapshot = sink.snapshots.at(-1);
    expect(snapshot?.profile).toMatchObject({ zone: 'Asia/Tokyo', firstDayOfWeek: 'sunday' });
    // Wednesday 4 November in Tokyo; the week starts on Sunday 1 November there.
    expect(snapshot?.window.from).toBe('2026-10-31T15:00:00.000Z');
    expect(snapshot?.calendar[0]?.zone).toBe('Asia/Tokyo');
  });

  it('keeps syncing with the last profile when reading the profile fails', async () => {
    const { sync, sink, source } = setup({ zone: 'outlook' });
    source.setFixtures({
      ...fixtures,
      profile: { ...fixtures.profile, timeZoneId: 'Tokyo Standard Time' },
    });
    await sync.syncOnce();
    expect(sink.snapshots.at(-1)?.profile?.zone).toBe('Asia/Tokyo');
    source.profile = () => Promise.reject(new Error('IPM.Configuration.WorkHours is locked'));
    expect(await sync.syncOnce()).toBe('synced');
    expect(sink.snapshots.at(-1)?.profile).toBeNull();
    expect(sink.snapshots.at(-1)?.calendar[0]?.zone).toBe('Asia/Tokyo');
  });

  it('keeps a short snippet of a meeting body without the Teams block', async () => {
    const { sync, sink } = setup();
    await sync.syncOnce();
    const standup = [...sink.calendar.values()].find((row) => row.title === 'Team standup');
    expect(standup?.snippet).toBe('Daily sync for the invented Lantern team.');
    expect(standup?.organizer).toBe('Ada Lindqvist');
  });

  it('clears the mail rail when it is turned off', async () => {
    const { sync, sink, change } = setup();
    await sync.syncOnce();
    change({ mailRail: false });
    await sync.syncOnce();
    expect(sink.mail.size).toBe(0);
    expect(sink.snapshots.at(-1)?.unreadCount).toBe(0);
  });

  it('polls on outlook.pollSeconds, reading the setting each time, and stops cleanly', async () => {
    const { sync, sink, clock, change } = setup({ pollSeconds: 60 });
    sync.start();
    await sync.whenIdle();
    expect(sink.snapshots).toHaveLength(1);
    clock.advance(59_999);
    await sync.whenIdle();
    expect(sink.snapshots).toHaveLength(1);
    change({ pollSeconds: 120 });
    clock.advance(1);
    await sync.whenIdle();
    expect(sink.snapshots).toHaveLength(2);
    clock.advance(60_000);
    await sync.whenIdle();
    expect(sink.snapshots).toHaveLength(2);
    clock.advance(60_000);
    await sync.whenIdle();
    expect(sink.snapshots).toHaveLength(3);
    await sync.stop();
    expect(clock.pendingTimers).toBe(0);
  });

  it('keeps polling when the sink throws', async () => {
    const clock = new FakeClock('2026-11-04T09:00:00Z');
    const errors: unknown[] = [];
    let calls = 0;
    const sync = new OutlookSync({
      source: new MockOutlookSource({ fixtures, clock, zone }),
      sink: {
        synced: () => {
          calls += 1;
          throw new Error('disk full');
        },
        failed: () => {},
      },
      clock,
      onError: (error) => errors.push(error),
      settings: () => ({
        pollSeconds: 30,
        zone,
        firstDayOfWeek: 'monday',
        lookaheadDays: 1,
        folders: ['Inbox'],
        mailRail: true,
        mailLimit: 5,
      }),
    });
    sync.start();
    await sync.whenIdle();
    clock.advance(30_000);
    await sync.whenIdle();
    expect(calls).toBe(2);
    expect(errors).toHaveLength(2);
    await sync.stop();
  });

  it('only upserts rows that changed', async () => {
    const { sync, sink } = setup();
    await sync.syncOnce();
    const snapshot = sink.snapshots[0] as OutlookSnapshot;
    expect(diffCalendar([...sink.calendar.values()], snapshot)).toEqual({ upsert: [], remove: [] });
    expect(diffMail([...sink.mail.values()], snapshot.mail)).toEqual({ upsert: [], remove: [] });
  });
});
