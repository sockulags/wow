import Sqlite from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;
// What a transaction callback receives; projectors and readers accept either.
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface Database {
  readonly db: Db;
  readonly sqlite: Sqlite.Database;
  close(): void;
}

export const migrationsFolder = fileURLToPath(new URL('../../migrations', import.meta.url));

// Opens (or creates) the store and brings it to the latest migration. `file` may be ':memory:'.
export function openDatabase(file: string): Database {
  const sqlite = new Sqlite(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // SQLite's lower() and LIKE fold ASCII letters only; the thread search needs "Über" to match
  // "über" too.
  sqlite.function('wow_lower', { deterministic: true }, (text: unknown) =>
    typeof text === 'string' ? text.toLowerCase() : text,
  );
  const db = drizzle({ client: sqlite, schema, casing: 'snake_case' });
  migrate(db, { migrationsFolder });
  return { db, sqlite, close: () => sqlite.close() };
}
