import type {
  Command,
  DomainEventKind,
  ProviderAdapter,
  ProviderAdapterContext,
  ProviderCommand,
  ProviderEvent,
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

// An adapter the test drives by hand: it records what the service sends and emits what the test
// tells it to, the way a provider streams after accepting a command.
class ControlledAdapter implements ProviderAdapter {
  readonly kind = 'claude' as const;
  readonly requiresModel = false;
  readonly sent: ProviderCommand[] = [];
  readonly #listeners = new Set<(event: ProviderEvent) => void>();
  failNext: string | undefined;

  send(command: ProviderCommand): Promise<unknown> {
    this.sent.push(command);
    if (this.failNext !== undefined) {
      const message = this.failNext;
      this.failNext = undefined;
      return Promise.reject(new Error(message));
    }
    if (command.type === 'test') {
      return Promise.resolve({
        ok: true,
        account: 'me@example.com',
        version: '2.1.316',
        message: null,
      });
    }
    if (command.type === 'listModels') {
      return Promise.resolve([
        { id: 'sonnet', label: 'Sonnet', description: '', efforts: ['high'] },
      ]);
    }
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
let adapter: ControlledAdapter;
let context: ProviderAdapterContext | undefined;
let service: ProviderService;
let next = 0;
let tick = 0;

const clock = () => new Date(Date.UTC(2026, 10, 2, 8, 0, (tick += 1)));
const dispatch = (command: Command) => engine.dispatch(`c${(next += 1)}`, command);

// Goes on with the terminal session on 'claude-shout' through an engine of its own platform.
const resumeOn = (on: Engine, threadId: string) =>
  on.dispatch(`c${(next += 1)}`, {
    type: 'thread.create',
    threadId,
    providerInstanceId: 'claude-shout',
    cwd: '/work/kettle',
    model: 'sonnet',
    effort: 'high',
    permissionMode: 'default',
    resumeSessionId: 'terminal-session-1',
  });

// Resolves once a commit with an event of this kind has been applied.
const committed = (kind: DomainEventKind) =>
  new Promise<void>((resolve) => {
    const off = engine.onCommit((commit) => {
      if (commit.events.some(({ event }) => event.kind === kind)) {
        off();
        resolve();
      }
    });
  });

const rows = (topic: 'threads' | 'turns' | 'threadItems' | 'approvals' | 'questions') =>
  snapshot(database.db, { topic, threadId: 't1' }) as Array<Record<string, unknown>>;
const thread = () =>
  (snapshot(database.db, { topic: 'threads' }) as Array<Record<string, unknown>>)[0];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-providers-'));
  database = openDatabase(path.join(dir, 'wow.sqlite'));
  engine = new Engine(database.db, { clock });
  const settings = new SettingsService(database.db, engine);
  const secrets = new SecretStore({ dir, protector: plainProtector });
  adapter = new ControlledAdapter();
  context = undefined;
  const adapters = new ProviderAdapters(
    {
      claude: (_instance, given) => {
        context = given;
        return adapter;
      },
    },
    {},
  );
  service = new ProviderService({
    db: database.db,
    engine,
    adapters,
    settings,
    secrets,
    home: dir,
    assistant: () => undefined,
    logger: createLogger(
      () => 'error',
      () => undefined,
    ),
  });
  const ref = await secrets.set('claude-key', 'sk-test');
  dispatch({
    type: 'providerInstance.create',
    providerInstanceId: 'claude-work',
    kind: 'claude',
    name: 'Work',
    binaryPath: 'claude',
    configDir: '/home/me/.claude',
    env: { ANTHROPIC_API_KEY: ref, PLAIN: 'yes' },
    launchArgs: [],
  });
  dispatch({
    type: 'thread.create',
    threadId: 't1',
    providerInstanceId: 'claude-work',
    cwd: '/work/demo',
    model: 'sonnet',
    effort: 'high',
    permissionMode: 'default',
  });
});

afterEach(async () => {
  await service.stop();
  database.close();
  await rm(dir, { recursive: true, force: true });
});

describe('provider service', () => {
  it('runs a turn and persists text, tools, approval, question, tasks and usage', async () => {
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'What is in the readme?' });
    expect(adapter.sent).toEqual([
      {
        type: 'startTurn',
        threadId: 't1',
        cwd: '/work/demo',
        prompt: 'What is in the readme?',
        model: 'sonnet',
        effort: 'high',
        permissionMode: 'default',
      },
    ]);
    expect(thread()).toMatchObject({ state: 'working' });
    expect(await context?.resolveEnv()).toEqual({ ANTHROPIC_API_KEY: 'sk-test', PLAIN: 'yes' });
    expect(context?.testTimeoutMs()).toBe(120_000);
    expect(context?.requestTimeoutMs()).toBe(60_000);

    let stored = committed('approval.requested');
    adapter.emit(
      { type: 'session', threadId: 't1', providerSessionId: 'sess-1' },
      { type: 'reasoningDelta', threadId: 't1', itemId: 'm1:0', delta: 'Think.' },
      { type: 'textDelta', threadId: 't1', itemId: 'm1:1', delta: 'Let me ' },
      { type: 'textDelta', threadId: 't1', itemId: 'm1:1', delta: 'look.' },
      {
        type: 'toolCallStarted',
        threadId: 't1',
        itemId: 'tool1',
        name: 'Bash',
        input: { command: 'ls' },
      },
      {
        type: 'approvalRequested',
        threadId: 't1',
        approvalId: 'tool1',
        kind: 'command',
        summary: 'Run ls',
        request: { toolName: 'Bash' },
      },
    );
    await stored;
    expect(thread()).toMatchObject({ state: 'needs_you', providerSessionId: 'sess-1' });
    expect(rows('approvals')).toEqual([
      {
        id: 't1:tool1',
        threadId: 't1',
        itemId: 't1:turn:0:approval:tool1',
        kind: 'command',
        request: { summary: 'Run ls', details: { toolName: 'Bash' } },
        decision: null,
        decidedAt: null,
      },
    ]);

    dispatch({ type: 'approval.answer', approvalId: 't1:tool1', decision: 'allowSession' });
    expect(adapter.sent.at(-1)).toEqual({
      type: 'answerApproval',
      approvalId: 'tool1',
      decision: 'allowSession',
    });
    expect(thread()).toMatchObject({ state: 'working' });
    expect(rows('approvals')[0]).toMatchObject({ decision: 'allowSession' });
    expect(() =>
      dispatch({ type: 'approval.answer', approvalId: 't1:tool1', decision: 'deny' }),
    ).toThrow(/already answered/);

    stored = committed('question.asked');
    adapter.emit(
      { type: 'toolCallOutput', threadId: 't1', itemId: 'tool1', output: 'README.md' },
      { type: 'toolCallCompleted', threadId: 't1', itemId: 'tool1', status: 'ok' },
      {
        type: 'questionAsked',
        threadId: 't1',
        questionId: 'ask1:0',
        question: 'Which file?',
        options: [{ label: 'README.md' }, { label: 'src' }],
        multiSelect: false,
      },
    );
    await stored;
    expect(thread()).toMatchObject({ state: 'needs_you' });
    dispatch({
      type: 'question.answer',
      answers: [{ questionId: 't1:ask1:0', reply: { picked: ['README.md'], text: '' } }],
    });
    expect(adapter.sent.at(-1)).toEqual({
      type: 'answerQuestion',
      questionId: 'ask1:0',
      answer: { picked: ['README.md'], text: '' },
    });
    expect(rows('questions')[0]).toMatchObject({ answer: 'README.md' });

    stored = committed('turn.ended');
    adapter.emit(
      {
        type: 'taskListUpdated',
        threadId: 't1',
        tasks: [{ id: '1', content: 'Read it', status: 'in_progress' }],
      },
      {
        type: 'taskListUpdated',
        threadId: 't1',
        tasks: [{ id: '1', content: 'Read it', status: 'completed' }],
      },
      { type: 'textDelta', threadId: 't1', itemId: 'm2:0', delta: 'It says hello.' },
      {
        type: 'usage',
        threadId: 't1',
        inputTokens: 125,
        outputTokens: 35,
        cachedInputTokens: 400,
        costUsd: 0.0123,
      },
      { type: 'contextUsage', threadId: 't1', usedTokens: 1500, maxTokens: 200_000 },
      { type: 'turnCompleted', threadId: 't1' },
    );
    await stored;

    expect(thread()).toMatchObject({ state: 'idle' });
    const usage = { inputTokens: 125, outputTokens: 35, cachedInputTokens: 400, costUsd: 0.0123 };
    expect(rows('turns')).toEqual([
      expect.objectContaining({ id: 't1:turn:0', index: 0, state: 'completed', usage }),
    ]);
    expect(
      rows('threadItems').map(({ id, kind, payload, streaming }) => ({
        id,
        kind,
        payload,
        streaming,
      })),
    ).toEqual([
      {
        id: 't1:turn:0:user',
        kind: 'user',
        payload: { text: 'What is in the readme?' },
        streaming: false,
      },
      {
        id: 't1:turn:0:m1:0',
        kind: 'reasoning',
        // When its first and latest part came (agent workbench spec 88).
        payload: { text: 'Think.', startedAt: expect.any(String), endedAt: expect.any(String) },
        streaming: false,
      },
      {
        id: 't1:turn:0:m1:1',
        kind: 'assistant_text',
        payload: { text: 'Let me look.' },
        streaming: false,
      },
      {
        id: 't1:turn:0:tool1',
        kind: 'tool_call',
        payload: {
          name: 'Bash',
          input: { command: 'ls' },
          output: 'README.md',
          status: 'ok',
          startedAt: expect.any(String),
          endedAt: expect.any(String),
        },
        streaming: false,
      },
      {
        id: 't1:turn:0:approval:tool1',
        kind: 'approval',
        payload: { approvalId: 't1:tool1', kind: 'command', summary: 'Run ls' },
        streaming: false,
      },
      {
        id: 't1:turn:0:question:ask1:0',
        kind: 'question',
        payload: {
          questionId: 't1:ask1:0',
          question: 'Which file?',
          options: [{ label: 'README.md' }, { label: 'src' }],
          multiSelect: false,
          reply: { picked: ['README.md'], text: '' },
        },
        streaming: false,
      },
      // Each update is its own item (agent workbench spec 31).
      {
        id: 't1:turn:0:tasks',
        kind: 'task_list',
        payload: {
          tasks: [{ id: '1', content: 'Read it', status: 'in_progress' }],
          at: expect.any(String),
        },
        streaming: false,
      },
      {
        id: 't1:turn:0:tasks:1',
        kind: 'task_list',
        payload: {
          tasks: [{ id: '1', content: 'Read it', status: 'completed' }],
          at: expect.any(String),
        },
        streaming: false,
      },
      {
        id: 't1:turn:0:m2:0',
        kind: 'assistant_text',
        payload: { text: 'It says hello.' },
        streaming: false,
      },
      {
        id: 't1:turn:0:usage',
        kind: 'usage',
        payload: { ...usage, context: { usedTokens: 1500, maxTokens: 200_000 }, model: 'sonnet' },
        streaming: false,
      },
    ]);
  });

  it('resumes the provider session and applies thread changes on the next turn', async () => {
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'First' });
    const ended = committed('turn.ended');
    adapter.emit(
      { type: 'session', threadId: 't1', providerSessionId: 'sess-1' },
      { type: 'turnCompleted', threadId: 't1' },
    );
    await ended;

    dispatch({ type: 'thread.configure', threadId: 't1', model: 'opus', permissionMode: 'plan' });
    expect(adapter.sent.slice(-2)).toEqual([
      { type: 'setModel', threadId: 't1', model: 'opus' },
      { type: 'setPermissionMode', threadId: 't1', permissionMode: 'plan' },
    ]);
    dispatch({ type: 'thread.configure', threadId: 't1', effort: 'low' });
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Second' });
    expect(adapter.sent.at(-1)).toEqual({
      type: 'startTurn',
      threadId: 't1',
      cwd: '/work/demo',
      prompt: 'Second',
      model: 'opus',
      effort: 'low',
      permissionMode: 'plan',
      resumeId: 'sess-1',
    });
    expect(rows('turns').map((turn) => turn['id'])).toEqual(['t1:turn:0', 't1:turn:1']);
  });

  it('resumes a session started in a terminal from the first message of its thread (spec 72)', async () => {
    dispatch({
      type: 'thread.create',
      threadId: 't2',
      providerInstanceId: 'claude-work',
      cwd: '/work/kettle',
      title: 'Make the kettle whistle twice',
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'default',
      resumeSessionId: 'terminal-session-1',
    });
    const created = (
      snapshot(database.db, { topic: 'threads' }) as Array<Record<string, unknown>>
    ).find((row) => row['id'] === 't2');
    expect(created?.['providerSessionId']).toBe('terminal-session-1');
    dispatch({ type: 'thread.sendMessage', threadId: 't2', text: 'Go on' });
    await service.idle();
    expect(
      adapter.sent.find((command) => command.type === 'startTurn' && command.threadId === 't2'),
    ).toMatchObject({ cwd: '/work/kettle', prompt: 'Go on', resumeId: 'terminal-session-1' });
    expect(() =>
      dispatch({
        type: 'thread.create',
        threadId: 't3',
        providerInstanceId: 'claude-work',
        cwd: '/work/kettle',
        model: 'sonnet',
        effort: 'high',
        permissionMode: 'default',
        resumeSessionId: 'terminal-session-1',
        forkFrom: { threadId: 't2', turnId: 't2:turn:0' },
      }),
    ).toThrow('A thread forks or resumes a session, not both');

    // Two threads writing to one session would interleave in its file (finding 142).
    const resume = (threadId: string, providerInstanceId: string) =>
      dispatch({
        type: 'thread.create',
        threadId,
        providerInstanceId,
        cwd: '/work/kettle',
        model: 'sonnet',
        effort: 'high',
        permissionMode: 'default',
        resumeSessionId: 'terminal-session-1',
      });
    const instance = (providerInstanceId: string, configDir: string) =>
      dispatch({
        type: 'providerInstance.create',
        providerInstanceId,
        kind: 'claude',
        name: providerInstanceId,
        binaryPath: 'claude',
        configDir,
        env: {},
        launchArgs: [],
      });
    instance('claude-default', '');
    instance('claude-home', '/home/me/.claude-home');
    const held = 'Thread "Make the kettle whistle twice" already goes on with this session';
    expect(() => resume('t4', 'claude-work')).toThrow(held);
    expect(() => resume('t5', 'claude-default')).toThrow(held);
    resume('t6', 'claude-home');
    expect(rows('threads').find((row) => row['id'] === 't6')?.['providerSessionId']).toBe(
      'terminal-session-1',
    );

    // On Windows a config folder spelled in another case is the same folder (finding 141).
    instance('claude-shout', '/HOME/ME/.CLAUDE');
    const windows = new Engine(database.db, { clock, platform: 'win32' });
    expect(() => resumeOn(windows, 't7')).toThrow(held);
    resumeOn(new Engine(database.db, { clock, platform: 'linux' }), 't8');
  });

  it('pins and unpins a thread without touching its activity time', () => {
    const before = rows('threads')[0];
    expect(dispatch({ type: 'thread.setPinned', threadId: 't1', pinned: true }).seqs).toHaveLength(
      1,
    );
    expect(dispatch({ type: 'thread.setPinned', threadId: 't1', pinned: true }).seqs).toEqual([]);
    expect(rows('threads')[0]).toEqual({ ...before, pinned: true });
    dispatch({ type: 'thread.setPinned', threadId: 't1', pinned: false });
    expect(rows('threads')[0]).toEqual(before);
  });

  it('marks a thread done, reopens it, and a new message reopens it too', async () => {
    expect(dispatch({ type: 'thread.setDone', threadId: 't1', done: true }).seqs).toHaveLength(1);
    expect(thread()).toMatchObject({ state: 'done' });
    expect(dispatch({ type: 'thread.setDone', threadId: 't1', done: true }).seqs).toEqual([]);
    dispatch({ type: 'thread.setDone', threadId: 't1', done: false });
    expect(thread()).toMatchObject({ state: 'idle' });
    expect(dispatch({ type: 'thread.setDone', threadId: 't1', done: false }).seqs).toEqual([]);

    dispatch({ type: 'thread.setDone', threadId: 't1', done: true });
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'One more thing' });
    expect(thread()).toMatchObject({ state: 'working' });
    expect(() => dispatch({ type: 'thread.setDone', threadId: 't1', done: true })).toThrow(
      /is working/,
    );

    const asked = committed('approval.requested');
    adapter.emit({
      type: 'approvalRequested',
      threadId: 't1',
      approvalId: 'a1',
      kind: 'command',
      summary: 'Run pnpm test',
      request: { command: 'pnpm test' },
    });
    await asked;
    expect(() => dispatch({ type: 'thread.setDone', threadId: 't1', done: true })).toThrow(
      /waiting for you/,
    );

    const ended = committed('turn.ended');
    adapter.emit({ type: 'turnCompleted', threadId: 't1' });
    await ended;
    expect(thread()).toMatchObject({ state: 'idle' });
    expect(() => dispatch({ type: 'thread.setDone', threadId: 'missing', done: true })).toThrow(
      /No thread/,
    );
  });

  it('reopens a thread whose last turn failed with its failed marker', async () => {
    adapter.failNext = 'Provider went away';
    const ended = committed('turn.ended');
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Hi' });
    await ended;
    dispatch({ type: 'thread.setDone', threadId: 't1', done: true });
    expect(thread()).toMatchObject({ state: 'done' });
    dispatch({ type: 'thread.setDone', threadId: 't1', done: false });
    expect(thread()).toMatchObject({ state: 'failed' });
  });

  // Agent workbench spec 90: Stop on a background chip and Ctrl+B on a running command reach
  // Claude Code as its own stopTask and backgroundTasks, by the provider's ids.
  it('sends Stop for a background task and Ctrl+B for a running command to the adapter', async () => {
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Start the dev server' });
    const listed = committed('thread.backgroundChanged');
    adapter.emit(
      {
        type: 'toolCallStarted',
        threadId: 't1',
        itemId: 'bash-7',
        name: 'Bash',
        input: { command: 'pnpm dev' },
        kind: 'command',
        command: 'pnpm dev',
      },
      {
        type: 'backgroundTasks',
        threadId: 't1',
        tasks: [{ id: 'bg-1', description: 'Count the tea leaves', agent: true, kind: 'agent' }],
      },
    );
    await listed;
    dispatch({ type: 'thread.toBackground', threadId: 't1', itemId: 't1:turn:0:bash-7' });
    expect(adapter.sent.at(-1)).toEqual({ type: 'toBackground', threadId: 't1', itemId: 'bash-7' });
    dispatch({ type: 'thread.toBackground', threadId: 't1' });
    expect(adapter.sent.at(-1)).toEqual({ type: 'toBackground', threadId: 't1' });
    dispatch({ type: 'thread.stopTask', threadId: 't1', taskId: 'bg-1' });
    expect(adapter.sent.at(-1)).toEqual({ type: 'stopTask', threadId: 't1', taskId: 'bg-1' });
    // A provider that refuses does not end the turn; the thread says why.
    adapter.failNext = 'Background tasks are disabled';
    const told = committed('threadItem.added');
    dispatch({ type: 'thread.stopTask', threadId: 't1', taskId: 'bg-1' });
    await told;
    expect(thread()).toMatchObject({ state: 'working' });
    expect(rows('threadItems').at(-1)).toMatchObject({
      kind: 'error',
      payload: { message: 'Could not stop the task: Background tasks are disabled' },
    });
  });

  it('stops a running turn and keeps its partial output', async () => {
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Long task' });
    // A second message waits for the turn instead (agent workbench spec 50); taken off again here.
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Again' });
    expect(thread()).toMatchObject({ queued: { text: 'Again' } });
    dispatch({ type: 'thread.cancelQueued', threadId: 't1' });
    const partial = committed('threadItem.added');
    adapter.emit({ type: 'textDelta', threadId: 't1', itemId: 'm1:0', delta: 'Half' });
    await partial;

    dispatch({ type: 'thread.interrupt', threadId: 't1' });
    expect(adapter.sent.at(-1)).toEqual({ type: 'interrupt', threadId: 't1' });
    const ended = committed('turn.ended');
    adapter.emit({ type: 'turnInterrupted', threadId: 't1' });
    await ended;
    // Output that arrives after the turn ended is not attached to it.
    expect(
      engine.dispatch('late', {
        type: 'provider.events',
        threadId: 't1',
        events: [{ type: 'textDelta', threadId: 't1', itemId: 'm1:0', delta: ' more' }],
      }).seqs,
    ).toEqual([]);
    expect(rows('turns')[0]).toMatchObject({ state: 'interrupted' });
    expect(rows('threadItems')[1]).toMatchObject({
      kind: 'assistant_text',
      payload: { text: 'Half' },
      streaming: false,
    });
    expect(() => dispatch({ type: 'thread.interrupt', threadId: 'missing' })).toThrow(/No thread/);
  });

  // Claude Code goes on by itself when its background work ends (owner report, findings Q).
  it('records a turn the provider starts by itself after background work, and stops it', async () => {
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Count in the background' });
    const first = committed('turn.ended');
    adapter.emit(
      { type: 'textDelta', threadId: 't1', itemId: 'm1:0', delta: 'Started an agent.' },
      {
        type: 'backgroundTasks',
        threadId: 't1',
        tasks: [{ id: 'bg-1', description: 'Count the tea leaves' }],
      },
      { type: 'turnCompleted', threadId: 't1' },
    );
    await first;
    expect(thread()).toMatchObject({
      state: 'idle',
      backgroundTasks: [{ id: 'bg-1', description: 'Count the tea leaves' }],
    });

    const second = committed('turn.ended');
    adapter.emit(
      { type: 'backgroundTasks', threadId: 't1', tasks: [] },
      { type: 'turnStartedByProvider', threadId: 't1' },
      { type: 'textDelta', threadId: 't1', itemId: 'm2:0', delta: 'Counted 42 leaves.' },
      { type: 'usage', threadId: 't1', inputTokens: 5, outputTokens: 6, cachedInputTokens: 0 },
      { type: 'turnCompleted', threadId: 't1' },
    );
    await second;
    expect(rows('turns')).toMatchObject([
      { id: 't1:turn:0', state: 'completed' },
      {
        id: 't1:turn:1',
        index: 1,
        state: 'completed',
        usage: { inputTokens: 5, outputTokens: 6, cachedInputTokens: 0 },
      },
    ]);
    expect(rows('threadItems').filter((item) => item['turnId'] === 't1:turn:1')).toMatchObject([
      { kind: 'assistant_text', payload: { text: 'Counted 42 leaves.' }, streaming: false },
      { kind: 'usage' },
    ]);
    expect(thread()).toMatchObject({ state: 'idle', backgroundTasks: [] });
    // Nothing was sent to the provider for the turn it started itself.
    expect(adapter.sent.map((command) => command.type)).toEqual(['startTurn']);

    // Stop works on such a turn like on any other.
    const started = committed('turn.startedByProvider');
    adapter.emit({ type: 'turnStartedByProvider', threadId: 't1' });
    await started;
    expect(thread()).toMatchObject({ state: 'working' });
    dispatch({ type: 'thread.interrupt', threadId: 't1' });
    expect(adapter.sent.at(-1)).toEqual({ type: 'interrupt', threadId: 't1' });
    const stopped = committed('turn.ended');
    adapter.emit({ type: 'turnInterrupted', threadId: 't1' });
    await stopped;
    expect(rows('turns')[2]).toMatchObject({ state: 'interrupted' });
  });

  it('keeps what the provider does by itself in the turn wow started while that runs', async () => {
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Hi' });
    const ended = committed('turn.ended');
    adapter.emit(
      { type: 'turnStartedByProvider', threadId: 't1' },
      { type: 'textDelta', threadId: 't1', itemId: 'm1:0', delta: 'Hello' },
      { type: 'turnCompleted', threadId: 't1' },
    );
    await ended;
    expect(rows('turns')).toHaveLength(1);
    expect(rows('threadItems').at(-1)).toMatchObject({ turnId: 't1:turn:0' });
  });

  // Only a workflow step waits for a turn after background work (workflows.test.ts covers it);
  // a chat thread that was idle stays as it was.
  it('clears the background work of an idle chat thread on restart without failing it', async () => {
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Hi' });
    const first = committed('turn.ended');
    adapter.emit(
      {
        type: 'backgroundTasks',
        threadId: 't1',
        tasks: [{ id: 'bg-1', description: 'Count', agent: true }],
      },
      { type: 'turnCompleted', threadId: 't1' },
    );
    await first;
    const before = thread();
    const recovered = committed('thread.backgroundChanged');
    service.recover();
    await recovered;
    expect(rows('turns')).toHaveLength(1);
    expect(thread()).toMatchObject({ state: before?.state, backgroundTasks: [] });
  });

  it('fails the turn when the provider refuses to start it', async () => {
    adapter.failNext = 'Unknown Claude effort "extreme"';
    const ended = committed('turn.ended');
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Hi' });
    await ended;
    expect(thread()).toMatchObject({ state: 'failed' });
    expect(rows('turns')[0]).toMatchObject({ state: 'failed' });
    expect(rows('threadItems').at(-1)).toMatchObject({
      kind: 'error',
      payload: { message: 'Unknown Claude effort "extreme"' },
    });
  });

  it('fails turns left running by a previous server process', async () => {
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Hi' });
    const recovered = committed('turn.ended');
    service.recover();
    await recovered;
    expect(rows('turns')[0]).toMatchObject({ state: 'failed' });
    expect(thread()).toMatchObject({ state: 'failed' });
  });

  it('tests an instance and records status, account and version', async () => {
    expect(await service.test('claude-work')).toEqual({
      ok: true,
      account: 'me@example.com',
      version: '2.1.316',
      message: null,
    });
    expect(snapshot(database.db, { topic: 'providerInstances' })[0]).toMatchObject({
      status: 'ready',
      account: 'me@example.com',
      version: '2.1.316',
      statusMessage: null,
    });
    adapter.failNext = 'claude: command not found';
    expect(await service.test('claude-work')).toMatchObject({
      ok: false,
      message: 'claude: command not found',
    });
    expect(snapshot(database.db, { topic: 'providerInstances' })[0]).toMatchObject({
      status: 'error',
      statusMessage: 'claude: command not found',
    });
    expect(await service.listModels('claude-work')).toEqual([
      { id: 'sonnet', label: 'Sonnet', description: '', efforts: ['high'] },
    ]);
    await expect(service.test('nope')).rejects.toThrow(/No provider instance nope/);
  });

  it('refuses threads on unknown provider instances or projects', () => {
    expect(() =>
      dispatch({
        type: 'thread.create',
        threadId: 't2',
        providerInstanceId: 'missing',
        cwd: '/w',
        model: 'm',
        effort: 'high',
        permissionMode: 'default',
      }),
    ).toThrow(/No provider instance missing/);
    expect(() =>
      dispatch({
        type: 'thread.create',
        threadId: 't2',
        providerInstanceId: 'claude-work',
        projectId: 'nope',
        cwd: '/w',
        model: 'm',
        effort: 'high',
        permissionMode: 'default',
      }),
    ).toThrow(/No project nope/);
  });
});
