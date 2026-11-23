import type { Command, ServerCommand } from '@wow/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../db/database.js';
import { createLogger } from '../logger.js';
import { SettingsService } from '../settings/service.js';
import { archiveDoneByAge } from './archive-by-age.js';
import { Engine } from './engine.js';
import { snapshot } from './subscriptions.js';

// Done threads archived by age (chat overview spec 11), on a clock the test moves. All invented.

const dayMs = 24 * 60 * 60 * 1000;
let dir: string;
let database: Database;
let engine: Engine;
let settings: SettingsService;
let now: number;
let next = 0;

const dispatch = (command: Command | ServerCommand) => engine.dispatch(`c${(next += 1)}`, command);
const archived = () =>
  (snapshot(database.db, { topic: 'threads' }) as { id: string; archived: boolean }[])
    .filter((thread) => thread.archived)
    .map((thread) => thread.id)
    .toSorted();
const tick = () =>
  archiveDoneByAge({
    db: database.db,
    engine,
    settings,
    logger: createLogger(
      () => 'error',
      () => undefined,
    ),
    clock: () => new Date(now),
  });

function newThread(id: string) {
  dispatch({
    type: 'thread.create',
    threadId: id,
    providerInstanceId: 'claude-work',
    cwd: '/work/kettle',
    title: `Thread ${id}`,
    model: 'sonnet',
    effort: 'high',
    permissionMode: 'default',
  });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-archive-age-'));
  database = openDatabase(path.join(dir, 'wow.sqlite'));
  now = Date.UTC(2026, 10, 1, 8, 0, 0);
  engine = new Engine(database.db, { clock: () => new Date(now) });
  settings = new SettingsService(database.db, engine);
  dispatch({
    type: 'providerInstance.create',
    providerInstanceId: 'claude-work',
    kind: 'claude',
    name: 'Work',
    binaryPath: 'claude',
    configDir: '/home/me/.claude',
    env: {},
    launchArgs: [],
  });
  for (const id of ['done-old', 'done-pinned', 'idle-old', 'done-new']) newThread(id);
  for (const id of ['done-old', 'done-pinned']) {
    dispatch({ type: 'thread.setDone', threadId: id, done: true });
  }
  dispatch({ type: 'thread.setPinned', threadId: 'done-pinned', pinned: true });
  now += 10 * dayMs;
  dispatch({ type: 'thread.setDone', threadId: 'done-new', done: true });
});

afterEach(async () => {
  database.close();
  await rm(dir, { recursive: true, force: true });
});

describe('archiving done threads by age (chat overview spec 11)', () => {
  it('archives a done thread once it has not been active for the days set, and no other', () => {
    tick();
    expect(archived()).toEqual([]);
    now += 5 * dayMs;
    tick();
    expect(archived()).toEqual(['done-old']);
    now += 20 * dayMs;
    tick();
    expect(archived()).toEqual(['done-new', 'done-old']);
  });

  it('never archives with 0 days', () => {
    dispatch({ type: 'setting.set', key: 'chat.doneArchiveDays', scope: 'global', value: 0 });
    now += 100 * dayMs;
    tick();
    expect(archived()).toEqual([]);
  });
});
