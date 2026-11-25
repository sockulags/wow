import { plainProtector } from '@wow/secrets';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MockProviderAdapter } from '../hooks/index.js';
import { databaseFileName, startServer, type RunningServer } from '../server.js';
import { migrationsFolder } from './database.js';

// For the tests of a migration that removes something: a store built with the migrations up to
// the one before, which the test fills with invented rows through plain SQL (the removed tables
// are no longer in the schema) before the server opens it.

// A store in `<root>/before` migrated through `previous`, whose next migration must be `next`.
export async function oldStore(
  root: string,
  previous: string,
  next: string,
): Promise<{ readonly home: string; readonly db: Sqlite.Database }> {
  const folder = path.join(root, 'previous migrations');
  await cp(migrationsFolder, folder, { recursive: true });
  const journalFile = path.join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalFile, 'utf8')) as {
    entries: { tag: string }[];
  };
  const last = journal.entries.findIndex((entry) => entry.tag === previous);
  if (last < 0) throw new Error(`No migration ${previous}`);
  if (journal.entries[last + 1]?.tag !== next)
    throw new Error(`${next} does not follow ${previous}`);
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalFile, JSON.stringify(journal));
  const home = path.join(root, 'before');
  await mkdir(home, { recursive: true });
  const db = new Sqlite(path.join(home, databaseFileName));
  migrate(drizzle({ client: db, casing: 'snake_case' }), { migrationsFolder: folder });
  return { home, db };
}

// A row with the given values; every other column that must have a value gets '[]', which is
// valid text and valid JSON alike. An id the table numbers itself is left to it.
export function insert(db: Sqlite.Database, table: string, values: Record<string, unknown>): void {
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

// A chat thread's row, created and updated at `at`.
export const threadRow = (id: string, at: string, values: Record<string, unknown>) => ({
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

// The server on that store, with mock providers and no timers.
export const launchOn = (root: string, home: string): Promise<RunningServer> =>
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

// The names of the tables in the store.
export const tablesOf = (db: Sqlite.Database): Set<string> =>
  new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name),
  );
