import type { Command, ProviderEvent, ServerCommand, ThreadActivity } from '@wow/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../db/database.js';
import { Engine } from './engine.js';
import { Subscriptions, snapshot } from './subscriptions.js';

// Threads at work (parallel threads spec 11, 12): which threads the activity topic lists and what
// it says of each, from provider events dispatched as the provider service would. All invented.

let dir: string;
let database: Database;
let engine: Engine;
let next = 0;

const start = Date.UTC(2026, 10, 22, 9, 0, 0);
const dispatch = (command: Command | ServerCommand) => engine.dispatch(`c${(next += 1)}`, command);
const events = (threadId: string, ...list: ProviderEvent[]) =>
  dispatch({ type: 'provider.events', threadId, events: list });
const activity = () =>
  (snapshot(database.db, { topic: 'threadActivity' }) as ThreadActivity[]).toSorted((a, b) =>
    a.threadId.localeCompare(b.threadId),
  );

const create = (threadId: string, title: string) =>
  dispatch({
    type: 'thread.create',
    threadId,
    providerInstanceId: 'claude-work',
    cwd: '/work/kettle',
    title,
    model: 'sonnet',
    effort: 'high',
    permissionMode: 'default',
  });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-thread-activity-'));
  database = openDatabase(path.join(dir, 'wow.sqlite'));
  engine = new Engine(database.db, { clock: () => new Date(start) });
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
  create('t1', 'Kettle timer');
  create('t2', 'Mug handle');
  create('t3', 'Tea notes');
  create('t4', 'Idle and seen');
});

afterEach(async () => {
  database.close();
  await rm(dir, { recursive: true, force: true });
});

describe('the threadActivity topic (spec 11, 12)', () => {
  it('lists working, waiting and unseen threads with what each does now', () => {
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Run the tests' });
    events(
      't1',
      {
        type: 'toolCallStarted',
        threadId: 't1',
        itemId: 'read-1',
        name: 'Read',
        input: {},
        kind: 'read',
        path: 'src/timer.ts',
      },
      { type: 'toolCallCompleted', threadId: 't1', itemId: 'read-1', status: 'ok' },
      {
        type: 'toolCallStarted',
        threadId: 't1',
        itemId: 'bash-1',
        name: 'Bash',
        input: {},
        kind: 'command',
        command: 'pnpm test',
      },
    );
    dispatch({ type: 'thread.sendMessage', threadId: 't2', text: 'Ask first' });
    events('t2', {
      type: 'approvalRequested',
      threadId: 't2',
      approvalId: 'tool-1',
      kind: 'command',
      summary: 'Allow rm -rf build?',
      request: { toolName: 'Bash' },
    });
    dispatch({ type: 'thread.sendMessage', threadId: 't3', text: 'Write the notes' });
    events(
      't3',
      {
        type: 'textDelta',
        threadId: 't3',
        itemId: 'a-1',
        delta: 'Notes written.\n\nThey are in docs/notes.md.\n',
      },
      { type: 'turnCompleted', threadId: 't3' },
    );
    const rows = activity();
    expect(rows.map((row) => row.threadId)).toEqual(['t1', 't2', 't3']);
    expect(rows[0]).toMatchObject({
      turnState: 'running',
      startedAt: new Date(start).toISOString(),
      toolCalls: 2,
      runningTool: { kind: 'command', command: 'pnpm test', status: 'running' },
    });
    expect(rows[1]).toMatchObject({ turnState: 'running', runningTool: null });
    expect(rows[2]).toMatchObject({
      turnState: 'completed',
      endedAt: new Date(start).toISOString(),
      runningTool: null,
      lastText: 'They are in docs/notes.md.',
    });
  });

  it('leaves a thread out once it is seen or archived, and cuts the last words at the setting', () => {
    dispatch({
      type: 'setting.set',
      key: 'chat.activityTextMaxLength',
      scope: 'global',
      value: 20,
    });
    for (const id of ['t1', 't2']) {
      dispatch({ type: 'thread.sendMessage', threadId: id, text: 'Go' });
      events(
        id,
        {
          type: 'textDelta',
          threadId: id,
          itemId: `${id}-a`,
          delta: 'A rather long last line here',
        },
        { type: 'turnCompleted', threadId: id },
      );
    }
    expect(activity().map((row) => row.lastText)).toEqual([
      'A rather long last …',
      'A rather long last …',
    ]);
    dispatch({ type: 'thread.markSeen', threadId: 't1' });
    dispatch({ type: 'thread.setArchived', threadId: 't2', archived: true });
    expect(activity()).toEqual([]);
  });

  it('is pushed when a thread item changes', () => {
    const subscriptions = new Subscriptions(database.db, engine);
    const pushed: unknown[][] = [];
    subscriptions.subscribe({ topic: 'threadActivity' }, (_id, data) => pushed.push(data));
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Go' });
    events('t1', { type: 'textDelta', threadId: 't1', itemId: 'a', delta: 'Working on it' });
    expect(pushed.length).toBeGreaterThanOrEqual(2);
    expect((pushed.at(-1) as ThreadActivity[])[0]?.threadId).toBe('t1');
  });
});
