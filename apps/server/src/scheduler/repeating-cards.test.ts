import type {
  CalendarItem,
  CardOccurrence,
  MissedTriggerPolicy,
  ProviderInstance,
  RepeatRule,
  ServerCommand,
  Trigger,
  WorkflowRun,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { eq } from 'drizzle-orm';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCalendarRange } from '../core/series.js';
import { snapshot } from '../core/subscriptions.js';
import {
  calendarItems,
  notifications,
  providerInstances,
  triggers,
  workflowRuns,
} from '../db/schema.js';
import { MockProviderAdapter } from '../hooks/index.js';
import { startServer, type RunningServer } from '../server.js';
import type { SchedulerTimers } from './service.js';

// Recurring cards U1 ground truth: a repeating card on the server, with a clock the test moves.
// Nothing sleeps: the tick runs when the test calls it, and waits resolve on the commit that
// matches. The card falls on weekdays at 08:30 in Stockholm (07:30 UTC in November), from
// Wednesday 4 November 2026.

let root: string;
let projectDir: string;
let server: RunningServer;
let now: Date;

const timers: SchedulerTimers = { setTimeout: () => undefined, clearTimeout: () => undefined };

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

// 08:30 in Stockholm on a November day, and a moment `minutes` after it.
const at = (date: string, minutes = 0) =>
  new Date(Date.parse(`${date}T07:30:00.000Z`) + minutes * 60_000).toISOString();
const weekdays: RepeatRule = {
  frequency: 'weekly',
  interval: 1,
  weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  end: { kind: 'never' },
};

let commandCount = 0;
const dispatch = (command: ServerCommand) =>
  server.engine.dispatch(`test-${(commandCount += 1)}`, command);

const db = () => server.database.db;
const card = (id = 'c1') =>
  db().select().from(calendarItems).where(eq(calendarItems.id, id)).get() as
    CalendarItem | undefined;
const shown = (id = 'c1') =>
  (snapshot(db(), { topic: 'calendarItems' }) as CalendarItem[]).find((item) => item.id === id);
const records = (id = 'c1'): CardOccurrence[] => shown(id)?.occurrences ?? [];
const trigger = (cardId = 'c1') =>
  db()
    .select()
    .from(triggers)
    .where(eq(triggers.id, `${cardId}:trigger`))
    .get() as Trigger | undefined;
const runs = (): WorkflowRun[] => db().select().from(workflowRuns).all();
const notices = () =>
  db()
    .select()
    .from(notifications)
    .all()
    .map((row) => [row.kind, row.title]);
const range = (from: string, to: string, limit = 200) =>
  readCalendarRange(db(), { from, to }, limit);

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
    hooks: { providers: { claude: (row) => new MockProviderAdapter(row.kind) } },
  });
}

async function restart(later: string): Promise<void> {
  await server.workflows.settled();
  await server.stop();
  now = new Date(later);
  server = await launch();
}

// Moves the clock to `instant` and lets the scheduler look.
function tickAt(instant: string): void {
  now = new Date(instant);
  server.scheduler.tick();
}

const step = (id: string, gateAfter: boolean) => ({
  id,
  skillName: 'deliver-work',
  providerInstanceId: 'claude-work',
  gateBefore: false,
  gateAfter,
  expectedArtifacts: [],
});

const createCard = (overrides: Partial<Extract<ServerCommand, { type: 'card.create' }>> = {}) =>
  dispatch({
    type: 'card.create',
    cardId: 'c1',
    title: 'Morning review',
    start: at('2026-11-04'),
    end: at('2026-11-04', 30),
    zone: 'Europe/Stockholm',
    projectId: 'p1',
    workflowId: 'quick',
    repeat: weekdays,
    ...overrides,
  });

const policy = (value: MissedTriggerPolicy) =>
  dispatch({ type: 'setting.set', key: 'scheduler.missedPolicy', scope: 'global', value });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-repeat-'));
  projectDir = path.join(root, 'project');
  await mkdir(projectDir, { recursive: true });
  now = new Date('2026-11-04T07:00:00.000Z');
  server = await launch();
  db().insert(providerInstances).values(instance).run();
  dispatch({ type: 'project.create', projectId: 'p1', name: 'wow', cwd: projectDir });
  // Ends by itself: one step, no gate.
  dispatch({
    type: 'workflow.create',
    workflowId: 'quick',
    name: 'Review',
    steps: [step('s1', false)],
  });
  // Waits at its gate, so its run stays live.
  dispatch({
    type: 'workflow.create',
    workflowId: 'gated',
    name: 'Gated',
    steps: [step('s1', true)],
  });
});

afterEach(async () => {
  await server.workflows.settled();
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('occurrences of a repeating card (spec 1, 2)', () => {
  it('reads every weekday at 08:30 in the week and the next week', () => {
    createCard();
    const found = range('2026-11-02T00:00:00.000Z', '2026-11-16T00:00:00.000Z').occurrences;
    expect(found.map((occurrence) => occurrence.date)).toEqual([
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
      '2026-11-12',
      '2026-11-13',
    ]);
    expect(found.every((occurrence) => occurrence.repeating && occurrence.cardId === 'c1')).toBe(
      true,
    );
    expect(found.map((occurrence) => occurrence.start)).toContain(at('2026-11-09'));
    expect(found[0]).toMatchObject({ next: true, record: null });
  });

  it('stores the rule on the card and the next fire time', () => {
    createCard();
    expect(shown()).toMatchObject({
      repeat: weekdays,
      skippedDates: [],
      nextAt: at('2026-11-04'),
      occurrences: [],
    });
    expect(trigger()).toMatchObject({ state: 'scheduled', runAt: at('2026-11-04') });
  });

  it('takes a rule at the longest interval and refuses one past it', () => {
    const longest: RepeatRule = { ...weekdays, frequency: 'daily', weekdays: [], interval: 1000 };
    createCard({ repeat: longest });
    expect(range('2026-11-01T00:00:00.000Z', '2032-01-01T00:00:00.000Z').occurrences).toHaveLength(
      2,
    );
    expect(() => createCard({ cardId: 'c2', repeat: { ...longest, interval: 1001 } })).toThrow(
      /1000/,
    );
    expect(card('c2')).toBeUndefined();
  });

  it('refuses a zone the platform does not know, with or without a rule', () => {
    expect(() => createCard({ repeat: undefined, zone: 'Mars/Phobos' })).toThrow(/not a time zone/);
    createCard({ repeat: undefined });
    expect(() => dispatch({ type: 'card.update', cardId: 'c1', zone: 'Mars/Phobos' })).toThrow(
      /not a time zone/,
    );
  });

  it('reads a range when a stored card has a zone the platform does not know', () => {
    createCard();
    createCard({ cardId: 'c2', repeat: undefined });
    db().update(calendarItems).set({ zone: 'Mars/Phobos' }).where(eq(calendarItems.id, 'c2')).run();
    const found = range('2026-11-04T00:00:00.000Z', '2026-11-05T00:00:00.000Z').occurrences;
    expect(found.map((occurrence) => [occurrence.cardId, occurrence.date])).toEqual([
      ['c1', '2026-11-04'],
      ['c2', '2026-11-04'],
    ]);
  });

  it('refuses a rule that ends before the first occurrence', () => {
    expect(() =>
      createCard({ repeat: { ...weekdays, end: { kind: 'on', date: '2026-11-03' } } }),
    ).toThrow(/before the card's first day/);
  });
});

describe('a card without a rule (spec 4)', () => {
  it('loads and fires once as before', async () => {
    createCard({ repeat: undefined });
    expect(shown()).toMatchObject({ repeat: null, skippedDates: [], nextAt: at('2026-11-04') });
    tickAt(at('2026-11-04'));
    const run = await runBecomes((current) => current.state === 'done');
    expect(run.occurrence ?? null).toBeNull();
    expect(trigger()).toMatchObject({ state: 'fired', runId: run.id });
    expect(card()?.nextAt).toBeNull();
    tickAt(at('2026-11-05'));
    expect(runs()).toHaveLength(1);
  });
});

describe('firing (spec 5, 6, 9)', () => {
  it('starts a run named with each occurrence date, then waits for the next, until the last', async () => {
    createCard({ repeat: { ...weekdays, end: { kind: 'after', count: 3 } } });
    expect(trigger()?.runAt).toBe(at('2026-11-04'));

    tickAt(at('2026-11-04', -1));
    expect(runs()).toEqual([]);

    for (const [date, next] of [
      ['2026-11-04', '2026-11-05'],
      ['2026-11-05', '2026-11-06'],
    ] as const) {
      tickAt(at(date));
      const run = await runBecomes(
        (current) => current.occurrence?.date === date && current.state === 'done',
      );
      expect(run.occurrence).toEqual({ date, start: at(date) });
      expect(trigger()).toMatchObject({ state: 'scheduled', runAt: at(next), runId: run.id });
      expect(card()?.nextAt).toBe(at(next));
    }

    tickAt(at('2026-11-06'));
    const last = await runBecomes(
      (current) => current.occurrence?.date === '2026-11-06' && current.state === 'done',
    );
    expect(trigger()).toMatchObject({ state: 'fired', runId: last.id });
    expect(card()?.nextAt).toBeNull();
    expect(records().map((record) => [record.date, record.outcome])).toEqual([
      ['2026-11-04', 'fired'],
      ['2026-11-05', 'fired'],
      ['2026-11-06', 'fired'],
    ]);
    expect(notices().filter(([kind]) => kind === 'started')).toHaveLength(3);

    tickAt(at('2026-11-09'));
    tickAt(at('2026-11-10'));
    expect(runs()).toHaveLength(3);
  });

  it('shows how past occurrences went in a range read', async () => {
    createCard();
    tickAt(at('2026-11-04'));
    const run = await runBecomes((current) => current.state === 'done');
    now = new Date(at('2026-11-04', 60));
    const [first, second] = range(at('2026-11-04', -60), at('2026-11-05', 60)).occurrences;
    expect(first).toMatchObject({
      date: '2026-11-04',
      next: false,
      record: { outcome: 'fired', runId: run.id },
    });
    expect(second).toMatchObject({ date: '2026-11-05', next: true, record: null });
  });
});

describe('a busy card (spec 7)', () => {
  it('starts nothing while the run of an earlier occurrence is still going', async () => {
    createCard({ workflowId: 'gated' });
    tickAt(at('2026-11-04'));
    const first = await runBecomes((current) => current.state === 'waiting');

    tickAt(at('2026-11-05'));
    expect(runs()).toHaveLength(1);
    expect(records().at(-1)).toMatchObject({
      date: '2026-11-05',
      outcome: 'skipped',
      runId: null,
      reason: expect.stringMatching(/2026-11-04.*waiting for you/) as unknown,
    });
    expect(notices()).toContainEqual(['failed', 'Occurrence skipped']);
    expect(trigger()).toMatchObject({ state: 'scheduled', runAt: at('2026-11-06') });

    dispatch({ type: 'workflowRun.stop', runId: first.id });
    tickAt(at('2026-11-06'));
    const third = await runBecomes((current) => current.occurrence?.date === '2026-11-06');
    expect(third.id).not.toBe(first.id);
  });
});

// The server is stopped from before the first occurrence until Friday at 09:30: Wednesday,
// Thursday and Friday passed. The latest of those is Friday.
const away = async () => {
  createCard({ start: at('2026-11-04'), end: at('2026-11-04', 30) });
  await restart(at('2026-11-06', 60));
};

describe('three missed occurrences (spec 8)', () => {
  it('run: only the latest starts and the older two are missed', async () => {
    policy('run');
    await away();
    const [run] = runs();
    expect(runs()).toHaveLength(1);
    expect(run?.occurrence?.date).toBe('2026-11-06');
    expect(records().map((record) => [record.date, record.outcome])).toEqual([
      ['2026-11-04', 'missed'],
      ['2026-11-05', 'missed'],
      ['2026-11-06', 'fired'],
    ]);
    expect(trigger()).toMatchObject({ state: 'scheduled', runAt: at('2026-11-09') });
  });

  it('mark: only the latest is offered Run now', async () => {
    policy('mark');
    await away();
    expect(runs()).toEqual([]);
    expect(records().map((record) => [record.date, record.outcome, record.offerRunNow])).toEqual([
      ['2026-11-04', 'missed', false],
      ['2026-11-05', 'missed', false],
      ['2026-11-06', 'missed', true],
    ]);
    expect(card()?.state).toBe('missed');
    expect(trigger()).toMatchObject({ state: 'scheduled', runAt: at('2026-11-09') });

    dispatch({ type: 'card.runNow', cardId: 'c1', runId: 'now' });
    const run = await runBecomes((current) => current.id === 'now');
    expect(run.occurrence?.date).toBe('2026-11-06');
    expect(records().at(-1)).toMatchObject({ outcome: 'fired', runId: 'now', offerRunNow: false });
    expect(trigger()).toMatchObject({ state: 'scheduled', runAt: at('2026-11-09') });
  });

  it('mark: a later outage withdraws the earlier offer', async () => {
    policy('mark');
    createCard();
    await restart(at('2026-11-04', 60));
    await restart(at('2026-11-06', 60));
    expect(records().map((record) => [record.date, record.outcome, record.offerRunNow])).toEqual([
      ['2026-11-04', 'missed', false],
      ['2026-11-05', 'missed', false],
      ['2026-11-06', 'missed', true],
    ]);
    dispatch({ type: 'card.runNow', cardId: 'c1', runId: 'now' });
    await runBecomes((current) => current.id === 'now' && current.state === 'done');
    expect(records().some((record) => record.offerRunNow)).toBe(false);
  });

  it('skip: none starts', async () => {
    policy('skip');
    await away();
    expect(runs()).toEqual([]);
    expect(records().map((record) => [record.outcome, record.offerRunNow])).toEqual([
      ['missed', false],
      ['missed', false],
      ['missed', false],
    ]);
    expect(trigger()).toMatchObject({ state: 'scheduled', runAt: at('2026-11-09') });
  });

  it('applies the same while paused', () => {
    policy('run');
    createCard();
    dispatch({ type: 'setting.set', key: 'scheduler.paused', scope: 'global', value: true });
    tickAt(at('2026-11-06', 60));
    expect(runs()).toEqual([]);
    dispatch({ type: 'setting.set', key: 'scheduler.paused', scope: 'global', value: false });
    expect(runs().map((run) => run.occurrence?.date)).toEqual(['2026-11-06']);
    expect(records().map((record) => record.outcome)).toEqual(['missed', 'missed', 'fired']);
  });

  it('records occurrences a late tick passed over as missed and runs the latest', async () => {
    createCard();
    tickAt(at('2026-11-05', 5));
    await runBecomes((current) => current.state === 'done');
    expect(runs().map((run) => run.occurrence?.date)).toEqual(['2026-11-05']);
    expect(records().map((record) => [record.date, record.outcome])).toEqual([
      ['2026-11-04', 'missed'],
      ['2026-11-05', 'fired'],
    ]);
  });
});

describe('changing a series (spec 10, 11, 12, 14)', () => {
  it('moves occurrences that have not started and keeps the ones that ran', async () => {
    createCard();
    tickAt(at('2026-11-04'));
    const first = await runBecomes((current) => current.state === 'done');

    // 09:30 instead of 08:30, from the series' first day.
    dispatch({
      type: 'card.update',
      cardId: 'c1',
      start: at('2026-11-04', 60),
      end: at('2026-11-04', 90),
    });
    expect(trigger()).toMatchObject({ state: 'scheduled', runAt: at('2026-11-05', 60) });
    const found = range(at('2026-11-04', -60), at('2026-11-06', 120)).occurrences;
    expect(found.map((occurrence) => [occurrence.date, occurrence.start])).toEqual([
      ['2026-11-04', at('2026-11-04')],
      ['2026-11-05', at('2026-11-05', 60)],
      ['2026-11-06', at('2026-11-06', 60)],
    ]);
    expect(found[0]?.record).toMatchObject({ outcome: 'fired', runId: first.id });
  });

  it('follows a changed rule and a changed workflow', async () => {
    createCard();
    dispatch({
      type: 'card.update',
      cardId: 'c1',
      repeat: { ...weekdays, weekdays: ['mon'] },
      workflowId: 'gated',
    });
    // The start (Wednesday) is still the first occurrence; then Mondays.
    expect(
      range(at('2026-11-04', -60), at('2026-11-17')).occurrences.map(
        (occurrence) => occurrence.date,
      ),
    ).toEqual(['2026-11-04', '2026-11-09', '2026-11-16']);
    tickAt(at('2026-11-04'));
    const run = await runBecomes((current) => current.state === 'waiting');
    expect(run.workflowId).toBe('gated');
    expect(trigger()?.runAt).toBe(at('2026-11-09'));
  });

  it('skips one occurrence and fires the rest', async () => {
    createCard();
    dispatch({ type: 'card.skipOccurrence', cardId: 'c1', date: '2026-11-04' });
    expect(card()?.skippedDates).toEqual(['2026-11-04']);
    expect(trigger()?.runAt).toBe(at('2026-11-05'));
    expect(
      range(at('2026-11-04', -60), at('2026-11-06')).occurrences.map(
        (occurrence) => occurrence.date,
      ),
    ).toEqual(['2026-11-05']);
    tickAt(at('2026-11-04'));
    expect(runs()).toEqual([]);
    tickAt(at('2026-11-05'));
    const run = await runBecomes((current) => current.state === 'done');
    expect(run.occurrence?.date).toBe('2026-11-05');

    expect(() =>
      dispatch({ type: 'card.skipOccurrence', cardId: 'c1', date: '2026-11-07' }),
    ).toThrow(/no occurrence on 2026-11-07/);
    expect(() =>
      dispatch({ type: 'card.skipOccurrence', cardId: 'c1', date: '2026-11-05' }),
    ).toThrow(/already started/);
  });

  it('moves the series when one occurrence is moved within its day, as an edit does', () => {
    createCard();
    dispatch({
      type: 'card.moveOccurrence',
      cardId: 'c1',
      date: '2026-11-10',
      start: at('2026-11-10', 90),
      end: at('2026-11-10', 150),
    });
    expect(card()).toMatchObject({ start: at('2026-11-04', 90), end: at('2026-11-04', 150) });
    expect(trigger()?.runAt).toBe(at('2026-11-04', 90));
    expect(() =>
      dispatch({
        type: 'card.moveOccurrence',
        cardId: 'c1',
        date: '2026-11-10',
        start: at('2026-11-11'),
        end: at('2026-11-11', 30),
      }),
    ).toThrow(/within its day/);
  });

  it('needs stopRun to delete a series whose run is live', async () => {
    createCard({ workflowId: 'gated' });
    tickAt(at('2026-11-04'));
    const run = await runBecomes((current) => current.state === 'waiting');
    expect(() => dispatch({ type: 'card.delete', cardId: 'c1' })).toThrow(/say whether to stop/);
    dispatch({ type: 'card.delete', cardId: 'c1', stopRun: true });
    expect(card()).toBeUndefined();
    expect(runs().find((current) => current.id === run.id)?.state).toBe('stopped');
    expect(trigger()?.state).toBe('cancelled');
  });

  it('turns a single card that ran into a series and back', async () => {
    createCard({ repeat: undefined });
    tickAt(at('2026-11-04'));
    const run = await runBecomes((current) => current.state === 'done');
    expect(trigger()?.state).toBe('fired');

    dispatch({ type: 'card.update', cardId: 'c1', repeat: weekdays });
    expect(records()).toMatchObject([{ date: '2026-11-04', outcome: 'fired', runId: run.id }]);
    expect(trigger()).toMatchObject({ state: 'scheduled', runAt: at('2026-11-05') });

    dispatch({ type: 'card.update', cardId: 'c1', repeat: null });
    expect(trigger()).toMatchObject({ state: 'fired', runId: run.id, runAt: at('2026-11-04') });
    expect(card()?.nextAt).toBeNull();
    tickAt(at('2026-11-05'));
    expect(runs()).toHaveLength(1);
  });
});

describe('Undo of a deleted series (spec 13)', () => {
  it('brings the card back with its rule, skipped days, history and trigger', async () => {
    createCard();
    tickAt(at('2026-11-04'));
    await runBecomes((current) => current.state === 'done');
    dispatch({ type: 'card.skipOccurrence', cardId: 'c1', date: '2026-11-05' });
    const before = card();
    dispatch({ type: 'card.delete', cardId: 'c1' });
    expect(trigger()?.state).toBe('cancelled');

    // What the calendar's Undo sends: the card as the client held it.
    dispatch({
      type: 'card.create',
      cardId: 'c1',
      title: 'Morning review',
      start: at('2026-11-04'),
      end: at('2026-11-04', 30),
      zone: 'Europe/Stockholm',
      projectId: 'p1',
      workflowId: 'quick',
      repeat: before?.repeat ?? undefined,
      skippedDates: before?.skippedDates ?? [],
    });
    expect(shown()).toMatchObject({ repeat: weekdays, skippedDates: ['2026-11-05'] });
    expect(records().map((record) => record.date)).toEqual(['2026-11-04']);
    expect(trigger()).toMatchObject({ state: 'scheduled', runAt: at('2026-11-06') });
  });
});

describe('a range with many occurrences (spec 17)', () => {
  it('returns calendar.maxOccurrences of one card and says there are more', () => {
    createCard({
      repeat: { frequency: 'daily', interval: 1, weekdays: [], end: { kind: 'never' } },
    });
    dispatch({ type: 'setting.set', key: 'calendar.maxOccurrences', scope: 'global', value: 5 });
    const read = range(
      '2026-11-01T00:00:00.000Z',
      '2026-12-01T00:00:00.000Z',
      server.settings.get('calendar.maxOccurrences'),
    );
    expect(read.occurrences).toHaveLength(5);
    expect(read.more).toEqual(['c1']);
    const whole = range('2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', 200);
    expect(whole.occurrences).toHaveLength(27);
    expect(whole.more).toEqual([]);
  });
});
