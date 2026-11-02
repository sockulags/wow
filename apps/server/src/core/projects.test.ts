import type {
  CalendarItem,
  Project,
  ServerCommand,
  Thread,
  Trigger,
  WorkflowRun,
} from '@wow/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../db/database.js';
import { providerInstances } from '../db/schema.js';
import { Engine } from './engine.js';
import { CommandRejected } from './orchestrator.js';
import { snapshot } from './subscriptions.js';

// Projects on the server: names are unique, renames keep the id, and removing a project unlinks
// what referred to it instead of leaving dangling ids or deleting history.

let database: Database;
let engine: Engine;
let ids = 0;

const run = (command: ServerCommand) => engine.dispatch(`c${++ids}`, command);
const rejection = (command: ServerCommand) => {
  try {
    run(command);
  } catch (error) {
    if (error instanceof CommandRejected) return { code: error.code, message: error.message };
    throw error;
  }
  return undefined;
};
const projects = () => snapshot(database.db, { topic: 'projects' }) as Project[];
const cards = () => snapshot(database.db, { topic: 'calendarItems' }) as CalendarItem[];
const triggers = () => snapshot(database.db, { topic: 'triggers' }) as Trigger[];
const threads = () => snapshot(database.db, { topic: 'threads' }) as Thread[];
const runs = () => snapshot(database.db, { topic: 'workflowRuns' }) as WorkflowRun[];

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
        gateAfter: true,
        expectedArtifacts: [],
      },
    ],
  });
});

afterEach(() => database.close());

describe('projects', () => {
  it('refuses a second project with the same name, in any case', () => {
    expect(
      rejection({ type: 'project.create', projectId: 'p2', name: 'WOW', cwd: '/work/other' }),
    ).toEqual({ code: 'conflict', message: 'A project named wow already exists' });
    run({ type: 'project.create', projectId: 'p2', name: 'other', cwd: '/work/other' });
    expect(rejection({ type: 'project.update', projectId: 'p2', name: 'Wow' })?.code).toBe(
      'conflict',
    );
    expect(projects().map((project) => project.name)).toEqual(['other', 'wow']);
  });

  it('renames a project and keeps its id and folder', () => {
    run({ type: 'project.update', projectId: 'p1', name: 'wow app' });
    expect(projects()).toEqual([
      expect.objectContaining({ id: 'p1', name: 'wow app', cwd: '/work/wow' }),
    ]);
    // Changing only the case of its own name is a rename, not a clash.
    run({ type: 'project.update', projectId: 'p1', name: 'Wow App' });
    expect(projects()[0]?.name).toBe('Wow App');
  });

  it('removes a project: threads keep their folder, cards lose the project and the trigger', () => {
    run({
      type: 'thread.create',
      threadId: 't1',
      providerInstanceId: 'claude-work',
      projectId: 'p1',
      cwd: '/work/wow',
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
    });
    run({
      type: 'card.create',
      cardId: 'card-1',
      title: 'Fix the login',
      start: '2026-11-03T09:00:00.000Z',
      end: '2026-11-03T10:00:00.000Z',
      zone: 'Europe/Stockholm',
      projectId: 'p1',
      workflowId: 'w1',
    });
    expect(triggers()).toEqual([expect.objectContaining({ state: 'scheduled' })]);
    run({
      type: 'setting.set',
      key: 'workflows.handoverTemplate',
      scope: 'project:p1',
      value: 'Go on',
    });

    run({ type: 'project.delete', projectId: 'p1' });

    expect(projects()).toEqual([]);
    expect(threads()).toEqual([
      expect.objectContaining({ id: 't1', projectId: null, cwd: '/work/wow' }),
    ]);
    expect(cards()).toEqual([
      expect.objectContaining({ id: 'card-1', projectId: null, workflowId: 'w1' }),
    ]);
    expect(triggers()).toEqual([expect.objectContaining({ state: 'cancelled' })]);
    expect(snapshot(database.db, { topic: 'settings' })).toEqual([]);
  });

  it('waits for a live run in the project, then keeps the finished run as history', () => {
    run({ type: 'workflowRun.start', runId: 'r1', workflowId: 'w1', projectId: 'p1' });
    expect(rejection({ type: 'project.delete', projectId: 'p1' })).toEqual({
      code: 'conflict',
      message: 'wow has a workflow run in progress; stop it or let it finish first',
    });
    expect(projects()).toHaveLength(1);

    run({ type: 'workflowRun.stop', runId: 'r1' });
    run({ type: 'project.delete', projectId: 'p1' });
    expect(projects()).toEqual([]);
    expect(runs()).toEqual([expect.objectContaining({ id: 'r1', projectId: 'p1' })]);
  });

  it('reports a missing project', () => {
    expect(rejection({ type: 'project.delete', projectId: 'nope' })).toEqual({
      code: 'not_found',
      message: 'No project nope',
    });
    expect(rejection({ type: 'project.update', projectId: 'nope', name: 'x' })?.code).toBe(
      'not_found',
    );
  });
});
