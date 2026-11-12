import type {
  Command,
  ProviderCommand,
  ProviderKind,
  Thread,
  ThreadItem,
  Turn,
} from '@wow/contracts';
import { SecretStore, plainProtector } from '@wow/secrets';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../db/database.js';
import { keptMessagesText, MockProviderAdapter, ProviderAdapters } from '../hooks/providers.js';
import { createLogger } from '../logger.js';
import { ProviderService } from '../providers/service.js';
import { SettingsService } from '../settings/service.js';
import { Engine } from './engine.js';
import { snapshot } from './subscriptions.js';

// Edit and Fork (agent workbench spec 62, 63, 71): both go back in the provider's conversation
// to the point it gave after a turn; files are never touched. The mock Claude Code keeps its
// own record of each session and says first what it still remembers. All invented.

let dir: string;
let database: Database;
let engine: Engine;
let adapters: Map<ProviderKind, MockProviderAdapter>;
let service: ProviderService;
let next = 0;
let tick = 0;

const clock = () => new Date(Date.UTC(2026, 10, 12, 9, 0, (tick += 1)));
const dispatch = (command: Command) => engine.dispatch(`c${(next += 1)}`, command);

const turnEnded = (threadId: string) =>
  new Promise<void>((resolve) => {
    const off = engine.onCommit((commit) => {
      if (
        commit.events.some(
          ({ event }) => event.kind === 'turn.ended' && event.payload.threadId === threadId,
        )
      ) {
        off();
        resolve();
      }
    });
  });

const send = async (threadId: string, text: string) => {
  const ended = turnEnded(threadId);
  dispatch({ type: 'thread.sendMessage', threadId, text });
  await ended;
};

const turns = (threadId: string) => snapshot(database.db, { topic: 'turns', threadId }) as Turn[];
const items = (threadId: string) =>
  snapshot(database.db, { topic: 'threadItems', threadId }) as ThreadItem[];
const threadOf = (threadId: string) =>
  (snapshot(database.db, { topic: 'threads' }) as Thread[]).find((row) => row.id === threadId);
const texts = (threadId: string, kind: ThreadItem['kind']) =>
  items(threadId)
    .filter((item) => item.kind === kind)
    .map((item) => (item.payload as { text: string }).text);
const starts = (kind: ProviderKind) =>
  (adapters.get(kind)?.sent ?? []).filter(
    (command): command is Extract<ProviderCommand, { type: 'startTurn' }> =>
      command.type === 'startTurn',
  );

async function threadOn(kind: ProviderKind, threadId: string) {
  dispatch({
    type: 'providerInstance.create',
    providerInstanceId: kind,
    kind,
    name: kind,
    binaryPath: kind,
    configDir: path.join(dir, kind),
    env: {},
    launchArgs: [],
  });
  dispatch({
    type: 'thread.create',
    threadId,
    providerInstanceId: kind,
    cwd: '/work/kettle',
    title: 'Kettle timer',
    model: 'mock-model',
    effort: 'high',
    permissionMode: 'acceptEdits',
  });
  await send(threadId, 'Plan the timer');
  await send(threadId, 'Build it');
  await send(threadId, 'Add a bell');
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-fork-edit-'));
  database = openDatabase(path.join(dir, 'wow.sqlite'));
  engine = new Engine(database.db, { clock });
  adapters = new Map();
  service = new ProviderService({
    db: database.db,
    engine,
    adapters: new ProviderAdapters(
      Object.fromEntries(
        (['claude', 'codex'] as const).map((kind) => [
          kind,
          () => {
            const adapter = new MockProviderAdapter(kind);
            adapters.set(kind, adapter);
            return adapter;
          },
        ]),
      ),
      {},
    ),
    settings: new SettingsService(database.db, engine),
    secrets: new SecretStore({ dir, protector: plainProtector }),
    home: dir,
    assistant: () => undefined,
    logger: createLogger(
      () => 'error',
      () => undefined,
    ),
  });
});

afterEach(async () => {
  await service.stop();
  database.close();
  await rm(dir, { recursive: true, force: true });
});

describe('the point a turn leaves the conversation at', () => {
  it('is kept with the turn and the session, and the turns topic says only that it exists', async () => {
    await threadOn('claude', 't1');
    expect(turns('t1').map((turn) => turn.resumable)).toEqual([true, true, true]);
    expect(turns('t1')[0]).not.toHaveProperty('resumePoint');
  });
});

describe('Edit (spec 62, 63)', () => {
  it('replaces the last exchange: the provider goes on from before it, and the old one stays as the earlier version', async () => {
    await threadOn('claude', 't1');
    const ended = turnEnded('t1');
    dispatch({ type: 'thread.editLast', threadId: 't1', turnId: 't1:turn:2', text: 'Add a light' });
    await ended;
    const last = starts('claude').at(-1);
    expect(last).toMatchObject({
      prompt: 'Add a light',
      resumeId: 'mock-t1',
      goBack: { at: 'mock-t1:2', fork: false },
    });
    expect(turns('t1').map((turn) => [turn.id, turn.replacedBy ?? null])).toEqual([
      ['t1:turn:0', null],
      ['t1:turn:1', null],
      ['t1:turn:2', 't1:turn:3'],
      ['t1:turn:3', null],
    ]);
    // The provider remembers the first two messages only.
    expect(texts('t1', 'assistant_text')).toContain(
      keptMessagesText(['Plan the timer', 'Build it']),
    );
    // The turn wrote after going back, so the next message goes on from it as usual.
    expect(threadOf('t1')?.goBack).toBeNull();
    await send('t1', 'And a snooze');
    expect(starts('claude').at(-1)).not.toHaveProperty('goBack');
  });

  it('starts a new conversation when the only message is edited', async () => {
    dispatch({
      type: 'providerInstance.create',
      providerInstanceId: 'claude',
      kind: 'claude',
      name: 'claude',
      binaryPath: 'claude',
      configDir: path.join(dir, 'claude'),
      env: {},
      launchArgs: [],
    });
    dispatch({
      type: 'thread.create',
      threadId: 't1',
      providerInstanceId: 'claude',
      cwd: '/work/kettle',
      model: 'mock-model',
      effort: 'high',
      permissionMode: 'default',
    });
    await send('t1', 'Plan the timer');
    const ended = turnEnded('t1');
    dispatch({
      type: 'thread.editLast',
      threadId: 't1',
      turnId: 't1:turn:0',
      text: 'Plan a kettle',
    });
    await ended;
    expect(starts('claude').at(-1)?.goBack).toEqual({ at: null, fork: false });
    expect(starts('claude').at(-1)).not.toHaveProperty('resumeId');
    expect(texts('t1', 'assistant_text')).toContain(keptMessagesText([]));
  });

  it('refuses a message that is not the last, while a turn runs, and on Codex with the reason', async () => {
    await threadOn('claude', 't1');
    expect(() =>
      dispatch({ type: 'thread.editLast', threadId: 't1', turnId: 't1:turn:1', text: 'x' }),
    ).toThrow(/Only the last message/);
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Wait' });
    expect(() =>
      dispatch({ type: 'thread.editLast', threadId: 't1', turnId: 't1:turn:3', text: 'x' }),
    ).toThrow(/A turn runs/);
    await threadOn('codex', 't2');
    expect(() =>
      dispatch({ type: 'thread.editLast', threadId: 't2', turnId: 't2:turn:2', text: 'x' }),
    ).toThrow(/Codex cannot go back in its conversation/);
  });

  it('refuses when the exchange before was answered before points were kept', async () => {
    await threadOn('claude', 't1');
    // As a thread stored before this change: no point on its turns.
    database.sqlite.prepare('UPDATE turns SET resume_point = NULL').run();
    expect(() =>
      dispatch({ type: 'thread.editLast', threadId: 't1', turnId: 't1:turn:2', text: 'x' }),
    ).toThrow(/before wow kept the place in the conversation/);
  });
});

describe('Fork (spec 71)', () => {
  it('copies the conversation up to the message, with the same settings and folder, and forks the provider at the next message', async () => {
    await threadOn('claude', 't1');
    dispatch({
      type: 'thread.create',
      threadId: 'f1',
      providerInstanceId: 'claude',
      cwd: '/somewhere/else',
      model: 'other',
      effort: 'low',
      permissionMode: 'default',
      forkFrom: { threadId: 't1', turnId: 't1:turn:1' },
    });
    const fork = threadOf('f1');
    expect(fork).toMatchObject({
      cwd: '/work/kettle',
      model: 'mock-model',
      effort: 'high',
      permissionMode: 'acceptEdits',
      title: 'Kettle timer (fork)',
      forkedFrom: { threadId: 't1', turnId: 't1:turn:1' },
      providerSessionId: null,
    });
    expect(texts('f1', 'user')).toEqual(['Plan the timer', 'Build it']);
    expect(texts('f1', 'assistant_text')).toEqual(['Plan the timer', 'Build it']);
    expect(items('f1').map((item) => item.turnId)).toEqual([
      'f1:turn:0',
      'f1:turn:0',
      'f1:turn:0',
      'f1:turn:1',
      'f1:turn:1',
      'f1:turn:1',
    ]);
    await send('f1', 'Add a light instead');
    expect(starts('claude').at(-1)).toMatchObject({
      threadId: 'f1',
      resumeId: 'mock-t1',
      goBack: { at: 'mock-t1:2', fork: true },
    });
    expect(texts('f1', 'assistant_text')).toContain(
      keptMessagesText(['Plan the timer', 'Build it']),
    );
    // The fork has its own session now; the origin is as it was.
    expect(threadOf('f1')?.providerSessionId).not.toBe('mock-t1');
    expect(threadOf('t1')?.providerSessionId).toBe('mock-t1');
    expect(turns('t1')).toHaveLength(3);
  });

  it('is refused on Codex with the reason, and for a message not in the conversation', async () => {
    await threadOn('codex', 't2');
    const fork = (from: { threadId: string; turnId: string }) =>
      dispatch({
        type: 'thread.create',
        threadId: 'f2',
        providerInstanceId: 'codex',
        cwd: '/work/kettle',
        model: 'mock-model',
        effort: 'high',
        permissionMode: 'auto',
        forkFrom: from,
      });
    expect(() => fork({ threadId: 't2', turnId: 't2:turn:1' })).toThrow(/Codex cannot go back/);
    await threadOn('claude', 't1');
    const ended = turnEnded('t1');
    dispatch({ type: 'thread.editLast', threadId: 't1', turnId: 't1:turn:2', text: 'Add a light' });
    await ended;
    expect(() => fork({ threadId: 't1', turnId: 't1:turn:2' })).toThrow(/not in the conversation/);
  });
});
