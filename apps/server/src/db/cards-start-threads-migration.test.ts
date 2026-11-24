import { settingsRegistry } from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockProviderAdapter } from '../hooks/index.js';
import { databaseFileName, startServer, type RunningServer } from '../server.js';
import { migrationsFolder } from './database.js';
import { calendarItems, settings, triggerEvents, triggers } from './schema.js';

// Scheduled jobs as main threads (orchestrator threads spec 27, 29): the migration gives every
// card a thread mode and removes event triggers, what they saw and their settings. The store is
// built with the migrations up to the one before, filled with invented rows, and then opened.

const previous = '0047_retire_chat_helpers';

let root: string;
let server: RunningServer | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-cards-threads-'));
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

async function previousMigrations(): Promise<string> {
  const folder = path.join(root, 'previous migrations');
  await cp(migrationsFolder, folder, { recursive: true });
  const journalFile = path.join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalFile, 'utf8')) as {
    entries: { tag: string }[];
  };
  const last = journal.entries.findIndex((entry) => entry.tag === previous);
  expect(last).toBeGreaterThan(-1);
  expect(journal.entries[last + 1]?.tag).toBe('0048_cards_start_threads');
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalFile, JSON.stringify(journal));
  return folder;
}

describe('migration 0048_cards_start_threads', () => {
  it('gives cards the new thread mode and removes event triggers with their settings', async () => {
    const home = path.join(root, 'before');
    await mkdir(home, { recursive: true });
    const old = new Sqlite(path.join(home, databaseFileName));
    migrate(drizzle({ client: old, casing: 'snake_case' }), {
      migrationsFolder: await previousMigrations(),
    });
    old
      .prepare(
        `insert into calendar_items (id, source, external_id, title, start, "end", zone, all_day,
          location, join_url, body, organizer, project_id, backlog_item_id, workflow_id, run_id,
          state, updated_at)
         values ('c1', 'local', null, 'Morning review', '2026-11-04T07:30:00.000Z',
          '2026-11-04T08:00:00.000Z', 'Europe/Stockholm', 0, null, null, null, null, null, null,
          null, null, 'scheduled', '2026-11-01T08:00:00.000Z')`,
      )
      .run();
    old
      .prepare(
        `insert into triggers (id, kind, workflow_id, project_id, event, enabled, created_at,
          offer_run_now)
         values ('on-merged', 'event', 'wf1', 'p1', 'merged', 1, '2026-11-01T08:00:00.000Z', 0)`,
      )
      .run();
    old
      .prepare(
        `insert into trigger_events (trigger_id, event_id, run_id, at)
         values ('on-merged', 'pr-1:merged', null, '2026-11-01T09:00:00.000Z')`,
      )
      .run();
    for (const key of ['triggers.eventsEnabled', 'triggers.forkPullRequests', 'hosts.polling']) {
      old
        .prepare(`insert into settings (key, scope, value) values (?, 'global', 'false')`)
        .run(key);
    }
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
      schedulerTimers: { setTimeout: () => undefined, clearTimeout: () => undefined },
      hostTimers: { setTimeout: () => undefined, clearTimeout: () => undefined },
      hooks: { providers: { claude: (row) => new MockProviderAdapter(row.kind) } },
    });
    const { db } = server.database;
    expect(db.select().from(calendarItems).all()).toMatchObject([
      { id: 'c1', threadMode: 'new', threadId: null, workflowName: null },
    ]);
    expect(db.select().from(triggers).all()).toEqual([]);
    expect(db.select().from(triggerEvents).all()).toEqual([]);
    expect(
      db
        .select()
        .from(settings)
        .all()
        .map((row) => row.key),
    ).toEqual(['hosts.polling']);
    expect(Object.keys(settingsRegistry).filter((key) => key.startsWith('triggers.'))).toEqual([]);
  });
});
