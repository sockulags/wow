import { DomainEvent, type Thread } from '@wow/contracts';
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

// A thread stored before background work was recorded loads with none, and its stored
// thread.created event still reads. All invented.

const previous = '0025_skill_files';
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
  expect(journal.entries[last + 1]?.tag).toBe('0026_background_tasks');
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

describe('migration 0026_background_tasks', () => {
  it('loads a thread stored before background work was recorded', async () => {
    const home = path.join(root, 'before');
    await mkdir(home, { recursive: true });
    const old = new Sqlite(path.join(home, databaseFileName));
    migrate(drizzle({ client: old, casing: 'snake_case' }), {
      migrationsFolder: await previousMigrations(),
    });
    const stored = {
      id: 't1',
      projectId: null,
      cwd: '/work/kettle',
      branch: null,
      providerInstanceId: 'claude-work',
      providerSessionId: null,
      title: 'Kettle notes',
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'default',
      state: 'idle',
      pinned: false,
      runId: null,
      stepId: null,
      createdAt: '2026-11-01T08:00:00.000Z',
      updatedAt: '2026-11-01T08:00:00.000Z',
    };
    old
      .prepare(
        `insert into threads (id, kind, project_id, cwd, branch, provider_instance_id,
          provider_session_id, title, model, effort, permission_mode, state, pinned, run_id,
          step_id, created_at, updated_at)
         values ('t1', 'chat', null, '/work/kettle', null, 'claude-work', null, 'Kettle notes',
          'sonnet', 'high', 'default', 'idle', 0, null, null, '2026-11-01T08:00:00.000Z',
          '2026-11-01T08:00:00.000Z')`,
      )
      .run();
    old
      .prepare(
        `insert into events (at, kind, aggregate, payload) values (?, 'thread.created', 't1', ?)`,
      )
      .run('2026-11-01T08:00:00.000Z', JSON.stringify(stored));
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
      hooks: { providers: { claude: (row) => new MockProviderAdapter(row.kind) } },
    });
    const [thread] = snapshot(server.database.db, { topic: 'threads' }) as Thread[];
    expect(thread).toMatchObject({ id: 't1', state: 'idle', backgroundTasks: [] });
    const event = server.database.sqlite
      .prepare(`select kind, aggregate, payload from events where kind = 'thread.created'`)
      .get() as { kind: string; aggregate: string; payload: string };
    expect(
      DomainEvent.parse({ ...event, payload: JSON.parse(event.payload) as unknown }).payload,
    ).toEqual(stored);
  });
});
