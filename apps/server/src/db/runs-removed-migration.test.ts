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

// Workflow runs, plan runs, plans, the host poller's reads and event triggers are gone
// (orchestrator threads spec 35): the migration deletes their rows and the events that made
// them, keeps step threads as done chat threads, and keeps usage and provider limits. The store
// is built with the migrations up to the one before, filled with invented rows through plain
// SQL (the removed tables are no longer in the schema), and then opened by the server, twice.

const previous = '0050_assistant_is_a_main_thread';
const at = '2026-11-20T08:00:00.000Z';

let root: string;
let server: RunningServer | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-runs-removed-'));
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
  expect(journal.entries[last + 1]?.tag).toBe('0051_runs_plans_and_event_triggers_removed');
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalFile, JSON.stringify(journal));
  return folder;
}

// A row with the given values; every other column that must have a value gets '[]', which is
// valid text and valid JSON alike. An id the table numbers itself is left to it.
function insert(db: Sqlite.Database, table: string, values: Record<string, unknown>): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  const row: Record<string, unknown> = {};
  for (const column of columns) {
    if (column.notnull === 1 && column.dflt_value === null && column.pk === 0) {
      row[column.name] = '[]';
    }
  }
  for (const [key, value] of Object.entries(values)) {
    row[key] = typeof value === 'object' && value !== null ? JSON.stringify(value) : value;
  }
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${names.map((name) => `"${name}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
  ).run(...Object.values(row));
}

const thread = (id: string, values: Record<string, unknown>) => ({
  id,
  kind: 'chat',
  cwd: '/home/me/tea',
  provider_instance_id: 'claude-work',
  title: id,
  model: 'opus',
  effort: 'high',
  permission_mode: 'default',
  state: 'idle',
  pinned: 0,
  created_at: at,
  updated_at: at,
  ...values,
});

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
    schedulerTimers: { setTimeout: () => undefined, clearTimeout: () => undefined },
    hooks: { providers: { claude: (row) => new MockProviderAdapter(row.kind) } },
  });

const removedTables = [
  'workflow_runs',
  'plan_runs',
  'plan_intents',
  'host_reads',
  'change_requests',
  'ticket_reads',
  'page_reads',
  'trigger_events',
];

describe('migration 0051_runs_plans_and_event_triggers_removed', () => {
  it('deletes runs, plans, host reads and event triggers, keeps step threads as done chat threads, and keeps usage and limits', async () => {
    const home = path.join(root, 'before');
    await mkdir(home, { recursive: true });
    const old = new Sqlite(path.join(home, databaseFileName));
    migrate(drizzle({ client: old, casing: 'snake_case' }), {
      migrationsFolder: await previousMigrations(),
    });
    insert(old, 'threads', thread('step', { run_id: 'run-1', step_id: 'build', state: 'working' }));
    insert(old, 'threads', thread('chat', {}));
    insert(old, 'turns', {
      id: 'chat:turn:0',
      thread_id: 'chat',
      index: 0,
      state: 'completed',
      started_at: at,
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    insert(old, 'provider_limits', {
      provider_instance_id: 'claude-work',
      limits: [{ window: 'fiveHours', usedPercent: 40, resetsAt: null, reportedAt: at }],
    });
    insert(old, 'workflow_runs', {
      id: 'run-1',
      workflow_id: 'delivery',
      project_id: 'tea',
      state: 'running',
      current_step: 0,
      started_at: at,
    });
    insert(old, 'plan_runs', { id: 'plan-run-1', plan_id: 'tea:kettle', state: 'running' });
    insert(old, 'plan_intents', { id: 'tea:kettle', project_id: 'tea', intent_id: 'kettle' });
    insert(old, 'host_reads', { id: 'run:run-1', project_id: 'tea', scope: 'run' });
    insert(old, 'change_requests', { id: 'tea:14', project_id: 'tea', number: 14 });
    insert(old, 'ticket_reads', { id: 'run:run-1', project_id: 'tea', run_id: 'run-1' });
    insert(old, 'page_reads', { id: 'run:run-1', project_id: 'tea', run_id: 'run-1' });
    insert(old, 'trigger_events', { trigger_id: 'on-merge', event_id: 'e1', at });
    insert(old, 'triggers', {
      id: 'on-merge',
      kind: 'event',
      workflow_id: 'delivery',
      project_id: 'tea',
      event: 'merged',
      enabled: 1,
      created_at: at,
    });
    insert(old, 'triggers', {
      id: 'card-1:trigger',
      kind: 'card',
      calendar_item_id: 'card-1',
      workflow_id: 'delivery',
      run_at: '2026-11-30T09:00:00.000Z',
      zone: 'Europe/Stockholm',
      state: 'scheduled',
      run_id: 'run-0',
    });
    insert(old, 'calendar_items', {
      id: 'card-1',
      source: 'local',
      title: 'Ring the bell',
      start: '2026-11-30T09:00:00.000Z',
      end: '2026-11-30T10:00:00.000Z',
      zone: 'Europe/Stockholm',
      state: 'running',
      run_id: 'run-1',
      updated_at: at,
    });
    insert(old, 'backlog_items', {
      id: 'item-1',
      title: 'A quieter kettle',
      body: '',
      tags: [],
      state: 'running',
      run_id: 'run-1',
      created_at: at,
    });
    insert(old, 'notifications', {
      id: 'run-1:failed',
      at,
      kind: 'failed',
      title: 'Run failed',
      body: '',
      path: '/workflows/runs/run-1',
      run_id: 'run-1',
    });
    insert(old, 'notifications', {
      id: 'chat:finished',
      at,
      kind: 'finished',
      title: 'Thread finished',
      body: '',
      path: '/chat/chat',
      thread_id: 'chat',
    });
    for (const [kind, aggregate, payload] of [
      ['workflowRun.changed', 'run-1', { cause: 'workflowRun.start' }],
      ['planRun.changed', 'plan-run-1', {}],
      ['hosts.synced', 'hosts:tea', {}],
      ['trigger.set', 'on-merge', { id: 'on-merge', kind: 'event' }],
      ['trigger.set', 'card-1:trigger', { id: 'card-1:trigger', kind: 'card' }],
      ['trigger.deleted', 'on-merge', { triggerId: 'on-merge' }],
      ['thread.created', 'chat', { id: 'chat' }],
    ] as const) {
      insert(old, 'events', { at, kind, aggregate, payload });
    }
    insert(old, 'assistant_proposals', {
      id: 'p1',
      at,
      command_type: 'card.runNow',
      title: 'Run the card now',
      command: { type: 'card.runNow', cardId: 'card-1', runId: 'new-thread' },
      state: 'pending',
    });
    insert(old, 'assistant_proposals', {
      id: 'p2',
      at,
      command_type: 'workflowRun.start',
      title: 'Start Delivery',
      command: { type: 'workflowRun.start', runId: 'r2', workflowId: 'delivery', projectId: 'tea' },
      state: 'pending',
    });
    for (const [key, value] of [
      ['workflows.handoverTemplate', 'Hand over'],
      ['hosts.polling', false],
      ['calendar.snapMinutes', 30],
    ] as const) {
      insert(old, 'settings', { key, scope: 'global', value: JSON.stringify(value) });
    }
    old.close();

    const check = (db: Sqlite.Database) => {
      const tables = new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
            name: string;
          }[]
        ).map((row) => row.name),
      );
      for (const table of removedTables) expect(tables.has(table)).toBe(false);
      expect(db.prepare('SELECT id, kind, state FROM threads ORDER BY id').all()).toEqual([
        { id: 'chat', kind: 'chat', state: 'idle' },
        { id: 'step', kind: 'chat', state: 'done' },
      ]);
      expect(db.prepare('SELECT usage FROM turns').all()).toEqual([
        { usage: JSON.stringify({ inputTokens: 120, outputTokens: 30 }) },
      ]);
      expect(db.prepare('SELECT provider_instance_id FROM provider_limits').all()).toEqual([
        { provider_instance_id: 'claude-work' },
      ]);
      expect(db.prepare('SELECT * FROM triggers').all()).toEqual([
        {
          id: 'card-1:trigger',
          calendar_item_id: 'card-1',
          workflow_id: 'delivery',
          run_at: '2026-11-30T09:00:00.000Z',
          zone: 'Europe/Stockholm',
          state: 'scheduled',
          offer_run_now: 0,
        },
      ]);
      expect(db.prepare('SELECT id, state FROM calendar_items').all()).toEqual([
        { id: 'card-1', state: 'stopped' },
      ]);
      expect(db.prepare('SELECT id, state FROM backlog_items').all()).toEqual([
        { id: 'item-1', state: 'planned' },
      ]);
      expect(db.prepare('SELECT id FROM notifications').all()).toEqual([{ id: 'chat:finished' }]);
      // The server stores events of its own as it starts; the ones before it are what is asked.
      expect(
        db.prepare('SELECT kind, aggregate FROM events WHERE at = ? ORDER BY seq').all(at),
      ).toEqual([
        { kind: 'trigger.set', aggregate: 'card-1:trigger' },
        { kind: 'thread.created', aggregate: 'chat' },
      ]);
      expect(db.prepare('SELECT id, command FROM assistant_proposals').all()).toEqual([
        {
          id: 'p1',
          command: JSON.stringify({
            type: 'card.runNow',
            cardId: 'card-1',
            threadId: 'new-thread',
          }),
        },
      ]);
      expect(db.prepare('SELECT key FROM settings ORDER BY key').all()).toEqual([
        { key: 'calendar.snapMinutes' },
      ]);
    };

    server = await launch(home);
    check(server.database.sqlite);
    // A restart reads the same rows: nothing brings the removed ones back.
    await server.stop();
    server = await launch(home);
    check(server.database.sqlite);
  });
});
