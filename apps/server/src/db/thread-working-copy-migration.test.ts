import {
  Thread,
  type ProviderCommand,
  type ProviderInstance,
  type ServerCommand,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockProviderAdapter } from '../hooks/index.js';
import { databaseFileName, startServer, type RunningServer } from '../server.js';
import { migrationsFolder } from './database.js';
import { providerInstances, threads, turns } from './schema.js';

// Threads stored before a chat thread could have its own working copy (thread work spec 18):
// a store at the schema before the migration that adds `threads.working_copy`, holding a thread
// a server of today wrote, is opened by the server; the thread loads with no copy and its turn
// runs in the project folder. All invented.

const previous = '0034_thread_tools';
const added = '0035_thread_working_copy';

let root: string;
let server: RunningServer | undefined;
let sent: ProviderCommand[];

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
    hooks: {
      providers: {
        claude: (row) => {
          const adapter = new MockProviderAdapter(row.kind, (command) => {
            if (command.type !== 'startTurn') return [];
            const { threadId } = command;
            return [
              { type: 'session', threadId, providerSessionId: `mock-${threadId}` },
              { type: 'textDelta', threadId, itemId: `${threadId}-a`, delta: 'Done' },
              { type: 'turnCompleted', threadId },
            ];
          });
          sent = adapter.sent;
          return adapter;
        },
      },
    },
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
  expect(journal.entries[last + 1]?.tag).toBe(added);
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalFile, JSON.stringify(journal));
  return folder;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-migration-'));
  sent = [];
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

describe(`migration ${added}`, () => {
  it('loads a thread stored at the previous schema with no working copy, and its turn runs in the project folder', async () => {
    const today = path.join(root, 'today');
    const projectDir = path.join(root, 'project');
    await mkdir(projectDir, { recursive: true });
    const writer = await launch(today);
    let ids = 0;
    const write = (command: ServerCommand) => writer.engine.dispatch(`w${(ids += 1)}`, command);
    writer.database.db.insert(providerInstances).values(instance).run();
    write({ type: 'project.create', projectId: 'p1', name: 'Tea mug', cwd: projectDir });
    write({
      type: 'thread.create',
      threadId: 't1',
      providerInstanceId: instance.id,
      projectId: 'p1',
      cwd: projectDir,
      title: 'Ring the bell',
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
    });
    await writer.stop();

    // A store at the previous schema with those rows.
    const home = path.join(root, 'before');
    await mkdir(home, { recursive: true });
    const old = new Sqlite(path.join(home, databaseFileName));
    migrate(drizzle({ client: old, casing: 'snake_case' }), {
      migrationsFolder: await previousMigrations(),
    });
    const columnsOf = (table: string) =>
      (old.prepare(`select name from pragma_table_info('${table}')`).all() as { name: string }[])
        .map((column) => `"${column.name}"`)
        .join(', ');
    expect(columnsOf('threads')).not.toContain('"working_copy"');
    old.prepare('attach database ? as today').run(path.join(today, databaseFileName));
    for (const table of ['projects', 'provider_instances', 'threads']) {
      const had = columnsOf(table);
      old.exec(`insert into ${table} (${had}) select ${had} from today.${table}`);
    }
    old.exec('detach database today');
    expect(old.prepare('select count(*) as n from threads').get()).toEqual({ n: 1 });
    old.close();

    // The server of today opens it.
    server = await launch(home);
    const row = server.database.db.select().from(threads).where(eq(threads.id, 't1')).get();
    const parsed = Thread.safeParse(row);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ id: 't1', cwd: projectDir, branch: null });
    expect(parsed.data?.workingCopy ?? null).toBeNull();

    const ended = new Promise<void>((resolve) => {
      const unsubscribe = server?.engine.onCommit(() => {
        const turn = server?.database.db.select().from(turns).where(eq(turns.threadId, 't1')).get();
        if (turn && turn.state !== 'running') {
          unsubscribe?.();
          resolve();
        }
      });
    });
    server.engine.dispatch('send', { type: 'thread.sendMessage', threadId: 't1', text: 'Hello' });
    await ended;
    const started = sent.filter((command) => command.type === 'startTurn');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ cwd: projectDir });
    expect(server.database.db.select().from(turns).get()?.state).toBe('completed');
  });
});
