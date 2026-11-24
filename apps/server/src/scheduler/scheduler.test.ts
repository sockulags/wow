import type {
  CalendarItem,
  MissedTriggerPolicy,
  ProviderCommand,
  ProviderEvent,
  ProviderInstance,
  ServerCommand,
  Thread,
  Trigger,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { eq } from 'drizzle-orm';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  calendarItems,
  notifications,
  providerInstances,
  threads,
  triggers,
  workflowRuns,
} from '../db/schema.js';
import { MockProviderAdapter } from '../hooks/index.js';
import { startServer, type RunningServer } from '../server.js';
import type { SchedulerTimers } from './service.js';

// U11 ground truth, and scheduled jobs as main threads (orchestrator threads spec 27, 28): the
// scheduler's tick and missed policy with a clock the test moves. Nothing sleeps: the tick runs
// when the test calls it, and waits resolve on the commit that matches.

let root: string;
let projectDir: string;
let server: RunningServer;
let now: Date;
let ticks: number[];

const start = new Date('2026-11-02T09:00:00.000Z');
const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
const iso = (seconds: number) => at(seconds).toISOString();

const timers: SchedulerTimers = {
  setTimeout: (_callback, delayMs) => ticks.push(delayMs),
  clearTimeout: () => undefined,
};

const instance: ProviderInstance = {
  id: 'claude-work',
  kind: 'claude',
  name: 'Work',
  binaryPath: 'claude',
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: 'opus',
  defaultEffort: 'high',
  defaultPermissionMode: 'default',
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
};

// What the mock agent does with the card's text: "Keep working" never ends its turn, anything
// else ends it.
const script = (command: ProviderCommand): ProviderEvent[] => {
  if (command.type !== 'startTurn') return [];
  const { threadId } = command;
  const session: ProviderEvent = { type: 'session', threadId, providerSessionId: `s-${threadId}` };
  if (command.prompt.includes('Keep working')) return [session];
  return [
    session,
    { type: 'textDelta', threadId, itemId: `${threadId}-text`, delta: 'Done.' },
    { type: 'turnCompleted', threadId },
  ];
};

let commandCount = 0;
const dispatch = (command: ServerCommand) =>
  server.engine.dispatch(`test-${(commandCount += 1)}`, command);

const db = () => server.database.db;
const card = (id = 'c1') =>
  db().select().from(calendarItems).where(eq(calendarItems.id, id)).get() as CalendarItem;
const trigger = (cardId = 'c1') =>
  db()
    .select()
    .from(triggers)
    .where(eq(triggers.id, `${cardId}:trigger`))
    .get() as Trigger | undefined;
const allThreads = (): Thread[] => db().select().from(threads).all();
const thread = (id: string): Thread | undefined =>
  db().select().from(threads).where(eq(threads.id, id)).get();
const notices = () =>
  db()
    .select()
    .from(notifications)
    .all()
    .map((row) => [row.kind, row.title]);

// Resolves on the commit after which the card matches.
function cardBecomes(predicate: (current: CalendarItem) => boolean): Promise<CalendarItem> {
  return new Promise((resolve) => {
    const check = () => {
      const found = card();
      if (found && predicate(found)) {
        unsubscribe();
        resolve(found);
      }
    };
    const unsubscribe = server.engine.onCommit(check);
    check();
  });
}

async function launch(): Promise<RunningServer> {
  return startServer({
    home: path.join(root, '.wow'),
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: path.join(root, 'user'),
    watchSkills: () => ({ close: () => Promise.resolve() }),
    clock: () => now,
    schedulerTimers: timers,
    hooks: {
      providers: { claude: (row) => new MockProviderAdapter(row.kind, script) },
    },
  });
}

// A server stopped while time passes, then started again.
async function restart(secondsLater: number): Promise<void> {
  await server.providerService.idle();
  await server.stop();
  now = at(secondsLater);
  server = await launch();
}

const createCard = (overrides: Partial<Extract<ServerCommand, { type: 'card.create' }>> = {}) =>
  dispatch({
    type: 'card.create',
    cardId: 'c1',
    title: 'Fix the login bug',
    start: iso(60),
    end: iso(60 + 1800),
    zone: 'Europe/Stockholm',
    projectId: 'p1',
    workflowName: 'Bug',
    ...overrides,
  });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-scheduler-'));
  projectDir = path.join(root, 'project');
  await mkdir(projectDir, { recursive: true });
  // The workflow the cards start, as a file in wow's own workflow folder (spec 19).
  await mkdir(path.join(root, '.wow', 'workflows'), { recursive: true });
  await writeFile(
    path.join(root, '.wow', 'workflows', 'Bug.md'),
    '---\nname: Bug\n---\n\n## Fix it\n\ngate: after\n',
  );
  now = start;
  ticks = [];
  server = await launch();
  db().insert(providerInstances).values(instance).run();
  dispatch({ type: 'project.create', projectId: 'p1', name: 'wow', cwd: projectDir });
  await server.skills.refresh();
});

afterEach(async () => {
  await server.providerService.idle();
  await server.cardFollower.settled();
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('triggers follow their card', () => {
  it('schedules a trigger for a card with a workflow and moves it with the card (behavior 6)', () => {
    createCard();
    expect(trigger()).toMatchObject({
      calendarItemId: 'c1',
      workflowId: 'Bug',
      runAt: iso(60),
      zone: 'Europe/Stockholm',
      state: 'scheduled',
      runId: null,
      offerRunNow: false,
    });
    expect(card()).toMatchObject({ state: 'scheduled', threadMode: 'new', workflowName: 'Bug' });

    dispatch({ type: 'card.update', cardId: 'c1', start: iso(3600), end: iso(5400) });
    expect(trigger()).toMatchObject({ runAt: iso(3600), state: 'scheduled' });

    dispatch({ type: 'card.update', cardId: 'c1', workflowName: null });
    expect(trigger()?.state).toBe('cancelled');
    dispatch({ type: 'card.update', cardId: 'c1', workflowName: 'Bug' });
    expect(trigger()?.state).toBe('scheduled');
  });

  it('needs a workflow but no project (orchestrator threads spec 27)', () => {
    createCard({ projectId: undefined, workflowName: undefined });
    expect(trigger()).toBeUndefined();
    dispatch({ type: 'card.update', cardId: 'c1', workflowName: 'Bug' });
    expect(trigger()?.state).toBe('scheduled');
  });

  it('marks a card whose time has already passed as missed with Run now', () => {
    createCard({ start: iso(-600), end: iso(600) });
    expect(trigger()).toMatchObject({ state: 'missed', offerRunNow: true });
    expect(card().state).toBe('missed');
    dispatch({ type: 'card.update', cardId: 'c1', start: iso(600), end: iso(1200) });
    expect(trigger()).toMatchObject({ state: 'scheduled', offerRunNow: false });
    expect(card().state).toBe('scheduled');
  });
});

describe('the tick', () => {
  it('waits on scheduler.tickSeconds', () => {
    expect(ticks).toEqual([30_000]);
    dispatch({ type: 'setting.set', key: 'scheduler.tickSeconds', scope: 'global', value: 5 });
    expect(ticks.at(-1)).toBe(5000);
  });

  it('starts a main thread that runs the workflow with the card text, and the card follows it to done', async () => {
    createCard({ body: 'The login page loops.' });
    now = at(59);
    server.scheduler.tick();
    expect(allThreads()).toEqual([]);

    now = at(60);
    server.scheduler.tick();
    const [started] = allThreads();
    expect(started).toMatchObject({
      title: 'Fix the login bug',
      projectId: 'p1',
      cwd: projectDir,
      providerInstanceId: 'claude-work',
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
      parentThreadId: null,
      runId: null,
    });
    const threadId = started?.id ?? '';
    expect(trigger()).toMatchObject({ state: 'fired', runId: threadId });
    expect(card()).toMatchObject({ state: 'running', threadId, runId: null });
    expect(runs()).toEqual([]);

    await cardBecomes((current) => current.state === 'done');
    await server.providerService.idle();
    expect(notices()).toEqual([['started', 'Scheduled thread started']]);

    // A later tick does not fire the trigger again.
    now = at(120);
    server.scheduler.tick();
    expect(allThreads()).toHaveLength(1);
  });

  it('shows waiting while the thread waits for the user, then how its turn ended (spec 28)', async () => {
    createCard({ body: 'Keep working' });
    now = at(60);
    server.scheduler.tick();
    const threadId = card().threadId ?? '';
    await server.providerService.idle();
    dispatch({
      type: 'provider.events',
      threadId,
      events: [
        {
          type: 'approvalRequested',
          threadId,
          approvalId: 'a1',
          kind: 'command',
          summary: 'Allow the build?',
          request: { toolName: 'Bash' },
        },
      ],
    });
    await cardBecomes((current) => current.state === 'waiting');
    expect(thread(threadId)?.state).toBe('needs_you');
    dispatch({
      type: 'provider.events',
      threadId,
      events: [{ type: 'turnFailed', threadId, error: 'Invented failure' }],
    });
    await cardBecomes((current) => current.state === 'failed');
  });
  it('does not fire while paused and treats what came due as missed on resume', () => {
    createCard();
    dispatch({ type: 'setting.set', key: 'scheduler.paused', scope: 'global', value: true });
    now = at(90);
    server.scheduler.tick();
    expect(allThreads()).toEqual([]);
    expect(trigger()?.state).toBe('scheduled');

    dispatch({ type: 'setting.set', key: 'scheduler.paused', scope: 'global', value: false });
    expect(trigger()).toMatchObject({ state: 'missed', offerRunNow: true });
    expect(card().state).toBe('missed');
  });

  it('fails the card when its workflow file is gone', () => {
    createCard({ workflowName: 'Gone' });
    now = at(60);
    server.scheduler.tick();
    expect(allThreads()).toEqual([]);
    expect(trigger()).toMatchObject({ state: 'fired', runId: null });
    expect(card().state).toBe('failed');
    expect(notices()).toEqual([['failed', 'Trigger failed']]);
  });

  it('starts a card stored before workflows were files by its stored workflow’s name', async () => {
    dispatch({
      type: 'workflow.create',
      workflowId: 'wf1',
      name: 'Bug',
      steps: [
        {
          id: 's1',
          skillName: 'deliver-work',
          providerInstanceId: 'claude-work',
          gateBefore: false,
          gateAfter: false,
          expectedArtifacts: [],
        },
      ],
    });
    createCard({ workflowName: undefined, workflowId: 'wf1' });
    now = at(60);
    server.scheduler.tick();
    expect(allThreads()).toHaveLength(1);
    expect(runs()).toEqual([]);
    await cardBecomes((current) => current.state === 'done');
  });

  it('sends no notifications when they are off', async () => {
    dispatch({
      type: 'setting.set',
      key: 'scheduler.notifications',
      scope: 'global',
      value: false,
    });
    createCard();
    now = at(60);
    server.scheduler.tick();
    await cardBecomes((current) => current.state === 'done');
    expect(notices()).toEqual([]);
  });
});

const runs = () => db().select().from(workflowRuns).all();

const policy = (value: MissedTriggerPolicy) =>
  dispatch({ type: 'setting.set', key: 'scheduler.missedPolicy', scope: 'global', value });

describe('missed triggers at startup (behavior 12)', () => {
  it('run: starts the thread at once', async () => {
    policy('run');
    createCard();
    await restart(600);
    const [started] = allThreads();
    expect(started?.title).toBe('Fix the login bug');
    expect(trigger()).toMatchObject({ state: 'fired', runId: started?.id });
    expect(card()).toMatchObject({ threadId: started?.id });
  });

  it('mark: marks the card missed and offers Run now', async () => {
    policy('mark');
    createCard();
    await restart(600);
    expect(allThreads()).toEqual([]);
    expect(trigger()).toMatchObject({ state: 'missed', offerRunNow: true });
    expect(card().state).toBe('missed');

    dispatch({ type: 'card.runNow', cardId: 'c1', runId: 'now' });
    expect(card()).toMatchObject({ state: 'running', threadId: 'now' });
    expect(thread('now')).toMatchObject({ title: 'Fix the login bug' });
    expect(trigger()).toMatchObject({ state: 'fired', runId: 'now', offerRunNow: false });
    await cardBecomes((current) => current.state === 'done');
  });

  it('skip: marks the card missed and does nothing', async () => {
    policy('skip');
    createCard();
    await restart(600);
    expect(allThreads()).toEqual([]);
    expect(trigger()).toMatchObject({ state: 'missed', offerRunNow: false });
    expect(card().state).toBe('missed');
  });

  it('leaves triggers that are still ahead alone', async () => {
    policy('run');
    createCard({ start: iso(3600), end: iso(5400) });
    await restart(600);
    expect(trigger()?.state).toBe('scheduled');
    expect(allThreads()).toEqual([]);
  });
});

describe('deleting a card that started a thread', () => {
  it('deletes the card and leaves its thread', async () => {
    createCard({ body: 'Keep working' });
    now = at(60);
    server.scheduler.tick();
    const threadId = card().threadId ?? '';
    dispatch({ type: 'card.delete', cardId: 'c1' });
    expect(card()).toBeUndefined();
    expect(thread(threadId)).toBeDefined();
    dispatch({ type: 'thread.interrupt', threadId });
  });
});
