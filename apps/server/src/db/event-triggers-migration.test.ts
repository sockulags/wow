import type { ProviderInstance, ServerCommand } from '@wow/contracts';
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
import { calendarItems, providerInstances, triggers, workflowRuns } from './schema.js';

// Card triggers made before event triggers existed still fire after the migration that puts
// both kinds into one table. The store is built with the migrations up to the one before, filled
// with rows a server of today wrote for a card, and then opened by the server.

const previous = '0010_plan_runs';
const start = new Date('2026-11-02T09:00:00.000Z');
const iso = (seconds: number) => new Date(start.getTime() + seconds * 1000).toISOString();

let root: string;
let now: Date;
let server: RunningServer | undefined;

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

const launch = (home: string) =>
  startServer({
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
    hostTimers: { setTimeout: () => undefined, clearTimeout: () => undefined },
    hooks: { providers: { claude: (row) => new MockProviderAdapter(row.kind) } },
  });

// The migrations as they were before this one: the same files, and a journal that ends earlier.
async function previousMigrations(): Promise<string> {
  const folder = path.join(root, 'previous migrations');
  await cp(migrationsFolder, folder, { recursive: true });
  const journalFile = path.join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalFile, 'utf8')) as {
    entries: { tag: string }[];
  };
  const last = journal.entries.findIndex((entry) => entry.tag === previous);
  expect(last).toBeGreaterThan(-1);
  expect(journal.entries[last + 1]?.tag).toBe('0011_event_triggers');
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalFile, JSON.stringify(journal));
  return folder;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-migration-'));
  now = start;
});

afterEach(async () => {
  await server?.workflows.settled();
  await server?.stop();
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('migration 0011_event_triggers', () => {
  it('keeps the card triggers of the previous schema, and they still fire', async () => {
    // Rows as a server writes them for two cards: one to come, one already missed.
    const today = path.join(root, 'today');
    const projectDir = path.join(root, 'project');
    await mkdir(projectDir, { recursive: true });
    const writer = await launch(today);
    let ids = 0;
    const write = (command: ServerCommand) => writer.engine.dispatch(`w${(ids += 1)}`, command);
    writer.database.db.insert(providerInstances).values(instance).run();
    write({ type: 'project.create', projectId: 'p1', name: 'wow', cwd: projectDir });
    write({
      type: 'workflow.create',
      workflowId: 'wf1',
      name: 'Bug',
      steps: [
        {
          id: 's1',
          skillName: 'deliver-work',
          providerInstanceId: instance.id,
          gateBefore: true,
          gateAfter: false,
          expectedArtifacts: [],
        },
      ],
    });
    const card = { zone: 'Europe/Stockholm', projectId: 'p1', workflowId: 'wf1' };
    write({
      type: 'card.create',
      cardId: 'c1',
      title: 'Fix the login bug',
      start: iso(60),
      end: iso(1860),
      ...card,
    });
    write({
      type: 'card.create',
      cardId: 'c2',
      title: 'Was due before',
      start: iso(-600),
      end: iso(600),
      ...card,
    });
    await writer.stop();

    // A store at the previous schema with those rows.
    const home = path.join(root, 'before');
    await mkdir(home, { recursive: true });
    const file = path.join(home, databaseFileName);
    const old = new Sqlite(file);
    migrate(drizzle({ client: old, casing: 'snake_case' }), {
      migrationsFolder: await previousMigrations(),
    });
    const columns = (
      old.prepare(`select name from pragma_table_info('triggers')`).all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    expect(columns).toEqual([
      'id',
      'calendar_item_id',
      'workflow_id',
      'run_at',
      'zone',
      'state',
      'run_id',
      'offer_run_now',
    ]);
    old.prepare('attach database ? as today').run(path.join(today, databaseFileName));
    for (const table of ['projects', 'provider_instances', 'workflows', 'calendar_items']) {
      old.exec(`insert into ${table} select * from today.${table}`);
    }
    old.exec(
      `insert into triggers (${columns.join(', ')}) select ${columns.join(', ')} from today.triggers`,
    );
    old.exec('detach database today');
    expect(old.prepare('select count(*) as n from triggers').get()).toEqual({ n: 2 });
    old.close();

    // The server of today opens it.
    server = await launch(home);
    const db = server.database.db;
    expect(db.select().from(triggers).orderBy(triggers.id).all()).toEqual([
      {
        id: 'c1:trigger',
        kind: 'card',
        calendarItemId: 'c1',
        workflowId: 'wf1',
        runAt: iso(60),
        zone: 'Europe/Stockholm',
        state: 'scheduled',
        runId: null,
        offerRunNow: false,
        projectId: null,
        event: null,
        enabled: null,
        createdAt: null,
      },
      {
        id: 'c2:trigger',
        kind: 'card',
        calendarItemId: 'c2',
        workflowId: 'wf1',
        runAt: iso(-600),
        zone: 'Europe/Stockholm',
        state: 'missed',
        runId: null,
        offerRunNow: true,
        projectId: null,
        event: null,
        enabled: null,
        createdAt: null,
      },
    ]);

    now = new Date(start.getTime() + 61_000);
    server.scheduler.tick();
    const [run] = db.select().from(workflowRuns).all();
    expect(run).toMatchObject({ workflowId: 'wf1', calendarItemId: 'c1', state: 'waiting' });
    expect(db.select().from(triggers).all()).toContainEqual(
      expect.objectContaining({ id: 'c1:trigger', state: 'fired', runId: run?.id }),
    );
    expect(db.select().from(calendarItems).all()).toContainEqual(
      expect.objectContaining({ id: 'c1', state: 'waiting', runId: run?.id }),
    );

    // The missed card's "Run now" still works, and an event trigger fits beside them.
    server.engine.dispatch('run-now', { type: 'card.runNow', cardId: 'c2', runId: 'r2' });
    expect(db.select().from(triggers).all()).toContainEqual(
      expect.objectContaining({ id: 'c2:trigger', state: 'fired', runId: 'r2' }),
    );
    server.engine.dispatch('event', {
      type: 'trigger.create',
      triggerId: 'on-merged',
      projectId: 'p1',
      event: 'merged',
      workflowId: 'wf1',
    });
    expect(db.select().from(triggers).all()).toHaveLength(3);
  });
});
