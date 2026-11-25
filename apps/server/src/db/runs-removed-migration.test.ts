import type Sqlite from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningServer } from '../server.js';
import { insert, launchOn, oldStore, tablesOf, threadRow } from './old-store.js';

// Workflow runs, plan runs, plans, the host poller's reads and event triggers are gone
// (orchestrator threads spec 35): the migration deletes their rows and the events that made
// them, keeps step threads as done chat threads, and keeps usage and provider limits. The store
// is built with the migrations up to the one before and then opened by the server, twice.

const at = '2026-11-20T08:00:00.000Z';

let root: string;
let server: RunningServer | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-runs-removed-'));
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

const before = () =>
  oldStore(root, '0050_assistant_is_a_main_thread', '0051_runs_plans_and_event_triggers_removed');
const thread = (id: string, values: Record<string, unknown>) => threadRow(id, at, values);
const launch = (home: string) => launchOn(root, home);

const removedTables = [
  'workflow_runs',
  'plan_runs',
  'plan_intents',
  'host_reads',
  'change_requests',
  'ticket_reads',
  'page_reads',
  'trigger_events',
];

describe('migration 0051_runs_plans_and_event_triggers_removed', () => {
  it('deletes runs, plans, host reads and event triggers, keeps step threads as done chat threads, and keeps usage and limits', async () => {
    const { home, db: old } = await before();
    insert(old, 'threads', thread('step', { run_id: 'run-1', step_id: 'build', state: 'working' }));
    insert(old, 'threads', thread('chat', {}));
    insert(old, 'turns', {
      id: 'chat:turn:0',
      thread_id: 'chat',
      index: 0,
      state: 'completed',
      started_at: at,
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    insert(old, 'provider_limits', {
      provider_instance_id: 'claude-work',
      limits: [{ window: 'fiveHours', usedPercent: 40, resetsAt: null, reportedAt: at }],
    });
    insert(old, 'workflow_runs', {
      id: 'run-1',
      workflow_id: 'delivery',
      project_id: 'tea',
      state: 'running',
      current_step: 0,
      started_at: at,
    });
    insert(old, 'plan_runs', { id: 'plan-run-1', plan_id: 'tea:kettle', state: 'running' });
    insert(old, 'plan_intents', { id: 'tea:kettle', project_id: 'tea', intent_id: 'kettle' });
    insert(old, 'host_reads', { id: 'run:run-1', project_id: 'tea', scope: 'run' });
    insert(old, 'change_requests', { id: 'tea:14', project_id: 'tea', number: 14 });
    insert(old, 'ticket_reads', { id: 'run:run-1', project_id: 'tea', run_id: 'run-1' });
    insert(old, 'page_reads', { id: 'run:run-1', project_id: 'tea', run_id: 'run-1' });
    insert(old, 'trigger_events', { trigger_id: 'on-merge', event_id: 'e1', at });
    insert(old, 'triggers', {
      id: 'on-merge',
      kind: 'event',
      workflow_id: 'delivery',
      project_id: 'tea',
      event: 'merged',
      enabled: 1,
      created_at: at,
    });
    insert(old, 'triggers', {
      id: 'card-1:trigger',
      kind: 'card',
      calendar_item_id: 'card-1',
      workflow_id: 'delivery',
      run_at: '2026-11-30T09:00:00.000Z',
      zone: 'Europe/Stockholm',
      state: 'scheduled',
      run_id: 'run-0',
    });
    insert(old, 'calendar_items', {
      id: 'card-1',
      source: 'local',
      title: 'Ring the bell',
      start: '2026-11-30T09:00:00.000Z',
      end: '2026-11-30T10:00:00.000Z',
      zone: 'Europe/Stockholm',
      state: 'running',
      run_id: 'run-1',
      updated_at: at,
    });
    insert(old, 'backlog_items', {
      id: 'item-1',
      title: 'A quieter kettle',
      body: '',
      tags: [],
      state: 'running',
      run_id: 'run-1',
      created_at: at,
    });
    insert(old, 'notifications', {
      id: 'run-1:failed',
      at,
      kind: 'failed',
      title: 'Run failed',
      body: '',
      path: '/workflows/runs/run-1',
      run_id: 'run-1',
    });
    insert(old, 'notifications', {
      id: 'chat:finished',
      at,
      kind: 'finished',
      title: 'Thread finished',
      body: '',
      path: '/chat/chat',
      thread_id: 'chat',
    });
    for (const [kind, aggregate, payload] of [
      ['workflowRun.changed', 'run-1', { cause: 'workflowRun.start' }],
      ['planRun.changed', 'plan-run-1', {}],
      ['hosts.synced', 'hosts:tea', {}],
      ['trigger.set', 'on-merge', { id: 'on-merge', kind: 'event' }],
      ['trigger.set', 'card-1:trigger', { id: 'card-1:trigger', kind: 'card' }],
      ['trigger.deleted', 'on-merge', { triggerId: 'on-merge' }],
      ['thread.created', 'chat', { id: 'chat' }],
    ] as const) {
      insert(old, 'events', { at, kind, aggregate, payload });
    }
    insert(old, 'assistant_proposals', {
      id: 'p1',
      at,
      command_type: 'card.runNow',
      title: 'Run the card now',
      command: { type: 'card.runNow', cardId: 'card-1', runId: 'new-thread' },
      state: 'pending',
    });
    insert(old, 'assistant_proposals', {
      id: 'p2',
      at,
      command_type: 'workflowRun.start',
      title: 'Start Delivery',
      command: { type: 'workflowRun.start', runId: 'r2', workflowId: 'delivery', projectId: 'tea' },
      state: 'pending',
    });
    for (const [key, value] of [
      ['workflows.handoverTemplate', 'Hand over'],
      ['hosts.polling', false],
      ['calendar.snapMinutes', 30],
    ] as const) {
      insert(old, 'settings', { key, scope: 'global', value: JSON.stringify(value) });
    }
    old.close();

    const check = (db: Sqlite.Database) => {
      const tables = tablesOf(db);
      for (const table of removedTables) expect(tables.has(table)).toBe(false);
      expect(db.prepare('SELECT id, kind, state FROM threads ORDER BY id').all()).toEqual([
        { id: 'chat', kind: 'chat', state: 'idle' },
        { id: 'step', kind: 'chat', state: 'done' },
      ]);
      expect(db.prepare('SELECT usage FROM turns').all()).toEqual([
        { usage: JSON.stringify({ inputTokens: 120, outputTokens: 30 }) },
      ]);
      expect(db.prepare('SELECT provider_instance_id FROM provider_limits').all()).toEqual([
        { provider_instance_id: 'claude-work' },
      ]);
      expect(db.prepare('SELECT * FROM triggers').all()).toEqual([
        {
          id: 'card-1:trigger',
          calendar_item_id: 'card-1',
          workflow_id: 'delivery',
          run_at: '2026-11-30T09:00:00.000Z',
          zone: 'Europe/Stockholm',
          state: 'scheduled',
          offer_run_now: 0,
        },
      ]);
      expect(db.prepare('SELECT id, state FROM calendar_items').all()).toEqual([
        { id: 'card-1', state: 'stopped' },
      ]);
      expect(db.prepare('SELECT id, state FROM backlog_items').all()).toEqual([
        { id: 'item-1', state: 'planned' },
      ]);
      expect(db.prepare('SELECT id FROM notifications').all()).toEqual([{ id: 'chat:finished' }]);
      // The server stores events of its own as it starts; the ones before it are what is asked.
      expect(
        db.prepare('SELECT kind, aggregate FROM events WHERE at = ? ORDER BY seq').all(at),
      ).toEqual([
        { kind: 'trigger.set', aggregate: 'card-1:trigger' },
        { kind: 'thread.created', aggregate: 'chat' },
      ]);
      expect(db.prepare('SELECT id, command FROM assistant_proposals').all()).toEqual([
        {
          id: 'p1',
          command: JSON.stringify({
            type: 'card.runNow',
            cardId: 'card-1',
            threadId: 'new-thread',
          }),
        },
      ]);
      expect(db.prepare('SELECT key FROM settings ORDER BY key').all()).toEqual([
        { key: 'calendar.snapMinutes' },
      ]);
    };

    server = await launch(home);
    check(server.database.sqlite);
    // A restart reads the same rows: nothing brings the removed ones back.
    await server.stop();
    server = await launch(home);
    check(server.database.sqlite);
  });
});

describe('what a run left behind (migration 0051)', () => {
  it('moves the step threads of a run with its own copy to the project folder, and a card that ran keeps its fired trigger when moved', async () => {
    const { home, db: old } = await before();
    insert(old, 'projects', { id: 'tea', name: 'Tea', cwd: '/home/me/tea', created_at: at });
    insert(old, 'workflows', {
      id: 'delivery',
      name: 'Delivery',
      steps: [],
      own_working_copy: 1,
      for_units: 0,
      created_at: at,
      updated_at: at,
    });
    // A step thread in the run's own copy, which an event run may have left at a fork's head.
    insert(
      old,
      'threads',
      thread('in-copy', {
        project_id: 'tea',
        cwd: '/home/me/.wow/workspaces/tea-1a2b3c4d',
        provider_session_id: 'session-in-copy',
        run_id: 'run-copy',
        step_id: 'build',
        state: 'done',
      }),
    );
    // A step thread of a run in the project folder stays where it was.
    insert(
      old,
      'threads',
      thread('in-folder', {
        project_id: 'tea',
        provider_session_id: 'session-in-folder',
        run_id: 'run-folder',
        step_id: 'build',
        state: 'done',
      }),
    );
    insert(old, 'workflow_runs', {
      id: 'run-copy',
      workflow_id: 'delivery',
      project_id: 'tea',
      state: 'done',
      current_step: 0,
      started_at: at,
      working_copy: { path: '/home/me/.wow/workspaces/tea-1a2b3c4d', state: 'kept' },
    });
    insert(old, 'workflow_runs', {
      id: 'run-folder',
      workflow_id: 'delivery',
      project_id: 'tea',
      state: 'done',
      current_step: 0,
      started_at: at,
    });
    // A card that ran before cards started threads: its run is all that said it started.
    insert(old, 'calendar_items', {
      id: 'card-ran',
      source: 'local',
      title: 'Ring the bell',
      start: '2026-11-19T09:00:00.000Z',
      end: '2026-11-19T10:00:00.000Z',
      zone: 'Europe/Stockholm',
      project_id: 'tea',
      workflow_id: 'delivery',
      state: 'done',
      run_id: 'run-folder',
      updated_at: at,
    });
    insert(old, 'triggers', {
      id: 'card-ran:trigger',
      kind: 'card',
      calendar_item_id: 'card-ran',
      workflow_id: 'delivery',
      run_at: '2026-11-19T09:00:00.000Z',
      zone: 'Europe/Stockholm',
      state: 'fired',
      run_id: 'run-folder',
    });
    // The trigger of a card deleted after its thread fired stays; Undo makes the card again.
    insert(old, 'triggers', {
      id: 'card-gone:trigger',
      kind: 'card',
      calendar_item_id: 'card-gone',
      workflow_id: 'delivery',
      run_at: '2026-11-18T09:00:00.000Z',
      zone: 'Europe/Stockholm',
      state: 'fired',
    });
    old.close();

    server = await launch(home);
    expect(
      server.database.sqlite
        .prepare('SELECT id, cwd, provider_session_id FROM threads ORDER BY id')
        .all(),
    ).toEqual([
      { id: 'in-copy', cwd: '/home/me/tea', provider_session_id: null },
      { id: 'in-folder', cwd: '/home/me/tea', provider_session_id: 'session-in-folder' },
    ]);
    // Moved to a time still to come, it is not run again.
    server.engine.dispatch('move-card-ran', {
      type: 'card.update',
      cardId: 'card-ran',
      start: '2099-01-05T09:00:00.000Z',
      end: '2099-01-05T10:00:00.000Z',
    });
    expect(
      server.database.sqlite
        .prepare("SELECT state FROM triggers WHERE id = 'card-ran:trigger'")
        .get(),
    ).toEqual({ state: 'fired' });
    expect(
      server.database.sqlite
        .prepare("SELECT state FROM calendar_items WHERE id = 'card-ran'")
        .get(),
    ).toEqual({ state: 'done' });

    // A card made again with that id is armed again, as before.
    server.engine.dispatch('restore-card-gone', {
      type: 'card.create',
      cardId: 'card-gone',
      title: 'Pour the tea',
      start: '2099-01-06T09:00:00.000Z',
      end: '2099-01-06T10:00:00.000Z',
      zone: 'Europe/Stockholm',
      projectId: 'tea',
      workflowId: 'delivery',
    });
    expect(
      server.database.sqlite
        .prepare("SELECT state, run_at FROM triggers WHERE id = 'card-gone:trigger'")
        .get(),
    ).toEqual({ state: 'scheduled', run_at: '2099-01-06T09:00:00.000Z' });
  });
});
