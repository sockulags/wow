import type { ServerCommand } from '@wow/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../db/database.js';
import { Engine } from './engine.js';
import { snapshot } from './subscriptions.js';

// Agent workbench spec 56: a message sent with files mentioned with `@` keeps them on its user
// item, so the thread shows them as chips.

let dir: string;
let database: Database;
let engine: Engine;
let next = 0;

const clock = () => new Date('2026-11-02T08:00:00.000Z');
const dispatch = (command: ServerCommand) => engine.dispatch(`c${(next += 1)}`, command);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-mentions-'));
  database = openDatabase(path.join(dir, 'wow.sqlite'));
  engine = new Engine(database.db, { clock });
  dispatch({
    type: 'providerInstance.create',
    providerInstanceId: 'mock',
    kind: 'claude',
    name: 'Mock',
    binaryPath: 'claude',
    configDir: '',
    env: {},
    launchArgs: [],
  });
  dispatch({
    type: 'thread.create',
    threadId: 't1',
    providerInstanceId: 'mock',
    cwd: '/work/tea',
    model: 'mock-model',
    effort: 'default',
    permissionMode: 'default',
  });
});

afterEach(async () => {
  database.close();
  await rm(dir, { recursive: true, force: true });
});

const userItems = () =>
  (
    snapshot(database.db, { topic: 'threadItems', threadId: 't1' }) as Array<{
      kind: string;
      payload: unknown;
    }>
  ).filter((item) => item.kind === 'user');

describe('file mentions', () => {
  it('keeps the mentioned files on the user item @agent-workbench-56', () => {
    dispatch({
      type: 'thread.sendMessage',
      threadId: 't1',
      text: '@src/timer.ts\n\nWhat does it ring?',
      files: ['src/timer.ts'],
    });
    expect(userItems()).toMatchObject([
      { payload: { text: '@src/timer.ts\n\nWhat does it ring?', files: ['src/timer.ts'] } },
    ]);
  });

  it('keeps the files of a message queued while a turn runs, joined once each', () => {
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Start' });
    dispatch({
      type: 'thread.sendMessage',
      threadId: 't1',
      text: '@src/timer.ts what rings?',
      files: ['src/timer.ts'],
    });
    dispatch({
      type: 'thread.sendMessage',
      threadId: 't1',
      text: '@src/timer.ts and @docs/spec.md',
      files: ['src/timer.ts', 'docs/spec.md'],
    });
    dispatch({
      type: 'provider.events',
      threadId: 't1',
      events: [{ type: 'turnCompleted', threadId: 't1' }],
    });
    const [thread] = snapshot(database.db, { topic: 'threads' }) as Array<{
      queued: { id: string; files?: string[] } | null;
    }>;
    expect(thread?.queued?.files).toEqual(['src/timer.ts', 'docs/spec.md']);
    dispatch({ type: 'thread.sendQueued', threadId: 't1', queuedId: thread?.queued?.id ?? '' });
    expect(userItems().at(-1)).toMatchObject({
      payload: { queued: 'afterTurn', files: ['src/timer.ts', 'docs/spec.md'] },
    });
  });

  it('stores no files on a message without mentions', () => {
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Hello' });
    expect(userItems()).toEqual([expect.objectContaining({ payload: { text: 'Hello' } })]);
  });
});
