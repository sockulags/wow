import type { CalendarItem } from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCalendarRange } from '../core/series.js';
import { snapshot } from '../core/subscriptions.js';
import { MockProviderAdapter } from '../hooks/index.js';
import { databaseFileName, startServer, type RunningServer } from '../server.js';
import { migrationsFolder } from './database.js';

// Recurring cards spec 10: a repeating card stored before past series were kept loads with none,
// and its first change keeps the days already gone by where they were. All invented.

const previous = '0022_repeating_cards';
let root: string;
let server: RunningServer | undefined;

async function previousMigrations(): Promise<string> {
  const folder = path.join(root, 'previous migrations');
  await cp(migrationsFolder, folder, { recursive: true });
  const journalFile = path.join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalFile, 'utf8')) as {
    entries: { tag: string }[];
  };
  const last = journal.entries.findIndex((entry) => entry.tag === previous);
  expect(last).toBeGreaterThan(-1);
  expect(journal.entries[last + 1]?.tag).toBe('0023_past_series');
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalFile, JSON.stringify(journal));
  return folder;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-migration-'));
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('migration 0023_past_series', () => {
  it('loads a repeating card without past series and keeps its past days on the first change', async () => {
    const home = path.join(root, 'before');
    await mkdir(home, { recursive: true });
    const old = new Sqlite(path.join(home, databaseFileName));
    migrate(drizzle({ client: old, casing: 'snake_case' }), {
      migrationsFolder: await previousMigrations(),
    });
    // A plain card every day at 08:30 in Stockholm from Monday 2 November.
    old
      .prepare(
        `insert into calendar_items (id, source, external_id, title, start, "end", zone, all_day,
          location, join_url, body, organizer, project_id, backlog_item_id, workflow_id, run_id,
          state, updated_at, repeat, skipped_dates, next_at)
         values ('c1', 'local', null, 'Tea round', '2026-11-02T07:30:00.000Z',
          '2026-11-02T08:00:00.000Z', 'Europe/Stockholm', 0, null, null, null, null, null, null,
          null, null, 'scheduled', '2026-11-01T08:00:00.000Z', ?, '[]', null)`,
      )
      .run(
        JSON.stringify({ frequency: 'daily', interval: 1, weekdays: [], end: { kind: 'never' } }),
      );
    old.close();

    server = await startServer({
      home,
      env: {},
      platform: 'linux',
      port: 0,
      protector: plainProtector,
      logSink: () => undefined,
      userHome: path.join(root, 'user'),
      watchSkills: () => ({ close: () => Promise.resolve() }),
      clock: () => new Date('2026-11-04T12:00:00.000Z'),
      schedulerTimers: { setTimeout: () => undefined, clearTimeout: () => undefined },
      hooks: { providers: { claude: (row) => new MockProviderAdapter(row.kind) } },
    });
    const db = server.database.db;
    const [card] = snapshot(db, { topic: 'calendarItems' }) as CalendarItem[];
    expect(card).toMatchObject({ id: 'c1', pastSeries: [] });

    // 09:30 from now on: Monday to Wednesday have gone by and stay at 08:30.
    server.engine.dispatch('move', {
      type: 'card.update',
      cardId: 'c1',
      start: '2026-11-02T08:30:00.000Z',
      end: '2026-11-02T09:00:00.000Z',
    });
    const range = readCalendarRange(
      db,
      { from: '2026-11-02T00:00:00.000Z', to: '2026-11-07T00:00:00.000Z' },
      200,
    );
    expect(range.occurrences.map((occurrence) => [occurrence.date, occurrence.start])).toEqual([
      ['2026-11-02', '2026-11-02T07:30:00.000Z'],
      ['2026-11-03', '2026-11-03T07:30:00.000Z'],
      ['2026-11-04', '2026-11-04T07:30:00.000Z'],
      ['2026-11-05', '2026-11-05T08:30:00.000Z'],
      ['2026-11-06', '2026-11-06T08:30:00.000Z'],
    ]);
  });
});
