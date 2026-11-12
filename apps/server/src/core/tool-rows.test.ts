import type { Command, ProviderEvent, ServerCommand, ThreadItem } from '@wow/contracts';
import { settingsRegistry, ToolCallItemPayload } from '@wow/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../db/database.js';
import { threadItems } from '../db/schema.js';
import { Engine } from './engine.js';
import { decide, type ReadModel } from './orchestrator.js';
import { readModel } from './projector.js';
import { snapshot } from './subscriptions.js';

// Tool rows and task lists (agent workbench U4): the server stamps a tool call's start and end
// with its own clock and keeps what the adapter normalized; every task list update is an item.
// The clock moves only when a test says so. All invented.

let dir: string;
let database: Database;
let engine: Engine;
let now: number;
let next = 0;

const start = Date.UTC(2026, 10, 2, 8, 0, 0);
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const dispatch = (command: Command | ServerCommand) => engine.dispatch(`c${(next += 1)}`, command);
const events = (...list: ProviderEvent[]) =>
  dispatch({ type: 'provider.events', threadId: 't1', events: list });
const later = (seconds: number) => {
  now += seconds * 1000;
};
const items = () => snapshot(database.db, { topic: 'threadItems', threadId: 't1' }) as ThreadItem[];
const item = (id: string) => items().find((row) => row.id === id);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-tool-rows-'));
  database = openDatabase(path.join(dir, 'wow.sqlite'));
  now = start;
  engine = new Engine(database.db, { clock: () => new Date(now) });
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
  dispatch({
    type: 'thread.create',
    threadId: 't1',
    providerInstanceId: 'claude-work',
    cwd: '/work/kettle',
    title: 'Kettle timer',
    model: 'sonnet',
    effort: 'high',
    permissionMode: 'default',
  });
  dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Run the tests' });
});

afterEach(async () => {
  database.close();
  await rm(dir, { recursive: true, force: true });
});

describe('tool call times (spec 30)', () => {
  it('stamps the start when the call starts and the end when it ends, by the server clock', () => {
    later(2);
    events({
      type: 'toolCallStarted',
      threadId: 't1',
      itemId: 'bash-1',
      name: 'Bash',
      input: { command: 'pnpm test' },
      kind: 'command',
      command: 'pnpm test',
    });
    expect(item('t1:turn:0:bash-1')?.payload).toEqual({
      name: 'Bash',
      input: { command: 'pnpm test' },
      kind: 'command',
      command: 'pnpm test',
      output: '',
      status: 'running',
      startedAt: at(2),
    });
    later(4.2);
    events({ type: 'toolCallCompleted', threadId: 't1', itemId: 'bash-1', status: 'error' });
    const payload = ToolCallItemPayload.parse(item('t1:turn:0:bash-1')?.payload);
    expect(payload).toMatchObject({ status: 'error', startedAt: at(2), endedAt: at(6.2) });
    // Claude Code gives no exit code or duration, so neither is made up.
    expect(payload.exitCode).toBeUndefined();
    expect(payload.durationMs).toBeUndefined();
  });

  it("keeps the provider's exit code and duration where it gives them", () => {
    events(
      {
        type: 'toolCallStarted',
        threadId: 't1',
        itemId: 'cmd-1',
        name: 'command',
        input: { command: 'pnpm test', cwd: '/work/kettle/app' },
        kind: 'command',
        command: 'pnpm test',
        cwd: '/work/kettle/app',
      },
      {
        type: 'toolCallCompleted',
        threadId: 't1',
        itemId: 'cmd-1',
        status: 'error',
        exitCode: 1,
        durationMs: 4200,
      },
    );
    expect(item('t1:turn:0:cmd-1')?.payload).toMatchObject({
      kind: 'command',
      cwd: '/work/kettle/app',
      exitCode: 1,
      durationMs: 4200,
      startedAt: at(0),
      endedAt: at(0),
    });
  });

  it("keeps a running call's start across a restart of the server", () => {
    later(3);
    events({ type: 'toolCallStarted', threadId: 't1', itemId: 'r1', name: 'Read', input: {} });
    database.close();
    database = openDatabase(path.join(dir, 'wow.sqlite'));
    expect(item('t1:turn:0:r1')?.payload).toMatchObject({ status: 'running', startedAt: at(3) });
  });

  it('reads a tool call stored before tool kinds as it was (spec 48)', () => {
    const old = { name: 'Bash', input: { command: 'ls' }, output: 'README.md', status: 'ok' };
    database.db
      .insert(threadItems)
      .values({
        id: 't1:turn:0:old',
        threadId: 't1',
        turnId: 't1:turn:0',
        index: 50,
        kind: 'tool_call',
        payload: old,
        streaming: false,
      })
      .run();
    const parsed = ToolCallItemPayload.parse(item('t1:turn:0:old')?.payload);
    expect(parsed).toEqual(old);
    expect(parsed.kind).toBeUndefined();
  });
});

const list = (done: number): ProviderEvent => ({
  type: 'taskListUpdated',
  threadId: 't1',
  tasks: [1, 2, 3].map((n) => ({
    id: String(n),
    content: `Step ${n}`,
    status: n <= done ? 'completed' : n === done + 1 ? 'in_progress' : 'pending',
  })),
});

describe('task list updates (spec 31)', () => {
  it('stores every update as an item of its own, stamped with its time', () => {
    events(list(0));
    later(1);
    events(list(1));
    later(1);
    events(list(2), list(3));
    const lists = items().filter((row) => row.kind === 'task_list');
    expect(lists.map((row) => row.id)).toEqual([
      't1:turn:0:tasks',
      't1:turn:0:tasks:1',
      't1:turn:0:tasks:2',
      't1:turn:0:tasks:3',
    ]);
    expect(lists.map((row) => (row.payload as { at: string }).at)).toEqual([
      at(0),
      at(1),
      at(2),
      at(2),
    ]);
  });

  it('adds nothing for a list equal to the last one, in one batch or the next', () => {
    events(list(0), list(0));
    later(1);
    events(list(0));
    events(list(1));
    events(list(1), list(0));
    const lists = items().filter((row) => row.kind === 'task_list');
    expect(lists.map((row) => row.id)).toEqual([
      't1:turn:0:tasks',
      't1:turn:0:tasks:1',
      't1:turn:0:tasks:2',
    ]);
    expect(lists.map((row) => (row.payload as { tasks: unknown }).tasks)).toEqual(
      [list(0), list(1), list(0)].map((event) =>
        event.type === 'taskListUpdated' ? event.tasks : [],
      ),
    );
  });

  it('finds the next list id with no read per earlier list', () => {
    for (let done = 0; done <= 3; done += 1) events(list(done));
    const stored = readModel(database.db);
    const asked: string[] = [];
    const counted: ReadModel = {
      ...stored,
      itemExists: (id) => {
        asked.push(id);
        return stored.itemExists(id);
      },
    };
    const out = decide({ type: 'provider.events', threadId: 't1', events: [list(0)] }, counted, {
      now: at(5),
      registry: settingsRegistry,
    });
    expect(
      out.flatMap((event) => (event.kind === 'threadItem.added' ? [event.payload.id] : [])),
    ).toEqual(['t1:turn:0:tasks:4']);
    expect(asked.filter((id) => id.includes(':tasks'))).toEqual([]);
  });
});
