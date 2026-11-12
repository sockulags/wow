import type { Command, ProviderEvent, ServerCommand, ThreadItem } from '@wow/contracts';
import { DomainEvent, ReasoningItemPayload, UsageItemPayload } from '@wow/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../db/database.js';
import { Engine } from './engine.js';
import { MockProviderAdapter } from '../hooks/providers.js';
import { snapshot } from './subscriptions.js';

// Conversation reading (agent workbench U10): the divider before a message whose turn runs on
// another model, effort or mode, the model on each usage row, the compaction divider and the
// reasoning's times. The clock moves only when a test says so. All invented.

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
const kinds = () => items().map((row) => `${row.turnId}:${row.kind}`);
const finish = () =>
  events(
    { type: 'usage', threadId: 't1', inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
    { type: 'turnCompleted', threadId: 't1' },
  );

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-conversation-'));
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
    model: 'opus',
    effort: 'high',
    permissionMode: 'default',
  });
  dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Plan the timer' });
});

afterEach(async () => {
  database.close();
  await rm(dir, { recursive: true, force: true });
});

describe('the settings divider (spec 9)', () => {
  it('puts one divider naming the model and the mode before the next message', () => {
    finish();
    dispatch({
      type: 'thread.configure',
      threadId: 't1',
      model: 'sonnet',
      permissionMode: 'acceptEdits',
    });
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Build it' });
    expect(kinds()).toEqual([
      't1:turn:0:user',
      't1:turn:0:usage',
      't1:turn:1:settings_change',
      't1:turn:1:user',
    ]);
    const divider = items().find((row) => row.kind === 'settings_change');
    expect(divider?.payload).toEqual({
      model: { from: 'opus', to: 'sonnet' },
      permissionMode: { from: 'default', to: 'acceptEdits' },
    });
    const indexes = items().map((row) => row.index);
    expect(indexes).toEqual(indexes.toSorted((a, b) => a - b));
  });

  it('adds no divider when nothing changed, or when a change was taken back', () => {
    finish();
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Go on' });
    finish();
    dispatch({ type: 'thread.configure', threadId: 't1', effort: 'low' });
    dispatch({ type: 'thread.configure', threadId: 't1', effort: 'high' });
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'And again' });
    expect(items().filter((row) => row.kind === 'settings_change')).toEqual([]);
  });

  it('names the effort too, and only what changed', () => {
    finish();
    dispatch({ type: 'thread.configure', threadId: 't1', effort: 'low' });
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Quickly' });
    expect(items().find((row) => row.kind === 'settings_change')?.payload).toEqual({
      effort: { from: 'high', to: 'low' },
    });
  });
});

describe('the usage row names its model (spec 9)', () => {
  it('names the model the turn was sent with, also after the thread changed it', () => {
    dispatch({ type: 'thread.configure', threadId: 't1', model: 'sonnet' });
    finish();
    expect(UsageItemPayload.parse(items().at(-1)?.payload).model).toBe('opus');
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Build it' });
    finish();
    expect(UsageItemPayload.parse(items().at(-1)?.payload).model).toBe('sonnet');
  });

  it("takes the provider's word for the model when it gives one", () => {
    events({
      type: 'usage',
      threadId: 't1',
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      model: 'claude-opus-invented',
    });
    expect(UsageItemPayload.parse(items().at(-1)?.payload).model).toBe('claude-opus-invented');
  });
});

describe('compaction (spec 46)', () => {
  it('adds a divider with the trigger and the counts the provider gives', () => {
    later(3);
    events(
      {
        type: 'compacted',
        threadId: 't1',
        trigger: 'auto',
        preTokens: 152_000,
        postTokens: 18_000,
      },
      { type: 'compacted', threadId: 't1', trigger: 'manual', preTokens: 40_000 },
    );
    const compactions = items().filter((row) => row.kind === 'compaction');
    expect(compactions.map((row) => row.payload)).toEqual([
      { trigger: 'auto', preTokens: 152_000, postTokens: 18_000, at: at(3) },
      { trigger: 'manual', preTokens: 40_000, at: at(3) },
    ]);
    expect(new Set(compactions.map((row) => row.id)).size).toBe(2);
  });
});

describe('reasoning times (spec 88)', () => {
  it('stamps when the first and the latest part of the reasoning came', () => {
    later(1);
    events({ type: 'reasoningDelta', threadId: 't1', itemId: 'think', delta: 'The kettle ' });
    later(11);
    events({ type: 'reasoningDelta', threadId: 't1', itemId: 'think', delta: 'clicks off.' });
    later(5);
    events({ type: 'textDelta', threadId: 't1', itemId: 'answer', delta: 'Done.' });
    const reasoning = items().find((row) => row.kind === 'reasoning');
    expect(ReasoningItemPayload.parse(reasoning?.payload)).toEqual({
      text: 'The kettle clicks off.',
      startedAt: at(1),
      endedAt: at(12),
    });
    expect(items().find((row) => row.kind === 'assistant_text')?.payload).toEqual({
      text: 'Done.',
    });
  });
});

describe('threads stored before (spec 48)', () => {
  it('replays a stored turn start without a divider and keeps old rows as they were', () => {
    const stored = DomainEvent.parse({
      kind: 'turn.started',
      aggregate: 't9',
      payload: {
        turn: {
          id: 't9:turn:0',
          threadId: 't9',
          index: 0,
          state: 'running',
          startedAt: at(0),
          endedAt: null,
          usage: null,
        },
        item: {
          id: 't9:turn:0:user',
          threadId: 't9',
          turnId: 't9:turn:0',
          index: 0,
          kind: 'user',
          payload: { text: 'Old message' },
          streaming: false,
        },
        providerInstanceId: 'claude-work',
        start: {
          cwd: '/work/kettle',
          prompt: 'Old message',
          model: 'opus',
          effort: 'high',
          permissionMode: 'default',
          resumeId: null,
        },
      },
    });
    expect(stored.kind === 'turn.started' && stored.payload.settingsItem).toBeUndefined();
    // Usage and reasoning rows from before parse without the new fields.
    expect(UsageItemPayload.parse({ inputTokens: 1, outputTokens: 2 }).model).toBeUndefined();
    expect(ReasoningItemPayload.parse({ text: 'Thinking' }).startedAt).toBeUndefined();
  });

  it("gives a thread's first turn no divider", () => {
    expect(kinds()).toEqual(['t1:turn:0:user']);
  });
});

const mockTurn = (prompt: string) => {
  const mock = new MockProviderAdapter('claude');
  const seen: ProviderEvent[] = [];
  mock.onEvent((event) => seen.push(event));
  void mock.send({
    type: 'startTurn',
    threadId: 't1',
    cwd: '/work/kettle',
    prompt,
    model: 'opus',
    effort: 'high',
    permissionMode: 'default',
  });
  return new Promise<ProviderEvent[]>((resolve) => setImmediate(() => resolve(seen)));
};

describe('the mock provider (agent workbench U10)', () => {
  it('learns "compact": a compaction with counts before the answer', async () => {
    const seen = await mockTurn('/compact');
    expect(seen.map((event) => event.type)).toEqual([
      'session',
      'compacted',
      'textDelta',
      'usage',
      'turnCompleted',
    ]);
  });

  it('learns a two-tool turn: a command, then a second one', async () => {
    const seen = await mockTurn('Use two tools');
    expect(
      seen.filter((event) => event.type === 'toolCallStarted').map((event) => event.command),
    ).toEqual(['pnpm lint', 'pnpm test']);
  });
});

describe('when a thread began to wait (spec 76)', () => {
  const thread = () =>
    (snapshot(database.db, { topic: 'threads' }) as { stateSince?: string | null }[])[0];
  const approval = (id: string) =>
    events({
      type: 'approvalRequested',
      threadId: 't1',
      approvalId: id,
      kind: 'command',
      summary: `Run ${id}`,
      request: { toolName: 'Bash' },
    });

  it('keeps the time it came to need the user through a rename, a new model and a second approval', () => {
    later(10);
    approval('a1');
    const since = at(10);
    expect(thread()).toMatchObject({ state: 'needs_you', stateSince: since });
    later(5);
    dispatch({ type: 'thread.rename', threadId: 't1', title: 'Kettle timer, again' });
    dispatch({ type: 'thread.configure', threadId: 't1', model: 'sonnet' });
    approval('a2');
    expect(thread()).toMatchObject({ state: 'needs_you', stateSince: since });
  });
});
