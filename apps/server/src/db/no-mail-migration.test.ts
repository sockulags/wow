import type { CalendarItem, SettingRow } from '@wow/contracts';
import { MockOutlookSource, loadFixtures, type Clock } from '@wow/outlook-bridge';
import { plainProtector } from '@wow/secrets';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '../core/subscriptions.js';
import { startOutlookService, type OutlookService } from '../outlook/service.js';
import { databaseFileName, startServer, type RunningServer } from '../server.js';
import { migrationsFolder } from './database.js';

// A store written before the app stopped reading mail (spec 4) still opens: the migration drops
// the cached mail and the unread count, the stored mail settings are gone without an error, and
// the meetings it holds still show. The store is built with the migrations up to the one before.

const previous = '0014_rules';
const now = new Date('2026-11-04T09:00:00.000Z');
// Timers never fire: the test polls Outlook with refresh().
const frozen: Clock = { now: () => now, setTimeout: () => 0, clearTimeout: () => {} };
const removedSettings = [
  'outlook.folders',
  'outlook.mailRail',
  'outlook.mailRailCollapsed',
  'outlook.mailLimit',
  'keybindings.toggleMailRail',
];

let root: string;
let server: RunningServer | undefined;
let outlook: OutlookService | undefined;

async function previousMigrations(): Promise<string> {
  const folder = path.join(root, 'previous migrations');
  await cp(migrationsFolder, folder, { recursive: true });
  const journalFile = path.join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalFile, 'utf8')) as {
    entries: { tag: string }[];
  };
  const last = journal.entries.findIndex((entry) => entry.tag === previous);
  expect(last).toBeGreaterThan(-1);
  expect(journal.entries[last + 1]?.tag).toBe('0015_no_mail');
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalFile, JSON.stringify(journal));
  return folder;
}

const columnsOf = (db: Sqlite.Database, table: string) =>
  (db.prepare(`select name from pragma_table_info('${table}')`).all() as { name: string }[]).map(
    (column) => column.name,
  );

const tablesOf = (db: Sqlite.Database) =>
  (db.prepare(`select name from sqlite_master where type = 'table'`).all() as { name: string }[])
    .map((row) => row.name)
    .toSorted();

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-migration-'));
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  outlook = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('migration 0015_no_mail', () => {
  it('drops the stored mail and its settings, and the meetings still show', async () => {
    const home = path.join(root, 'before');
    await mkdir(home, { recursive: true });
    const old = new Sqlite(path.join(home, databaseFileName));
    migrate(drizzle({ client: old, casing: 'snake_case' }), {
      migrationsFolder: await previousMigrations(),
    });
    expect(columnsOf(old, 'outlook_status')).toContain('unread_count');

    // What a server of the previous schema stored: a meeting from last month (outside the window
    // the next poll reads), two unread messages, the unread count, the mail settings, and the
    // event and receipt of the poll that read them. All invented.
    old
      .prepare(
        `insert into calendar_items (id, source, external_id, title, start, "end", zone, all_day,
          location, join_url, body, organizer, project_id, backlog_item_id, workflow_id, run_id,
          state, updated_at)
         values ('outlook:retro', 'outlook', 'retro', 'Lantern retro', '2026-10-01T09:00:00.000Z',
          '2026-10-01T10:00:00.000Z', 'Europe/Stockholm', 0, 'Room 2', null, null, 'Ada Lindqvist',
          null, null, null, null, 'scheduled', '2026-10-01T08:00:00.000Z')`,
      )
      .run();
    const message = old.prepare(
      `insert into mail_items (id, external_id, folder, "from", subject, received_at, unread, snippet)
       values (?, ?, 'Inbox', 'Build Robot', ?, '2026-11-04T08:00:00.000Z', 1, 'Invented')`,
    );
    message.run('outlook-mail:a', 'a', 'Nightly build passed');
    message.run('outlook-mail:b', 'b', 'Offsite agenda draft');
    old
      .prepare(
        `insert into outlook_status (id, last_sync_at, unread_count, bridge_version)
         values (1, '2026-11-04T08:00:00.000Z', 2, 'mock-1')`,
      )
      .run();
    const setting = old.prepare(`insert into settings (key, scope, value) values (?, 'global', ?)`);
    setting.run('outlook.mailRail', 'false');
    setting.run('outlook.mailRailCollapsed', 'true');
    setting.run('outlook.mailLimit', '20');
    setting.run('outlook.folders', '["Inbox","Newsletters"]');
    setting.run('keybindings.toggleMailRail', '"Shift+M"');
    setting.run('outlook.pollSeconds', '120');
    const polled = {
      at: '2026-11-04T08:00:00.000Z',
      calendarUpsert: [],
      calendarRemove: [],
      mailUpsert: [{ id: 'outlook-mail:a', subject: 'Nightly build passed' }],
      mailRemove: [],
      unreadCount: 2,
      bridgeVersion: 'mock-1',
      profile: null,
    };
    old
      .prepare(
        `insert into events (at, kind, aggregate, payload) values (?, 'outlook.synced', 'outlook', ?)`,
      )
      .run(polled.at, JSON.stringify(polled));
    old
      .prepare(
        `insert into command_receipts (command_id, command_type, fingerprint, seqs, at)
         values ('poll-1', 'outlook.sync', ?, '[1]', ?)`,
      )
      .run(JSON.stringify({ mail: [{ subject: 'Nightly build passed' }] }), polled.at);
    old.close();

    const fixtures = await loadFixtures();
    const logged: { level: string; message: string }[] = [];
    server = await startServer({
      home,
      env: {},
      platform: 'linux',
      port: 0,
      protector: plainProtector,
      logSink: (line) => logged.push(JSON.parse(line) as { level: string; message: string }),
      userHome: path.join(root, 'user'),
      watchSkills: () => ({ close: () => Promise.resolve() }),
      clock: () => now,
      schedulerTimers: { setTimeout: () => undefined, clearTimeout: () => undefined },
      hostTimers: { setTimeout: () => undefined, clearTimeout: () => undefined },
      hooks: {
        outlook: async (_mode, context) => {
          const source = new MockOutlookSource({
            fixtures,
            clock: frozen,
            zone: 'Europe/Stockholm',
          });
          outlook = await startOutlookService('mock', context, { source, clock: frozen });
          return outlook;
        },
      },
    });
    const db = server.database.sqlite;
    expect(tablesOf(db)).not.toContain('mail_items');
    expect(columnsOf(db, 'outlook_status')).not.toContain('unread_count');

    // The stored mail settings are gone; the others are kept.
    const settings = snapshot(server.database.db, { topic: 'settings' }) as SettingRow[];
    expect(settings.map((row) => row.key)).toEqual(['outlook.pollSeconds']);
    expect(server.settings.get('outlook.pollSeconds')).toBe(120);
    expect(server.settings.resolveAll().map((row) => row.key)).not.toEqual(
      expect.arrayContaining(removedSettings),
    );

    // No mail is left in the history either.
    const payload = JSON.parse(
      (
        db.prepare(`select payload from events where kind = 'outlook.synced'`).get() as {
          payload: string;
        }
      ).payload,
    ) as Record<string, unknown>;
    expect(Object.keys(payload).toSorted()).toEqual([
      'at',
      'bridgeVersion',
      'calendarRemove',
      'calendarUpsert',
      'profile',
    ]);
    expect(
      db
        .prepare(`select count(*) as n from command_receipts where command_type = 'outlook.sync'`)
        .get(),
    ).toEqual({ n: 0 });

    // The cached meeting still shows, and a poll after the migration adds this week's meetings.
    const meetings = () =>
      (snapshot(server!.database.db, { topic: 'calendarItems' }) as CalendarItem[]).map(
        (item) => item.title,
      );
    expect(meetings()).toContain('Lantern retro');
    expect(await outlook?.refresh()).toBe('synced');
    expect(meetings()).toEqual(expect.arrayContaining(['Lantern retro', 'Team standup']));
    expect(snapshot(server.database.db, { topic: 'outlookStatus' })).toEqual([
      expect.objectContaining({ lastError: null, bridgeVersion: 'mock-1' }),
    ]);
    expect(logged.filter((entry) => entry.level === 'error')).toEqual([]);
  });
});
