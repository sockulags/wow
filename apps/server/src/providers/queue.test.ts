import type {
  Command,
  DomainEventKind,
  ProviderAdapter,
  ProviderCommand,
  ProviderEvent,
  ProviderKind,
} from '@wow/contracts';
import { SecretStore, plainProtector } from '@wow/secrets';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../core/engine.js';
import { snapshot } from '../core/subscriptions.js';
import { openDatabase, type Database } from '../db/database.js';
import { ProviderAdapters } from '../hooks/providers.js';
import { createLogger } from '../logger.js';
import { SettingsService } from '../settings/service.js';
import { ProviderService } from './service.js';

// Agent workbench spec 50 to 52: a message written during a turn is held by the server, joined
// by the next one, offered to the running turn, and sent when the turn ends.

// An adapter the test drives: it records what it is sent, takes a handed-over message only when
// told to, and emits what the test says.
class QueueAdapter implements ProviderAdapter {
  readonly requiresModel = false;
  readonly sent: ProviderCommand[] = [];
  readonly #listeners = new Set<(event: ProviderEvent) => void>();
  constructor(
    readonly kind: ProviderKind,
    readonly takes: boolean,
  ) {}

  send(command: ProviderCommand): Promise<unknown> {
    this.sent.push(command);
    if (command.type === 'handOver') return Promise.resolve({ taken: this.takes });
    return Promise.resolve({ ok: true });
  }

  emit(...events: ProviderEvent[]): void {
    for (const event of events) for (const listener of this.#listeners) listener(event);
  }

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

let dir: string;
let database: Database;
let engine: Engine;
let adapter: QueueAdapter;
let service: ProviderService;
let next = 0;
let tick = 0;

const clock = () => new Date(Date.UTC(2026, 10, 2, 8, 0, (tick += 1)));
const dispatch = (command: Command) => engine.dispatch(`c${(next += 1)}`, command);

const committed = (kind: DomainEventKind) =>
  new Promise<void>((resolve) => {
    const off = engine.onCommit((commit) => {
      if (commit.events.some(({ event }) => event.kind === kind)) {
        off();
        resolve();
      }
    });
  });

const rows = (topic: 'turns' | 'threadItems') =>
  snapshot(database.db, { topic, threadId: 't1' }) as Array<Record<string, unknown>>;
const thread = () =>
  (snapshot(database.db, { topic: 'threads' }) as Array<Record<string, unknown>>)[0];
const prompts = () =>
  adapter.sent.flatMap((command) => (command.type === 'startTurn' ? [command.prompt] : []));

// A provider service on the store; a second one stands for the server after a restart.
const startService = (kind: ProviderKind) =>
  new ProviderService({
    db: database.db,
    engine,
    adapters: new ProviderAdapters({ [kind]: () => adapter }, {}),
    settings: new SettingsService(database.db, engine),
    secrets: new SecretStore({ dir, protector: plainProtector }),
    home: dir,
    assistant: () => undefined,
    logger: createLogger(
      () => 'error',
      () => undefined,
    ),
  });

async function setup(kind: ProviderKind, takes: boolean) {
  adapter = new QueueAdapter(kind, takes);
  service = startService(kind);
  dispatch({
    type: 'providerInstance.create',
    providerInstanceId: 'work',
    kind,
    name: 'Work',
    binaryPath: kind,
    configDir: path.join(dir, kind),
    env: {},
    launchArgs: [],
  });
  dispatch({
    type: 'thread.create',
    threadId: 't1',
    providerInstanceId: 'work',
    cwd: '/work/demo',
    model: 'mock-model',
    effort: 'high',
    permissionMode: 'default',
  });
  const started = committed('turn.started');
  dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Read the readme' });
  await started;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-queue-'));
  database = openDatabase(path.join(dir, 'wow.sqlite'));
  engine = new Engine(database.db, { clock });
});

afterEach(async () => {
  await service.stop();
  database.close();
  await rm(dir, { recursive: true, force: true });
});

describe('queued messages', () => {
  it('holds a message written during a Codex turn, joins the next one and sends both when the turn ends (spec 50)', async () => {
    await setup('codex', false);
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Then sum it up' });
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'In three lines' });
    expect(thread()?.['queued']).toMatchObject({ text: 'Then sum it up\n\nIn three lines' });
    // Codex was offered each version and took none; nothing else went to it.
    expect(adapter.sent.map((command) => command.type)).toEqual([
      'startTurn',
      'handOver',
      'handOver',
    ]);

    const sent = committed('turn.started');
    adapter.emit({ type: 'turnCompleted', threadId: 't1' });
    await sent;
    expect(prompts()).toEqual(['Read the readme', 'Then sum it up\n\nIn three lines']);
    expect(thread()).toMatchObject({ queued: null, state: 'working' });
    expect(rows('threadItems').at(-1)).toMatchObject({
      kind: 'user',
      turnId: 't1:turn:1',
      payload: { text: 'Then sum it up\n\nIn three lines', queued: 'afterTurn' },
    });
  });

  it('hands a message to a running Claude Code turn and shows it sent in that turn (spec 51)', async () => {
    await setup('claude', true);
    const handed = committed('threadItem.added');
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Also check the license' });
    await handed;
    expect(adapter.sent.at(-1)).toEqual({
      type: 'handOver',
      threadId: 't1',
      prompt: 'Also check the license',
    });
    expect(thread()?.['queued']).toBeNull();
    expect(rows('threadItems').at(-1)).toMatchObject({
      kind: 'user',
      turnId: 't1:turn:0',
      payload: { text: 'Also check the license', queued: 'duringTurn' },
    });

    const ended = committed('turn.ended');
    adapter.emit({ type: 'turnCompleted', threadId: 't1' });
    await ended;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(prompts()).toEqual(['Read the readme']);
    expect(rows('turns')).toHaveLength(1);
  });

  it('keeps a message Claude Code did not take and sends it when the turn ends', async () => {
    await setup('claude', false);
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Then this' });
    const sent = committed('turn.started');
    adapter.emit({ type: 'turnFailed', threadId: 't1', error: 'Overloaded' });
    await sent;
    expect(prompts()).toEqual(['Read the readme', 'Then this']);
  });

  it('keeps a queued message for the next turn end when another turn starts first', async () => {
    await setup('codex', false);
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Queued one' });
    // What the workflow runner does with a step's held turn: it starts it on the same commit.
    const off = engine.onCommit((commit) => {
      if (!commit.events.some(({ event }) => event.kind === 'turn.ended')) return;
      off();
      dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Held step turn' });
    });
    const held = committed('turn.started');
    adapter.emit({ type: 'turnCompleted', threadId: 't1' });
    await held;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(prompts()).toEqual(['Read the readme', 'Held step turn']);
    expect(thread()?.['queued']).toMatchObject({ text: 'Queued one' });

    const sent = committed('turn.started');
    adapter.emit({ type: 'turnCompleted', threadId: 't1' });
    await sent;
    expect(prompts()).toEqual(['Read the readme', 'Held step turn', 'Queued one']);
    expect(thread()?.['queued']).toBeNull();
  });

  it('takes a queued message off on Cancel, and the server sends nothing (spec 52)', async () => {
    await setup('codex', false);
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Never mind this' });
    dispatch({ type: 'thread.cancelQueued', threadId: 't1' });
    expect(thread()?.['queued']).toBeNull();
    expect(() => dispatch({ type: 'thread.cancelQueued', threadId: 't1' })).toThrow(
      /No message waits/,
    );

    const ended = committed('turn.ended');
    adapter.emit({ type: 'turnCompleted', threadId: 't1' });
    await ended;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(prompts()).toEqual(['Read the readme']);
  });

  it('refuses an empty message while a turn runs', async () => {
    await setup('codex', false);
    expect(() => dispatch({ type: 'thread.sendMessage', threadId: 't1', text: '  ' })).toThrow(
      /needs text or a skill/,
    );
    expect(thread()?.['queued']).toBeNull();
  });

  it('sends a queued message once after a restart ends the turn it waited for', async () => {
    await setup('codex', false);
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'After the restart' });
    const sent = committed('turn.started');
    service.recover();
    await sent;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(rows('turns').map((turn) => turn['state'])).toEqual(['failed', 'running']);
    expect(prompts()).toEqual(['Read the readme', 'After the restart']);
  });

  it('sends a message left queued with no turn running when the server starts', async () => {
    await setup('codex', false);
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Waiting since yesterday' });
    // The turn ended in the store, but the server stopped before it sent the message.
    const ended = committed('turn.ended');
    await service.stop();
    engine.dispatch('ended-before-stop', {
      type: 'provider.events',
      threadId: 't1',
      events: [{ type: 'turnCompleted', threadId: 't1' }],
    });
    await ended;
    expect(thread()?.['queued']).toMatchObject({ text: 'Waiting since yesterday' });

    service = startService('codex');
    const sent = committed('turn.started');
    service.recover();
    await sent;
    expect(thread()).toMatchObject({ queued: null, state: 'working' });
    expect(rows('threadItems').at(-1)).toMatchObject({
      payload: { text: 'Waiting since yesterday', queued: 'afterTurn' },
    });
  });
});
