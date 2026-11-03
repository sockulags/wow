import type {
  CalendarItem,
  MissedTriggerPolicy,
  ProviderInstance,
  ServerCommand,
  Thread,
  Trigger,
  WorkflowRun,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { eq } from 'drizzle-orm';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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

// U11 ground truth: the scheduler's tick and missed policy with a clock the test moves. Nothing
// sleeps: the tick runs when the test calls it, and waits resolve on the commit that matches.

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
const runs = (): WorkflowRun[] => db().select().from(workflowRuns).all();
const thread = (id: string): Thread | undefined =>
  db().select().from(threads).where(eq(threads.id, id)).get();
const notices = () =>
  db()
    .select()
    .from(notifications)
    .all()
    .map((row) => [row.kind, row.title]);

// Resolves on the commit after which the run matches.
function runBecomes(predicate: (run: WorkflowRun) => boolean): Promise<WorkflowRun> {
  return new Promise((resolve) => {
    const check = () => {
      const found = runs().find(predicate);
      if (found) {
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
      providers: { claude: (row) => new MockProviderAdapter(row.kind) },
    },
  });
}

// A server stopped while time passes, then started again.
async function restart(secondsLater: number): Promise<void> {
  await server.workflows.settled();
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
    workflowId: 'wf1',
    ...overrides,
  });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-scheduler-'));
  projectDir = path.join(root, 'project');
  await mkdir(projectDir, { recursive: true });
  now = start;
  ticks = [];
  server = await launch();
  db().insert(providerInstances).values(instance).run();
  dispatch({ type: 'project.create', projectId: 'p1', name: 'wow', cwd: projectDir });
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
        gateAfter: true,
        expectedArtifacts: [],
      },
      {
        id: 's2',
        skillName: 'check-work',
        providerInstanceId: 'claude-work',
        gateBefore: false,
        gateAfter: false,
        expectedArtifacts: [],
      },
    ],
  });
});

afterEach(async () => {
  await server.workflows.settled();
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('triggers follow their card', () => {
  it('schedules a trigger for a card with a workflow and moves it with the card (behavior 6)', () => {
    createCard();
    expect(trigger()).toMatchObject({
      calendarItemId: 'c1',
      workflowId: 'wf1',
      runAt: iso(60),
      zone: 'Europe/Stockholm',
      state: 'scheduled',
      runId: null,
      offerRunNow: false,
    });
    expect(card().state).toBe('scheduled');

    dispatch({ type: 'card.update', cardId: 'c1', start: iso(3600), end: iso(5400) });
    expect(trigger()).toMatchObject({ runAt: iso(3600), state: 'scheduled' });

    dispatch({ type: 'card.update', cardId: 'c1', workflowId: null });
    expect(trigger()?.state).toBe('cancelled');
    dispatch({ type: 'card.update', cardId: 'c1', workflowId: 'wf1' });
    expect(trigger()?.state).toBe('scheduled');
  });

  it('needs a project and a workflow', () => {
    createCard({ projectId: undefined });
    expect(trigger()).toBeUndefined();
    dispatch({ type: 'card.update', cardId: 'c1', projectId: 'p1' });
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

  it('fires a due trigger into a run that waits at the gate (behaviors 8 and 9)', async () => {
    createCard();
    now = at(59);
    server.scheduler.tick();
    expect(runs()).toEqual([]);

    now = at(60);
    server.scheduler.tick();
    const [run] = runs();
    expect(run).toMatchObject({ workflowId: 'wf1', projectId: 'p1', calendarItemId: 'c1' });
    const runId = run?.id ?? '';
    expect(trigger()).toMatchObject({ state: 'fired', runId });
    expect(card()).toMatchObject({ state: 'running', runId });
    expect(thread(`${runId}.s1`)).toMatchObject({
      projectId: 'p1',
      cwd: projectDir,
      providerInstanceId: 'claude-work',
      model: 'opus',
      effort: 'high',
    });

    await runBecomes((current) => current.state === 'waiting');
    expect(card().state).toBe('waiting');
    expect(thread(`${runId}.s1`)?.state).toBe('needs_you');
    expect(notices()).toEqual([
      ['started', 'Workflow run started'],
      ['waiting', 'Waiting for you'],
    ]);

    // A later tick does not fire the trigger again.
    now = at(120);
    server.scheduler.tick();
    expect(runs()).toHaveLength(1);

    dispatch({ type: 'workflowRun.continue', runId });
    await runBecomes((current) => current.state === 'done');
    expect(card().state).toBe('done');
  });

  it('does not fire while paused and treats what came due as missed on resume', () => {
    createCard();
    dispatch({ type: 'setting.set', key: 'scheduler.paused', scope: 'global', value: true });
    now = at(90);
    server.scheduler.tick();
    expect(runs()).toEqual([]);
    expect(trigger()?.state).toBe('scheduled');

    dispatch({ type: 'setting.set', key: 'scheduler.paused', scope: 'global', value: false });
    expect(trigger()).toMatchObject({ state: 'missed', offerRunNow: true });
    expect(card().state).toBe('missed');
  });

  it('fails the card when its run cannot start', () => {
    createCard();
    dispatch({ type: 'workflow.delete', workflowId: 'wf1' });
    now = at(60);
    server.scheduler.tick();
    expect(runs()).toEqual([]);
    expect(trigger()).toMatchObject({ state: 'fired', runId: null });
    expect(card().state).toBe('failed');
    expect(notices()).toEqual([['failed', 'Trigger failed']]);
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
    await runBecomes((current) => current.state === 'waiting');
    expect(notices()).toEqual([]);
  });
});

const policy = (value: MissedTriggerPolicy) =>
  dispatch({ type: 'setting.set', key: 'scheduler.missedPolicy', scope: 'global', value });

describe('missed triggers at startup (behavior 12)', () => {
  it('run: starts the run at once', async () => {
    policy('run');
    createCard();
    await restart(600);
    const [run] = runs();
    expect(run?.calendarItemId).toBe('c1');
    expect(trigger()).toMatchObject({ state: 'fired', runId: run?.id });
    expect(card().state).toBe('running');
  });

  it('mark: marks the card missed and offers Run now', async () => {
    policy('mark');
    createCard();
    await restart(600);
    expect(runs()).toEqual([]);
    expect(trigger()).toMatchObject({ state: 'missed', offerRunNow: true });
    expect(card().state).toBe('missed');

    dispatch({ type: 'card.runNow', cardId: 'c1', runId: 'now' });
    expect(card()).toMatchObject({ state: 'running', runId: 'now' });
    expect(trigger()).toMatchObject({ state: 'fired', runId: 'now', offerRunNow: false });
    await runBecomes((current) => current.state === 'waiting');
    expect(card().state).toBe('waiting');
  });

  it('skip: marks the card missed and does nothing', async () => {
    policy('skip');
    createCard();
    await restart(600);
    expect(runs()).toEqual([]);
    expect(trigger()).toMatchObject({ state: 'missed', offerRunNow: false });
    expect(card().state).toBe('missed');
  });

  it('leaves triggers that are still ahead alone', async () => {
    policy('run');
    createCard({ start: iso(3600), end: iso(5400) });
    await restart(600);
    expect(trigger()?.state).toBe('scheduled');
    expect(runs()).toEqual([]);
  });
});

describe('deleting a card with a live run (behavior 13)', () => {
  beforeEach(async () => {
    createCard();
    now = at(60);
    server.scheduler.tick();
    await runBecomes((current) => current.state === 'waiting');
  });

  it('asks first', () => {
    expect(() => dispatch({ type: 'card.delete', cardId: 'c1' })).toThrow(/say whether to stop/);
    expect(card()).toBeDefined();
  });

  it('stops the run and keeps its threads', () => {
    const [run] = runs();
    dispatch({ type: 'card.delete', cardId: 'c1', stopRun: true });
    expect(card()).toBeUndefined();
    expect(runs()[0]?.state).toBe('stopped');
    expect(thread(`${run?.id ?? ''}.s1`)).toBeDefined();
  });

  it('or leaves the run going', () => {
    dispatch({ type: 'card.delete', cardId: 'c1', stopRun: false });
    expect(card()).toBeUndefined();
    expect(runs()[0]?.state).toBe('waiting');
  });

  it('refuses Run now while the run is live', () => {
    expect(() => dispatch({ type: 'card.runNow', cardId: 'c1', runId: 'again' })).toThrow(
      /already has a run/,
    );
  });
});
