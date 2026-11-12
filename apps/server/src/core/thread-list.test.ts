import type {
  AppNotification,
  Command,
  ProviderEvent,
  ServerCommand,
  Thread,
} from '@wow/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../db/database.js';
import { events as eventLog, threads as threadsTable } from '../db/schema.js';
import { Engine } from './engine.js';
import { snapshot } from './subscriptions.js';
import { searchThreads } from './thread-search.js';

// Chat notifications and the thread list (agent workbench U2): what the server stores when a chat
// thread needs the user or a long turn ends, and rename, archive, unread and search. Provider
// events are dispatched as the provider service would; the clock moves only when a test says so.
// All invented.

let dir: string;
let database: Database;
let engine: Engine;
let now: number;
let next = 0;

const start = Date.UTC(2026, 10, 2, 8, 0, 0);
const dispatch = (command: Command | ServerCommand) => engine.dispatch(`c${(next += 1)}`, command);
const events = (threadId: string, ...list: ProviderEvent[]) =>
  dispatch({ type: 'provider.events', threadId, events: list });
const later = (seconds: number) => {
  now += seconds * 1000;
};
const thread = (id = 't1') =>
  (snapshot(database.db, { topic: 'threads' }) as Thread[]).find((row) => row.id === id);
const archivedEvents = () =>
  database.db
    .select()
    .from(eventLog)
    .all()
    .filter((row) => row.kind === 'thread.archived')
    .map((row) => (row.payload as { archived: boolean }).archived);
const notifications = () => snapshot(database.db, { topic: 'notifications' }) as AppNotification[];
const setting = (key: string, value: unknown) =>
  dispatch({ type: 'setting.set', key, scope: 'global', value });

const create = (threadId: string, title: string, projectId?: string) =>
  dispatch({
    type: 'thread.create',
    threadId,
    providerInstanceId: 'claude-work',
    ...(projectId ? { projectId } : {}),
    cwd: '/work/kettle',
    title,
    model: 'sonnet',
    effort: 'high',
    permissionMode: 'default',
  });

const approval = (threadId: string, approvalId = 'tool-1'): ProviderEvent => ({
  type: 'approvalRequested',
  threadId,
  approvalId,
  kind: 'command',
  summary: 'Allow pnpm test?',
  request: { toolName: 'Bash' },
});

const question = (questionId: string, text: string): ProviderEvent => ({
  type: 'questionAsked',
  threadId: 't1',
  questionId,
  askId: 'ask-1',
  question: text,
  options: [{ label: 'Red' }],
  multiSelect: false,
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-thread-list-'));
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
  create('t1', 'Kettle timer');
});

afterEach(async () => {
  database.close();
  await rm(dir, { recursive: true, force: true });
});

describe('chat notifications (spec 64, 65)', () => {
  it('stores "Needs you" with the thread and the approval when a chat thread asks for approval', () => {
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Run the tests' });
    events('t1', approval('t1'));
    expect(notifications()).toEqual([
      {
        id: 't1:needs-you:tool-1',
        at: new Date(start).toISOString(),
        kind: 'waiting',
        title: 'Needs you: Kettle timer',
        body: 'Allow pnpm test?',
        path: '/chat/t1',
        runId: null,
        calendarItemId: null,
        threadId: 't1',
        approvalId: 't1:tool-1',
      },
    ]);
  });

  it('stores one "Needs you" for the questions of one ask', () => {
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Ask me' });
    events('t1', question('ask-1:0', 'Which colour?'), question('ask-1:1', 'Which size?'));
    expect(
      notifications().map(({ title, body, approvalId }) => ({ title, body, approvalId })),
    ).toEqual([{ title: 'Needs you: Kettle timer', body: 'Which colour?', approvalId: null }]);
  });

  it('stores "Finished" for a turn longer than the setting, with "needs you and finished" only', () => {
    setting('chat.finishedAfterSeconds', 60);
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Quick one' });
    later(30);
    events('t1', { type: 'turnCompleted', threadId: 't1' });
    expect(notifications()).toEqual([]);

    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Long one' });
    later(61);
    events('t1', { type: 'turnCompleted', threadId: 't1' });
    expect(notifications()).toMatchObject([
      {
        id: 't1:turn:1:finished',
        kind: 'finished',
        title: 'Finished: Kettle timer',
        threadId: 't1',
      },
    ]);

    setting('chat.notifications', 'needsYou');
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Long again' });
    later(61);
    events('t1', { type: 'turnCompleted', threadId: 't1' });
    expect(notifications()).toHaveLength(1);
  });

  it('stores neither with the choice "off"', () => {
    setting('chat.notifications', 'off');
    setting('chat.finishedAfterSeconds', 0);
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Run the tests' });
    events('t1', approval('t1'));
    later(5);
    dispatch({ type: 'approval.answer', approvalId: 't1:tool-1', decision: 'allowOnce' });
    events('t1', { type: 'turnCompleted', threadId: 't1' });
    expect(notifications()).toEqual([]);
  });

  it('tells nothing for a turn the user stopped', () => {
    setting('chat.finishedAfterSeconds', 0);
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Long one' });
    later(5);
    events('t1', { type: 'turnInterrupted', threadId: 't1' });
    expect(notifications()).toEqual([]);
  });
});

describe('the thread list (spec 67 to 70)', () => {
  it('renames a thread, and refuses an empty title', () => {
    dispatch({ type: 'thread.rename', threadId: 't1', title: '  Kettle timer, part two ' });
    expect(thread()?.title).toBe('Kettle timer, part two');
    expect(() => dispatch({ type: 'thread.rename', threadId: 't1', title: '   ' })).toThrow(
      'A thread needs a title',
    );
  });

  it('archives and unarchives a chat thread, and refuses a workflow step thread', () => {
    dispatch({ type: 'thread.setArchived', threadId: 't1', archived: true });
    expect(thread()?.archived).toBe(true);
    dispatch({ type: 'thread.setArchived', threadId: 't1', archived: false });
    expect(thread()?.archived).toBe(false);

    database.db
      .insert(threadsTable)
      .values({
        id: 'step-thread',
        projectId: null,
        cwd: '/work/kettle',
        branch: null,
        providerInstanceId: 'claude-work',
        providerSessionId: null,
        title: 'Feature: deliver-work',
        model: 'sonnet',
        effort: 'high',
        permissionMode: 'default',
        state: 'idle',
        pinned: false,
        runId: 'run-1',
        stepId: 's1',
        createdAt: new Date(start).toISOString(),
        updatedAt: new Date(start).toISOString(),
      })
      .run();
    expect(() =>
      dispatch({ type: 'thread.setArchived', threadId: 'step-thread', archived: true }),
    ).toThrow("A workflow step's thread belongs to its run, so it is not archived on its own.");
    expect(thread('step-thread')?.archived).toBe(false);
  });

  it('brings an archived thread back when a turn starts or a request arrives, once', () => {
    const archive = () => dispatch({ type: 'thread.setArchived', threadId: 't1', archived: true });

    archive();
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Run the tests' });
    expect(thread()?.archived).toBe(false);

    archive();
    // Two requests in one batch, and another later: one event brings it back.
    events('t1', approval('t1', 'tool-1'), approval('t1', 'tool-2'));
    expect(thread()?.archived).toBe(false);
    events('t1', approval('t1', 'tool-3'));
    expect(archivedEvents()).toEqual([true, false, true, false]);

    archive();
    events('t1', question('q1', 'Which colour?'));
    expect(thread()?.archived).toBe(false);
    expect(notifications().map((row) => row.threadId)).toContain('t1');

    events('t1', { type: 'turnCompleted', threadId: 't1' });
    archive();
    events('t1', { type: 'turnStartedByProvider', threadId: 't1' });
    expect(thread()?.archived).toBe(false);
    expect(archivedEvents()).toEqual([true, false, true, false, true, false, true, false]);
  });

  it('marks a thread unread when a turn ends or it starts to need the user, until it is seen', () => {
    expect(thread()?.seen).toBe(true);
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Hello' });
    events('t1', { type: 'turnCompleted', threadId: 't1' });
    expect(thread()?.seen).toBe(false);
    dispatch({ type: 'thread.markSeen', threadId: 't1' });
    expect(thread()?.seen).toBe(true);

    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Run the tests' });
    events('t1', approval('t1'));
    expect(thread()?.seen).toBe(false);
    dispatch({ type: 'thread.markSeen', threadId: 't1' });

    dispatch({ type: 'thread.markUnread', threadId: 't1' });
    expect(thread()?.seen).toBe(false);
    // Neither changes when the thread was last active, so the list keeps its order.
    expect(thread()?.updatedAt).toBe(new Date(start).toISOString());
  });

  it('finds threads by title, project name and a word only in a message, archived ones too', () => {
    dispatch({ type: 'project.create', projectId: 'p-garden', name: 'Garden', cwd: dir });
    later(1);
    create('t2', 'Water the plants', 'p-garden');
    later(1);
    create('t3', 'Untitled musings');
    dispatch({ type: 'thread.sendMessage', threadId: 't3', text: 'The teapot whistles at dawn' });
    events('t3', {
      type: 'textDelta',
      threadId: 't3',
      itemId: 'm1',
      delta: 'A 100% copper kettle_lid hums.',
    });
    dispatch({ type: 'thread.setArchived', threadId: 't3', archived: true });

    expect(searchThreads(database.db, 'kettle')).toEqual(['t3', 't1']);
    expect(searchThreads(database.db, 'garden')).toEqual(['t2']);
    expect(searchThreads(database.db, 'TEAPOT dawn')).toEqual(['t3']);
    expect(searchThreads(database.db, 'teapot timer')).toEqual([]);
    expect(searchThreads(database.db, '100%')).toEqual(['t3']);
    expect(searchThreads(database.db, '0%')).toEqual(['t3']);
    expect(searchThreads(database.db, 'kettle_')).toEqual(['t3']);
    expect(searchThreads(database.db, 'e%l')).toEqual([]);
  });

  it('matches a capital letter outside ASCII in a message whatever the case typed', () => {
    create('t4', 'Notes');
    dispatch({ type: 'thread.sendMessage', threadId: 't4', text: 'Über den Tee mit Émile' });

    expect(searchThreads(database.db, 'über')).toEqual(['t4']);
    expect(searchThreads(database.db, 'ÜBER')).toEqual(['t4']);
    expect(searchThreads(database.db, 'émile')).toEqual(['t4']);
  });
});
