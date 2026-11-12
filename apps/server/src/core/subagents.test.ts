import type { Command, ProviderEvent, ServerCommand, Thread, ThreadItem } from '@wow/contracts';
import { ToolCallItemPayload } from '@wow/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../db/database.js';
import { threadItems } from '../db/schema.js';
import { Engine } from './engine.js';
import { readModel } from './projector.js';
import { snapshot } from './subscriptions.js';

// Subagents and background work (agent workbench U11, spec 44, 48, 90): what a subagent does is
// stored under its call, and background tasks keep the server's start time and their latest
// output. The clock moves only when a test says so. All invented.

let dir: string;
let database: Database;
let engine: Engine;
let now: number;
let next = 0;

const start = Date.UTC(2026, 10, 12, 9, 0, 0);
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const dispatch = (command: Command | ServerCommand) => engine.dispatch(`c${(next += 1)}`, command);
const events = (...list: ProviderEvent[]) =>
  dispatch({ type: 'provider.events', threadId: 't1', events: list });
const later = (seconds: number) => {
  now += seconds * 1000;
};
const items = () => snapshot(database.db, { topic: 'threadItems', threadId: 't1' }) as ThreadItem[];
const item = (id: string) => items().find((row) => row.id === id);
const thread = (id = 't1') =>
  (snapshot(database.db, { topic: 'threads' }) as Thread[]).find((row) => row.id === id);

const call = (itemId: string, extra: Partial<ProviderEvent> = {}): ProviderEvent =>
  ({
    type: 'toolCallStarted',
    threadId: 't1',
    itemId,
    name: 'Grep',
    input: { pattern: 'login' },
    kind: 'search',
    pattern: 'login',
    ...extra,
  }) as ProviderEvent;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-subagents-'));
  database = openDatabase(path.join(dir, 'wow.sqlite'));
  now = start;
  engine = new Engine(database.db, { clock: () => new Date(now) });
  for (const [id, kind] of [
    ['claude-work', 'claude'],
    ['codex-work', 'codex'],
  ] as const) {
    dispatch({
      type: 'providerInstance.create',
      providerInstanceId: id,
      kind,
      name: id,
      binaryPath: kind,
      configDir: `/home/me/.${kind}`,
      env: {},
      launchArgs: [],
    });
  }
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
  dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Explore with an agent' });
});

afterEach(async () => {
  database.close();
  await rm(dir, { recursive: true, force: true });
});

describe('nested items (spec 44)', () => {
  it('stores a subagent’s calls and text under its call, and its count, time and answer on it', () => {
    events(
      call('agent-1', {
        name: 'Agent',
        input: { description: 'explore the auth code' },
        kind: 'subagent',
        description: 'explore the auth code',
        prompt: 'Find where login is checked.',
        pattern: undefined,
      } as Partial<ProviderEvent>),
      call('sub-1', { parentItemId: 'agent-1' } as Partial<ProviderEvent>),
      {
        type: 'textDelta',
        threadId: 't1',
        itemId: 'msg-sub:full:0',
        delta: 'Looked in src.',
        parentItemId: 'agent-1',
      },
    );
    later(92);
    events(
      { type: 'toolCallCompleted', threadId: 't1', itemId: 'sub-1', status: 'ok' },
      {
        type: 'toolCallCompleted',
        threadId: 't1',
        itemId: 'agent-1',
        status: 'ok',
        toolCount: 3,
        durationMs: 92_000,
        answer: 'Login is checked in src/auth.ts.',
      },
      { type: 'textDelta', threadId: 't1', itemId: 'msg-2:0', delta: 'It is in src/auth.ts.' },
    );
    expect(item('t1:turn:0:sub-1')?.payload).toMatchObject({
      kind: 'search',
      parentItemId: 't1:turn:0:agent-1',
    });
    expect(item('t1:turn:0:msg-sub:full:0')?.payload).toEqual({
      text: 'Looked in src.',
      parentItemId: 't1:turn:0:agent-1',
    });
    expect(item('t1:turn:0:agent-1')?.payload).toEqual({
      name: 'Agent',
      input: { description: 'explore the auth code' },
      kind: 'subagent',
      description: 'explore the auth code',
      prompt: 'Find where login is checked.',
      output: '',
      status: 'ok',
      startedAt: at(0),
      endedAt: at(92),
      durationMs: 92_000,
      toolCount: 3,
      answer: 'Login is checked in src/auth.ts.',
    });
    expect(item('t1:turn:0:agent-1')?.payload).not.toHaveProperty('parentItemId');
  });

  // A turn ends with what the thread's own agent said, not a subagent's text after it.
  it('takes the turn’s last text from the agent, not from a subagent', () => {
    events(
      { type: 'textDelta', threadId: 't1', itemId: 'own', delta: 'I asked a subagent.' },
      call('agent-1', { kind: 'subagent', name: 'Agent' } as Partial<ProviderEvent>),
      {
        type: 'textDelta',
        threadId: 't1',
        itemId: 'sub-text',
        delta: 'Subagent notes.',
        parentItemId: 'agent-1',
      },
    );
    const read = readModel(database.db);
    expect(read.lastAssistantText('t1:turn:0')?.id).toBe('t1:turn:0:own');
  });

  // Spec 48: a subagent call stored before kinds keeps its old shape and is read as before.
  it('reads an agent call stored before this change as it was', () => {
    database.db
      .insert(threadItems)
      .values({
        id: 't1:turn:0:old-task',
        threadId: 't1',
        turnId: 't1:turn:0',
        index: 99,
        kind: 'tool_call',
        payload: { name: 'Task', input: { description: 'old' }, output: 'Done.', status: 'ok' },
        streaming: false,
      })
      .run();
    const payload = ToolCallItemPayload.parse(item('t1:turn:0:old-task')?.payload);
    expect(payload).toEqual({
      name: 'Task',
      input: { description: 'old' },
      output: 'Done.',
      status: 'ok',
    });
  });
});

describe('background tasks (spec 90)', () => {
  it('stamps when a task was first listed by the server clock and keeps it, with its latest output', () => {
    later(3);
    events({
      type: 'backgroundTasks',
      threadId: 't1',
      tasks: [{ id: 'bg-1', description: 'Count the tea leaves', agent: true, kind: 'agent' }],
    });
    later(10);
    events({
      type: 'backgroundTasks',
      threadId: 't1',
      tasks: [
        {
          id: 'bg-1',
          description: 'Count the tea leaves',
          agent: true,
          kind: 'agent',
          lastOutput: 'Counted 30 leaves so far',
        },
        { id: 'sh-1', description: 'pnpm dev', kind: 'command' },
      ],
    });
    expect(thread()?.backgroundTasks).toEqual([
      {
        id: 'bg-1',
        description: 'Count the tea leaves',
        agent: true,
        kind: 'agent',
        lastOutput: 'Counted 30 leaves so far',
        startedAt: at(3),
      },
      { id: 'sh-1', description: 'pnpm dev', kind: 'command', startedAt: at(13) },
    ]);
  });

  it('asks the provider to stop a listed task, and refuses one it does not list', () => {
    events({
      type: 'backgroundTasks',
      threadId: 't1',
      tasks: [{ id: 'bg-1', description: 'Count the tea leaves', kind: 'agent' }],
    });
    const receipt = dispatch({ type: 'thread.stopTask', threadId: 't1', taskId: 'bg-1' });
    expect(receipt.seqs).toHaveLength(1);
    expect(() => dispatch({ type: 'thread.stopTask', threadId: 't1', taskId: 'gone' })).toThrow(
      /no background task gone/,
    );
  });

  it('sends only a running command or subagent of the running turn to the background', () => {
    events(
      call('bash-1', {
        name: 'Bash',
        kind: 'command',
        command: 'pnpm dev',
        pattern: undefined,
      } as Partial<ProviderEvent>),
      call('grep-1'),
    );
    expect(
      dispatch({ type: 'thread.toBackground', threadId: 't1', itemId: 't1:turn:0:bash-1' }).seqs,
    ).toHaveLength(1);
    expect(() =>
      dispatch({ type: 'thread.toBackground', threadId: 't1', itemId: 't1:turn:0:grep-1' }),
    ).toThrow(/Only a running command or subagent/);
    events({ type: 'turnCompleted', threadId: 't1' });
    expect(() => dispatch({ type: 'thread.toBackground', threadId: 't1' })).toThrow(
      /no running turn/,
    );
  });

  // Codex has neither (spec Open risks): its chips have no Stop and Ctrl+B does nothing there.
  it('refuses Stop and Ctrl+B on a Codex thread', () => {
    dispatch({
      type: 'thread.create',
      threadId: 't2',
      providerInstanceId: 'codex-work',
      cwd: '/work/kettle',
      title: 'Codex',
      model: 'gpt',
      effort: 'medium',
      permissionMode: 'auto',
    });
    expect(() => dispatch({ type: 'thread.stopTask', threadId: 't2', taskId: 'x' })).toThrow(
      /cannot stop a background task/,
    );
    expect(() => dispatch({ type: 'thread.toBackground', threadId: 't2' })).toThrow(
      /cannot send work to the background/,
    );
  });
});
