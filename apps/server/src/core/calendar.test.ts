import type { CalendarItem, Command, OutlookCalendarRow, ServerCommand } from '@wow/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../db/database.js';
import { diffOutlookCalendar } from './calendar.js';
import { Engine } from './engine.js';
import { CommandRejected } from './orchestrator.js';
import { readModel } from './projector.js';
import { snapshot } from './subscriptions.js';

let database: Database;
let engine: Engine;
let now = '2026-11-02T08:00:00.000Z';
let ids = 0;

const run = (command: ServerCommand) => engine.dispatch(`c${++ids}`, command);
const rejection = (command: ServerCommand) => {
  try {
    run(command);
  } catch (error) {
    if (error instanceof CommandRejected) return { code: error.code, message: error.message };
    throw error;
  }
  return undefined;
};
const items = () => snapshot(database.db, { topic: 'calendarItems' }) as CalendarItem[];
const status = () => snapshot(database.db, { topic: 'outlookStatus' })[0];
const eventCount = () =>
  (database.sqlite.prepare('select count(*) as n from events').get() as { n: number }).n;

const card: Command = {
  type: 'card.create',
  cardId: 'card-1',
  title: 'Write the plan',
  start: '2026-11-03T09:00:00.000Z',
  end: '2026-11-03T10:00:00.000Z',
  zone: 'Europe/Stockholm',
};

const standup = (day: string, overrides: Partial<OutlookCalendarRow> = {}): OutlookCalendarRow => ({
  id: `outlook:standup@${day}T08:15:00.000Z`,
  externalId: `standup@${day}T08:15:00.000Z`,
  title: 'Team standup',
  start: `${day}T08:15:00.000Z`,
  end: `${day}T08:30:00.000Z`,
  zone: 'Europe/Stockholm',
  allDay: false,
  location: 'Microsoft Teams Meeting',
  joinUrl: 'https://teams.microsoft.com/l/meetup-join/invented',
  body: null,
  organizer: 'Ada Lindqvist',
  state: 'scheduled',
  ...overrides,
});

const window = { from: '2026-11-02T00:00:00.000Z', to: '2026-11-09T00:00:00.000Z' };

const sync = (calendar: OutlookCalendarRow[]): ServerCommand => ({
  type: 'outlook.sync',
  at: now,
  window,
  calendar,
  bridgeVersion: 'mock-1',
  profile: null,
});

beforeEach(() => {
  database = openDatabase(':memory:');
  engine = new Engine(database.db, { clock: () => new Date(now) });
  now = '2026-11-02T08:00:00.000Z';
});

afterEach(() => database.close());

describe('cards', () => {
  it('stores a scheduled local card with its links', () => {
    run({ type: 'project.create', projectId: 'p1', name: 'wow', cwd: '/work/wow' });
    run({ ...card, projectId: 'p1' });
    expect(items()).toEqual([
      expect.objectContaining({
        id: 'card-1',
        source: 'local',
        title: 'Write the plan',
        start: '2026-11-03T09:00:00.000Z',
        end: '2026-11-03T10:00:00.000Z',
        zone: 'Europe/Stockholm',
        allDay: false,
        projectId: 'p1',
        workflowId: null,
        state: 'scheduled',
      }),
    ]);
  });

  it('refuses a card that ends before it starts or links to nothing', () => {
    expect(rejection({ ...card, end: card.start })?.code).toBe('rejected');
    expect(rejection({ ...card, projectId: 'missing' })?.code).toBe('not_found');
    expect(rejection({ ...card, workflowId: 'missing' })?.code).toBe('not_found');
    expect(rejection({ ...card, backlogItemId: 'missing' })?.code).toBe('not_found');
    expect(rejection({ ...card, cardId: 'outlook:sneaky' })?.code).toBe('rejected');
    expect(items()).toEqual([]);
  });

  it('moves and resizes a card and records only what changed', () => {
    run(card);
    now = '2026-11-02T08:05:00.000Z';
    run({
      type: 'card.update',
      cardId: 'card-1',
      start: '2026-11-04T13:00:00.000Z',
      end: '2026-11-04T14:00:00.000Z',
    });
    run({ type: 'card.update', cardId: 'card-1', end: '2026-11-04T14:45:00.000Z' });
    const before = eventCount();
    expect(run({ type: 'card.update', cardId: 'card-1', title: 'Write the plan' }).seqs).toEqual(
      [],
    );
    expect(eventCount()).toBe(before);
    expect(items()[0]).toMatchObject({
      start: '2026-11-04T13:00:00.000Z',
      end: '2026-11-04T14:45:00.000Z',
      updatedAt: '2026-11-02T08:05:00.000Z',
    });
    expect(
      rejection({ type: 'card.update', cardId: 'card-1', end: '2026-11-04T12:00:00.000Z' })?.code,
    ).toBe('rejected');
  });

  it('deletes a card', () => {
    run(card);
    run({ type: 'card.delete', cardId: 'card-1' });
    expect(items()).toEqual([]);
    expect(rejection({ type: 'card.delete', cardId: 'card-1' })?.code).toBe('not_found');
  });

  it('never changes an Outlook item through a card command', () => {
    run(sync([standup('2026-11-03')]));
    const id = 'outlook:standup@2026-11-03T08:15:00.000Z';
    expect(rejection({ type: 'card.update', cardId: id, title: 'Mine now' })).toEqual({
      code: 'rejected',
      message: 'Outlook items are read-only',
    });
    expect(rejection({ type: 'card.delete', cardId: id })?.code).toBe('rejected');
  });
});

describe('outlook sync', () => {
  it('caches Outlook items and records the status', () => {
    run(card);
    run(sync([standup('2026-11-03'), standup('2026-11-04')]));
    expect(items().map((item) => [item.id, item.source])).toEqual([
      ['outlook:standup@2026-11-03T08:15:00.000Z', 'outlook'],
      ['card-1', 'local'],
      ['outlook:standup@2026-11-04T08:15:00.000Z', 'outlook'],
    ]);
    expect(status()).toEqual({
      lastSyncAt: now,
      lastError: null,
      unavailableSince: null,
      bridgeVersion: 'mock-1',
      profile: null,
    });
  });

  it('stores the Outlook profile and keeps it through a poll that could not read it (F-8)', () => {
    const profile = {
      zone: 'Europe/Stockholm',
      workHours: { start: '08:30', end: '17:00', days: ['monday' as const, 'friday' as const] },
      firstDayOfWeek: 'monday' as const,
      address: 'you@lantern.example',
    };
    type Sync = Extract<ServerCommand, { type: 'outlook.sync' }>;
    const polled = (rows: OutlookCalendarRow[], changes: Partial<Sync>): Sync => ({
      ...(sync(rows) as Sync),
      ...changes,
    });
    run(polled([standup('2026-11-03', { organizer: 'Bo Strand', body: 'Agenda' })], { profile }));
    expect((status() as { profile?: unknown } | undefined)?.profile).toEqual(profile);
    run(polled([standup('2026-11-03')], { at: '2026-11-03T12:01:00.000Z' }));
    expect((status() as { profile?: unknown } | undefined)?.profile).toEqual(profile);
    run(polled([], { profile: { ...profile, firstDayOfWeek: 'sunday' } }));
    expect(
      (status() as { profile?: { firstDayOfWeek: string } } | undefined)?.profile?.firstDayOfWeek,
    ).toBe('sunday');
  });

  it('applies moved, cancelled and deleted meetings and keeps rows outside the window', () => {
    const old = standup('2026-10-28');
    run(sync([old, standup('2026-11-03'), standup('2026-11-04')]));
    now = '2026-11-02T08:01:00.000Z';
    // The 3rd moved to 09:00 (a new occurrence id), the 4th was cancelled, and the row from the
    // previous week is outside the polled window.
    run(
      sync([
        standup('2026-11-03', {
          id: 'outlook:standup@2026-11-03T09:00:00.000Z',
          externalId: 'standup@2026-11-03T09:00:00.000Z',
          start: '2026-11-03T09:00:00.000Z',
          end: '2026-11-03T09:15:00.000Z',
        }),
        standup('2026-11-04', { state: 'cancelled', title: 'Canceled: Team standup' }),
      ]),
    );
    expect(items().map((item) => [item.id, item.state])).toEqual([
      [old.id, 'scheduled'],
      ['outlook:standup@2026-11-03T09:00:00.000Z', 'scheduled'],
      ['outlook:standup@2026-11-04T08:15:00.000Z', 'cancelled'],
    ]);
  });

  it('stores only what changed', () => {
    run(sync([standup('2026-11-03')]));
    now = '2026-11-02T08:01:00.000Z';
    run(sync([standup('2026-11-03')]));
    const last = database.sqlite
      .prepare('select payload from events order by seq desc limit 1')
      .get() as { payload: string };
    expect(JSON.parse(last.payload)).toEqual({
      at: '2026-11-02T08:01:00.000Z',
      calendarUpsert: [],
      calendarRemove: [],
      bridgeVersion: 'mock-1',
      profile: null,
    });
  });

  it('keeps the cache on failure, records the error once, and clears it on the next sync', () => {
    run(sync([standup('2026-11-03')]));
    const failure: ServerCommand = {
      type: 'outlook.fail',
      at: '2026-11-02T08:01:00.000Z',
      code: 'unavailable',
      message: 'Outlook is not running',
      unavailableSince: '2026-11-02T08:01:00.000Z',
    };
    run(failure);
    const after = eventCount();
    expect(run({ ...failure, at: '2026-11-02T08:02:00.000Z' }).seqs).toEqual([]);
    expect(eventCount()).toBe(after);
    expect(status()).toMatchObject({
      lastSyncAt: '2026-11-02T08:00:00.000Z',
      lastError: 'Outlook is not running',
      unavailableSince: '2026-11-02T08:01:00.000Z',
    });
    expect(items()).toHaveLength(1);

    now = '2026-11-02T08:03:00.000Z';
    run(sync([standup('2026-11-03')]));
    expect(status()).toMatchObject({ lastError: null, unavailableSince: null });
  });

  it('reads the stored Outlook rows for the diff, never the cards', () => {
    run(card);
    expect(readModel(database.db).outlookCalendarItems()).toEqual([]);
    const incoming = { ...items()[0]!, id: 'outlook:x', source: 'outlook' as const };
    expect(diffOutlookCalendar([], [incoming], window).upsert).toEqual([incoming]);
  });
});
