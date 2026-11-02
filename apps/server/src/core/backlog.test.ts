import type { BacklogItem, CalendarItem, ServerCommand, WorkflowRun } from '@wow/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../db/database.js';
import { providerInstances } from '../db/schema.js';
import { Engine } from './engine.js';
import { CommandRejected } from './orchestrator.js';
import { snapshot } from './subscriptions.js';

// Behaviors 28 and 29 on the server: items stay local, "Plan on calendar" makes a card and plans
// the item, and the item follows the run started for it.

let database: Database;
let engine: Engine;
let ids = 0;

const run = (command: ServerCommand) => engine.dispatch(`c${++ids}`, command);
const rejection = (command: ServerCommand) => {
  try {
    run(command);
  } catch (error) {
    if (error instanceof CommandRejected) return error.code;
    throw error;
  }
  return undefined;
};
const items = () => snapshot(database.db, { topic: 'backlogItems' }) as BacklogItem[];
const cards = () => snapshot(database.db, { topic: 'calendarItems' }) as CalendarItem[];
const runs = () => snapshot(database.db, { topic: 'workflowRuns' }) as WorkflowRun[];
const item = () => items()[0];

const plan: ServerCommand = {
  type: 'backlog.plan',
  backlogItemId: 'b1',
  cardId: 'card-1',
  workflowId: 'w1',
  projectId: 'p1',
  start: '2026-11-03T09:00:00.000Z',
  end: '2026-11-03T10:00:00.000Z',
  zone: 'Europe/Stockholm',
};

beforeEach(() => {
  database = openDatabase(':memory:');
  engine = new Engine(database.db, { clock: () => new Date('2026-11-02T08:00:00.000Z') });
  database.db
    .insert(providerInstances)
    .values({
      id: 'claude-work',
      kind: 'claude',
      name: 'Claude',
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
    })
    .run();
  run({ type: 'project.create', projectId: 'p1', name: 'wow', cwd: '/work/wow' });
  run({
    type: 'workflow.create',
    workflowId: 'w1',
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
  run({
    type: 'backlog.create',
    backlogItemId: 'b1',
    title: 'Fix the login',
    body: 'The **login** fails on Mondays.',
    tags: [' auth ', 'bug', 'auth'],
  });
});

afterEach(() => database.close());

describe('backlog items', () => {
  it('stores a new item as an idea with trimmed unique tags', () => {
    expect(items()).toEqual([
      {
        id: 'b1',
        title: 'Fix the login',
        body: 'The **login** fails on Mondays.',
        tags: ['auth', 'bug'],
        state: 'idea',
        runId: null,
        remote: null,
        createdAt: '2026-11-02T08:00:00.000Z',
      },
    ]);
    expect(
      rejection({ type: 'backlog.create', backlogItemId: 'b1', title: 'x', body: '', tags: [] }),
    ).toBe('conflict');
    expect(rejection({ type: 'backlog.update', backlogItemId: 'nope', title: 'x' })).toBe(
      'not_found',
    );
  });

  it('edits title, body, tags and state, and records nothing when nothing changed', () => {
    run({ type: 'backlog.update', backlogItemId: 'b1', body: 'New body', state: 'dropped' });
    expect(item()).toMatchObject({ title: 'Fix the login', body: 'New body', state: 'dropped' });
    expect(
      run({ type: 'backlog.update', backlogItemId: 'b1', tags: ['auth', 'bug'] }).seqs,
    ).toEqual([]);
  });

  it('plans an item on the calendar as a card with the workflow, project and time', () => {
    run(plan);
    expect(item()?.state).toBe('planned');
    expect(cards()).toEqual([
      expect.objectContaining({
        id: 'card-1',
        source: 'local',
        title: 'Fix the login',
        backlogItemId: 'b1',
        workflowId: 'w1',
        projectId: 'p1',
        start: '2026-11-03T09:00:00.000Z',
        state: 'scheduled',
      }),
    ]);
  });

  it('refuses a plan the calendar would refuse, and changes nothing', () => {
    expect(rejection({ ...plan, workflowId: 'missing' })).toBe('not_found');
    expect(rejection({ ...plan, projectId: 'missing' })).toBe('not_found');
    expect(rejection({ ...plan, end: plan.start })).toBe('rejected');
    expect(item()?.state).toBe('idea');
    expect(cards()).toEqual([]);
  });

  it('deletes an item and unlinks its cards', () => {
    run(plan);
    run({ type: 'backlog.delete', backlogItemId: 'b1' });
    expect(items()).toEqual([]);
    expect(cards()[0]).toMatchObject({ id: 'card-1', backlogItemId: null, workflowId: 'w1' });
  });

  it('restores a deleted item as it was (Undo)', () => {
    const before = item();
    if (!before) throw new Error('no item');
    run({ type: 'backlog.delete', backlogItemId: 'b1' });
    run({ type: 'backlog.restore', item: before });
    expect(items()).toEqual([before]);
    expect(rejection({ type: 'backlog.restore', item: before })).toBe('conflict');
  });

  it('stores the published issue once', () => {
    const remote = { service: 'jira', key: 'WOW-7', url: 'https://acme.example/browse/WOW-7' };
    run({ type: 'backlog.published', backlogItemId: 'b1', remote } as ServerCommand);
    expect(item()?.remote).toEqual(remote);
    expect(
      rejection({
        type: 'backlog.published',
        backlogItemId: 'b1',
        remote: { ...remote, key: 'WOW-8' },
      } as ServerCommand),
    ).toBe('conflict');
    expect(item()?.remote?.key).toBe('WOW-7');
  });
});

describe('an item follows its run', () => {
  const start: ServerCommand = {
    type: 'workflowRun.start',
    runId: 'r1',
    workflowId: 'w1',
    projectId: 'p1',
    calendarItemId: 'card-1',
    backlogItemId: 'b1',
  };

  it('is running while the run is live and done when it finished', () => {
    run(plan);
    run(start);
    expect(item()).toMatchObject({ state: 'running', runId: 'r1' });
    expect(rejection({ type: 'backlog.delete', backlogItemId: 'b1' })).toBe('conflict');
    expect(rejection({ ...plan, cardId: 'card-2' })).toBe('conflict');
    run({
      type: 'workflowRun.stepCompleted',
      runId: 'r1',
      stepId: 's1',
      finalMessage: 'Fixed.',
      artifactsFound: [],
    });
    expect(runs()[0]?.state).toBe('done');
    expect(item()).toMatchObject({ state: 'done', runId: 'r1' });
  });

  it('goes back to planned with the failed run kept when the run fails', () => {
    run(plan);
    run(start);
    run({ type: 'workflowRun.stepFailed', runId: 'r1', stepId: 's1', error: 'Tests failed' });
    expect(runs()[0]).toMatchObject({ state: 'failed' });
    expect(item()).toMatchObject({ state: 'planned', runId: 'r1' });
  });

  it('goes back to planned when the run is stopped', () => {
    run(plan);
    run(start);
    run({ type: 'workflowRun.stop', runId: 'r1' });
    expect(item()).toMatchObject({ state: 'planned', runId: 'r1' });
  });
});
