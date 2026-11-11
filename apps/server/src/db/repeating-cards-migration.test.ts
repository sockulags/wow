import type { CalendarItem, ProviderInstance, WorkflowRun } from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '../core/subscriptions.js';
import { MockProviderAdapter } from '../hooks/index.js';
import { databaseFileName, startServer, type RunningServer } from '../server.js';
import { migrationsFolder } from './database.js';
import { providerInstances, workflowRuns } from './schema.js';

// Recurring cards spec 4: a card stored before rules existed loads without one, shows when it
// fires, and fires once as it did. The store is built with the migrations up to the one before.

const previous = '0021_change_request_fork';
let root: string;
let server: RunningServer | undefined;
let now = new Date('2026-11-04T07:00:00.000Z');

const instance: ProviderInstance = {
  id: 'claude-work',
  kind: 'claude',
  name: 'Work',
  binaryPath: 'claude',
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: 'opus',
  defaultEffort: 'high',
  defaultPermissionMode: 'default',
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
};

async function previousMigrations(): Promise<string> {
  const folder = path.join(root, 'previous migrations');
  await cp(migrationsFolder, folder, { recursive: true });
  const journalFile = path.join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalFile, 'utf8')) as {
    entries: { tag: string }[];
  };
  const last = journal.entries.findIndex((entry) => entry.tag === previous);
  expect(last).toBeGreaterThan(-1);
  expect(journal.entries[last + 1]?.tag).toBe('0022_repeating_cards');
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalFile, JSON.stringify(journal));
  return folder;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-migration-'));
});

afterEach(async () => {
  await server?.workflows.settled();
  await server?.stop();
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('migration 0022_repeating_cards', () => {
  it('loads a card stored before rules existed and fires it once', async () => {
    const home = path.join(root, 'before');
    await mkdir(home, { recursive: true });
    const old = new Sqlite(path.join(home, databaseFileName));
    migrate(drizzle({ client: old, casing: 'snake_case' }), {
      migrationsFolder: await previousMigrations(),
    });
    // What a server of the previous schema stored: a project, a workflow and a card at 08:30
    // with its scheduled trigger. All invented.
    const projectDir = path.join(root, 'project');
    await mkdir(projectDir);
    old
      .prepare(`insert into projects (id, name, cwd, created_at) values ('p1', 'wow', ?, ?)`)
      .run(projectDir, '2026-11-01T08:00:00.000Z');
    old
      .prepare(
        `insert into workflows (id, name, steps, own_working_copy, for_units, created_at, updated_at)
         values ('quick', 'Review', ?, 0, 0, '2026-11-01T08:00:00.000Z', '2026-11-01T08:00:00.000Z')`,
      )
      .run(
        JSON.stringify([
          {
            id: 's1',
            skillName: 'deliver-work',
            providerInstanceId: 'claude-work',
            gateBefore: false,
            gateAfter: false,
            expectedArtifacts: [],
          },
        ]),
      );
    old
      .prepare(
        `insert into calendar_items (id, source, external_id, title, start, "end", zone, all_day,
          location, join_url, body, organizer, project_id, backlog_item_id, workflow_id, run_id,
          state, updated_at)
         values ('c1', 'local', null, 'Morning review', '2026-11-04T07:30:00.000Z',
          '2026-11-04T08:00:00.000Z', 'Europe/Stockholm', 0, null, null, null, null, 'p1', null,
          'quick', null, 'scheduled', '2026-11-01T08:00:00.000Z')`,
      )
      .run();
    old
      .prepare(
        `insert into triggers (id, kind, calendar_item_id, workflow_id, run_at, zone, state,
          run_id, offer_run_now)
         values ('c1:trigger', 'card', 'c1', 'quick', '2026-11-04T07:30:00.000Z',
          'Europe/Stockholm', 'scheduled', null, 0)`,
      )
      .run();
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
      clock: () => now,
      schedulerTimers: { setTimeout: () => undefined, clearTimeout: () => undefined },
      hooks: { providers: { claude: (row) => new MockProviderAdapter(row.kind) } },
    });
    const running = server;
    running.database.db.insert(providerInstances).values(instance).run();
    const [card] = snapshot(running.database.db, { topic: 'calendarItems' }) as CalendarItem[];
    expect(card).toMatchObject({
      id: 'c1',
      repeat: null,
      skippedDates: [],
      nextAt: '2026-11-04T07:30:00.000Z',
      occurrences: [],
    });

    now = new Date('2026-11-04T07:30:00.000Z');
    running.scheduler.tick();
    const runs = (): WorkflowRun[] => running.database.db.select().from(workflowRuns).all();
    expect(runs()).toHaveLength(1);
    expect(runs()[0]?.occurrence ?? null).toBeNull();
    now = new Date('2026-11-05T07:30:00.000Z');
    running.scheduler.tick();
    expect(runs()).toHaveLength(1);
  });
});
