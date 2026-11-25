import type Sqlite from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningServer } from '../server.js';
import { insert, launchOn, oldStore, tablesOf, threadRow } from './old-store.js';

// The assistant's briefings, decision queue, delegation under standing permissions and notes are
// gone (orchestrator threads spec 35): the migration deletes their rows, settings and the events of
// the removed kinds, and keeps a thread the assistant started as an ordinary chat thread. A setup
// file applied before that set a removed setting can still be undone.

const at = '2026-11-21T08:00:00.000Z';

let root: string;
let server: RunningServer | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-chief-removed-'));
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await rm(root, { recursive: true, force: true });
});

const removedTables = [
  'assistant_permission_uses',
  'briefings',
  'decision_briefs',
  'decision_dismissals',
  'decision_reminders',
];

describe('migration 0052_chief_of_staff_removed', () => {
  it('deletes briefings, the decision queue, permissions and notes, and keeps delegated threads as chat threads', async () => {
    const { home, db: old } = await oldStore(
      root,
      '0051_runs_plans_and_event_triggers_removed',
      '0052_chief_of_staff_removed',
    );
    insert(
      old,
      'threads',
      threadRow('delegated', at, { started_by: 'assistant', follow_turns: 2 }),
    );
    insert(old, 'threads', threadRow('main', at, {}));
    insert(
      old,
      'threads',
      threadRow('helper', at, { started_by: 'helper', parent_thread_id: 'main' }),
    );
    insert(old, 'questions', {
      id: 'q1',
      thread_id: 'delegated',
      item_id: 'i1',
      request: {},
      answer: 'Yes',
      answered_at: at,
      answered_because: 'You said yes this morning.',
    });
    insert(old, 'briefings', {
      id: 'b1',
      at,
      moment: 'morning',
      since: at,
      lines: [],
    });
    insert(old, 'decision_briefs', { decision_id: 'approval:a1', requested_at: at });
    insert(old, 'decision_reminders', { decision_id: 'approval:a1', at });
    insert(old, 'decision_dismissals', { decision_id: 'missedCard:c1', at });
    insert(old, 'assistant_permission_uses', {
      id: 'use-1',
      at,
      permission_id: 'p1',
      kind: 'startThreads',
      command_type: 'assistant.startThread',
      what: 'Start a thread',
      place: { label: 'Chat', path: '/chat/delegated' },
    });
    for (const [id, kind] of [
      ['morning', 'briefing'],
      ['approval:a1:reminder', 'reminder'],
      ['main:finished', 'finished'],
    ] as const) {
      insert(old, 'notifications', { id, at, kind, title: id, body: '', path: '/chat' });
    }
    for (const [kind, aggregate, payload] of [
      ['briefing.made', 'b1', { id: 'b1' }],
      ['decision.briefRequested', 'approval:a1', { decisionId: 'approval:a1', at }],
      ['decision.dismissed', 'missedCard:c1', { decisionId: 'missedCard:c1', at }],
      ['presence.returned', 'presence', { awayFrom: at, at }],
      ['thread.delegated', 'delegated', { threadId: 'delegated', at }],
      ['thread.followed', 'delegated', { threadId: 'delegated', at }],
      ['question.answeredByAssistant', 'q1', { questionId: 'q1', because: 'You said yes.' }],
      ['assistant.permissionUsed', 'use-1', { id: 'use-1' }],
      ['notification.sent', 'morning', { id: 'morning', kind: 'briefing' }],
      ['notification.sent', 'main:finished', { id: 'main:finished', kind: 'finished' }],
      ['thread.created', 'main', { id: 'main' }],
    ] as const) {
      insert(old, 'events', { at, kind, aggregate, payload });
    }
    for (const [id, key] of [
      ['change-notes', 'assistant.notes'],
      ['change-snap', 'calendar.snapMinutes'],
    ] as const) {
      insert(old, 'assistant_changes', {
        id,
        at,
        command_type: 'setting.set',
        what: key,
        place: { label: 'Settings', path: '/settings' },
        target: { kind: 'setting', id: `${key}:global` },
        inverse: [{ type: 'setting.reset', key, scope: 'global' }],
        state: 'applied',
      });
    }
    for (const [id, key] of [
      ['proposal-delegation', 'assistant.delegation'],
      ['proposal-weekends', 'calendar.showWeekends'],
    ] as const) {
      insert(old, 'assistant_proposals', {
        id,
        at,
        command_type: 'setting.set',
        title: key,
        lines: [],
        place: { label: 'Settings', path: '/settings' },
        command: { type: 'setting.set', key, scope: 'global', value: true },
        state: 'pending',
      });
    }
    for (const [key, value] of [
      ['assistant.delegation', true],
      ['assistant.permissions', []],
      ['assistant.briefings', false],
      ['assistant.notes', [{ id: 'n1', text: 'Tea first.', addedAt: at, by: 'you' }]],
      ['assistant.remindAfterMinutes', 90],
      ['calendar.snapMinutes', 30],
    ] as const) {
      insert(old, 'settings', { key, scope: 'global', value: JSON.stringify(value) });
    }
    // A setup file applied before set a removed setting beside one that stays.
    const part = (key: string, value: unknown) => ({
      id: `setup-team:${key}`,
      at,
      commandType: 'setting.set',
      what: key,
      from: null,
      to: String(value),
      place: { label: 'Settings', path: '/settings' },
      target: { kind: 'setting', id: `${key}:global` },
      inverse: [{ type: 'setting.reset', key, scope: 'global' }],
      expect: { value },
      state: 'applied',
      undoneAt: null,
    });
    insert(old, 'setup_applications', {
      id: 'setup-team',
      at,
      name: 'team.yaml',
      added: [],
      replaced: [],
      marked: [],
      to_fill_in: [],
      parts: [part('assistant.briefings', false), part('calendar.snapMinutes', 30)],
      state: 'applied',
    });
    old.close();

    const check = (db: Sqlite.Database) => {
      const tables = tablesOf(db);
      for (const table of removedTables) expect(tables.has(table)).toBe(false);
      expect(
        db.prepare('SELECT id, kind, started_by, parent_thread_id FROM threads ORDER BY id').all(),
      ).toEqual([
        { id: 'delegated', kind: 'chat', started_by: null, parent_thread_id: null },
        { id: 'helper', kind: 'chat', started_by: 'helper', parent_thread_id: 'main' },
        { id: 'main', kind: 'chat', started_by: null, parent_thread_id: null },
      ]);
      const threadColumns = db.prepare('PRAGMA table_info(threads)').all() as { name: string }[];
      expect(threadColumns.map((column) => column.name)).not.toContain('follow_turns');
      expect(db.prepare('SELECT * FROM questions').all()).toEqual([
        {
          id: 'q1',
          thread_id: 'delegated',
          item_id: 'i1',
          request: '{}',
          answer: 'Yes',
          answered_at: at,
        },
      ]);
      expect(db.prepare('SELECT id FROM notifications').all()).toEqual([{ id: 'main:finished' }]);
      // The server stores events of its own as it starts; the ones before it are what is asked.
      expect(
        db.prepare('SELECT kind, aggregate FROM events WHERE at = ? ORDER BY seq').all(at),
      ).toEqual([
        { kind: 'notification.sent', aggregate: 'main:finished' },
        { kind: 'thread.created', aggregate: 'main' },
      ]);
      expect(db.prepare('SELECT id FROM assistant_changes').all()).toEqual([{ id: 'change-snap' }]);
      expect(db.prepare('SELECT id FROM assistant_proposals').all()).toEqual([
        { id: 'proposal-weekends' },
      ]);
      expect(db.prepare('SELECT key FROM settings ORDER BY key').all()).toEqual([
        { key: 'calendar.snapMinutes' },
      ]);
    };

    server = await launchOn(root, home);
    check(server.database.sqlite);
    // A restart reads the same rows: nothing brings the removed ones back.
    await server.stop();
    server = await launchOn(root, home);
    check(server.database.sqlite);

    // Its Undo puts back what is still there and passes over the setting that is gone.
    server.engine.dispatch('undo-team', { type: 'setup.undo', applicationId: 'setup-team' });
    const sqlite = server.database.sqlite;
    expect(sqlite.prepare('SELECT key FROM settings').all()).toEqual([]);
    expect(sqlite.prepare('SELECT state FROM setup_applications').all()).toEqual([
      { state: 'undone' },
    ]);
  });
});
