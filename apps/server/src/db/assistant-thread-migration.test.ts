import { settingsRegistry, type Thread } from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import Sqlite from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { project } from '../core/projector.js';
import { MockProviderAdapter } from '../hooks/index.js';
import { databaseFileName, startServer, type RunningServer } from '../server.js';
import { migrationsFolder, openDatabase } from './database.js';
import { settings, threadItems, threads } from './schema.js';

// The assistant thread is a main thread (orchestrator threads spec 25, 34): the migration turns
// the stored assistant thread into a chat thread titled "Assistant" with its conversation and
// provider session kept, moves `assistant.instructions` to `chat.instructions`, and removes the
// settings of the pages that went. The store is built with the migrations up to the one before,
// filled with invented rows, and then opened.

const previous = '0049_retire_thread_list_groups';
const at = '2026-11-20T08:00:00.000Z';

let root: string;
let server: RunningServer | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-assistant-thread-'));
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
  expect(journal.entries[last + 1]?.tag).toBe('0050_assistant_is_a_main_thread');
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalFile, JSON.stringify(journal));
  return folder;
}

const assistant: Thread = {
  id: 'assistant',
  kind: 'assistant',
  projectId: null,
  cwd: '/home/me/.wow/assistant',
  branch: null,
  providerInstanceId: 'claude-work',
  providerSessionId: 'session-of-the-assistant',
  title: 'Assistant',
  model: 'opus',
  effort: 'high',
  permissionMode: 'default',
  state: 'idle',
  pinned: false,
  runId: null,
  stepId: null,
  createdAt: at,
  updatedAt: at,
};

describe('migration 0050_assistant_is_a_main_thread', () => {
  it('makes the assistant thread a chat thread titled Assistant and moves its instructions', async () => {
    const home = path.join(root, 'before');
    await mkdir(home, { recursive: true });
    const old = new Sqlite(path.join(home, databaseFileName));
    const olddb = drizzle({ client: old, casing: 'snake_case' });
    migrate(olddb, { migrationsFolder: await previousMigrations() });
    olddb.insert(threads).values(assistant).run();
    olddb
      .insert(threadItems)
      .values({
        id: 'assistant-item-1',
        threadId: 'assistant',
        turnId: 'assistant:turn:0',
        index: 0,
        kind: 'user',
        payload: { text: 'Turn on weekends' },
        streaming: false,
      })
      .run();
    for (const [key, value] of [
      ['assistant.instructions', 'Answer in rhyme.'],
      ['assistant.model', 'opus'],
      ['assistant.secretPatterns', ['ghp_']],
      ['keybindings.goPlans', 'Mod+4'],
      ['desktop.quickAskShortcut', 'Alt+Space'],
      ['calendar.snapMinutes', 30],
    ] as const) {
      olddb.insert(settings).values({ key, scope: 'global', value }).run();
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
    expect(db.select().from(threads).all()).toMatchObject([
      {
        id: 'assistant',
        kind: 'chat',
        title: 'Assistant',
        projectId: null,
        providerSessionId: 'session-of-the-assistant',
      },
    ]);
    expect(db.select().from(threadItems).all()).toMatchObject([
      { id: 'assistant-item-1', threadId: 'assistant', payload: { text: 'Turn on weekends' } },
    ]);
    expect(
      Object.fromEntries(
        db
          .select()
          .from(settings)
          .all()
          .map((row) => [row.key, row.value]),
      ),
    ).toEqual({
      'chat.instructions': 'Answer in rhyme.',
      'assistant.secretPatterns': ['ghp_'],
      'calendar.snapMinutes': 30,
    });
    expect(server.settings.get('chat.instructions')).toBe('Answer in rhyme.');
    for (const key of ['assistant.instructions', 'assistant.model', 'keybindings.goPlans']) {
      expect(Object.hasOwn(settingsRegistry, key)).toBe(false);
    }
  });

  it('projects an assistant thread read again from its events as a chat thread', async () => {
    const database = openDatabase(path.join(root, 'store'));
    try {
      project(database.db, { kind: 'thread.created', aggregate: 'assistant', payload: assistant });
      expect(
        database.db.select().from(threads).where(eq(threads.id, 'assistant')).get(),
      ).toMatchObject({ kind: 'chat', title: 'Assistant' });
    } finally {
      database.close();
    }
  });
});
