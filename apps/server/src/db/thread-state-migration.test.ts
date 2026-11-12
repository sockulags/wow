import { DomainEvent } from '@wow/contracts';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '../core/subscriptions.js';
import { migrationsFolder, openDatabase } from './database.js';

// A thread stored before the server kept when it came to its state waits since its last change
// (agent workbench spec 76), and its stored events still read. All invented.

const previous = '0030_host_item_reads';
let root: string;

async function previousMigrations(): Promise<string> {
  const folder = path.join(root, 'previous migrations');
  await cp(migrationsFolder, folder, { recursive: true });
  const journalFile = path.join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalFile, 'utf8')) as {
    entries: { tag: string }[];
  };
  const last = journal.entries.findIndex((entry) => entry.tag === previous);
  expect(journal.entries[last + 1]?.tag).toBe('0031_thread_state_since');
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalFile, JSON.stringify(journal));
  return folder;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-migration-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('migration 0031_thread_state_since', () => {
  it('gives an old thread its last change as the time it came to its state', async () => {
    const file = path.join(root, 'wow.sqlite');
    const old = new Sqlite(file);
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
      state: 'needs_you',
      pinned: false,
      runId: null,
      stepId: null,
      createdAt: '2026-11-01T08:00:00.000Z',
      updatedAt: '2026-11-01T08:30:00.000Z',
    };
    old
      .prepare(
        `insert into threads (id, kind, project_id, cwd, branch, provider_instance_id,
          provider_session_id, title, model, effort, permission_mode, state, pinned, run_id,
          step_id, created_at, updated_at)
         values ('t1', 'chat', null, '/work/kettle', null, 'claude-work', null, 'Kettle notes',
          'sonnet', 'high', 'default', 'needs_you', 0, null, null, '2026-11-01T08:00:00.000Z',
          '2026-11-01T08:30:00.000Z')`,
      )
      .run();
    old
      .prepare(
        `insert into events (at, kind, aggregate, payload) values (?, 'thread.created', 't1', ?)`,
      )
      .run('2026-11-01T08:00:00.000Z', JSON.stringify(stored));
    old.close();

    const database = openDatabase(file);
    try {
      expect(snapshot(database.db, { topic: 'threads' })).toMatchObject([
        { id: 't1', state: 'needs_you', stateSince: '2026-11-01T08:30:00.000Z' },
      ]);
      const event = database.sqlite
        .prepare(`select kind, aggregate, payload from events where kind = 'thread.created'`)
        .get() as { kind: string; aggregate: string; payload: string };
      expect(
        DomainEvent.parse({ ...event, payload: JSON.parse(event.payload) as unknown }).payload,
      ).toEqual(stored);
    } finally {
      database.close();
    }
  });
});
