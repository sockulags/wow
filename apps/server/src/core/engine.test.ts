import Sqlite from 'better-sqlite3';
import type { Command, Project } from '@wow/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../db/database.js';
import { Engine, fingerprint, type Commit } from './engine.js';
import { CommandRejected } from './orchestrator.js';
import { Subscriptions } from './subscriptions.js';

let dir: string;
let file: string;
let database: Database;
let engine: Engine;

const clock = () => new Date('2026-11-02T08:00:00.000Z');
const create: Command = { type: 'project.create', projectId: 'p1', name: 'wow', cwd: '/work/wow' };

const count = (table: string) =>
  (database.sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-engine-'));
  file = path.join(dir, 'wow.sqlite');
  database = openDatabase(file);
  engine = new Engine(database.db, { clock });
});

afterEach(async () => {
  database.close();
  await rm(dir, { recursive: true, force: true });
});

describe('idempotent retries', () => {
  it('applies a command id once and returns the first receipt on retry', () => {
    const first = engine.dispatch('c1', create);
    const second = engine.dispatch('c1', create);
    expect(first).toEqual({ commandId: 'c1', seqs: [1], duplicate: false });
    expect(second).toEqual({ commandId: 'c1', seqs: [1], duplicate: true });
    expect(count('events')).toBe(1);
    expect(count('projects')).toBe(1);
    expect(count('command_receipts')).toBe(1);
  });

  it('does not tell listeners about a retried command', () => {
    const commits: Commit[] = [];
    engine.onCommit((commit) => commits.push(commit));
    engine.dispatch('c1', create);
    engine.dispatch('c1', create);
    expect(commits).toHaveLength(1);
  });

  it('refuses a command id reused for a different command', () => {
    engine.dispatch('c1', create);
    expect(() => engine.dispatch('c1', { ...create, name: 'other' })).toThrow(CommandRejected);
    expect(count('events')).toBe(1);
  });

  it('keeps no receipt for a rejected command, so the id can be used again', () => {
    expect(() => engine.dispatch('c1', { type: 'project.delete', projectId: 'p1' })).toThrow(
      /No project p1/,
    );
    expect(count('command_receipts')).toBe(0);
    engine.dispatch('c0', create);
    expect(engine.dispatch('c1', { type: 'project.delete', projectId: 'p1' }).duplicate).toBe(
      false,
    );
  });

  it('fingerprints commands independent of key order', () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
  });
});

describe('subscribers after commit', () => {
  it('only hears about a projection once another connection can read it', () => {
    const outside = new Sqlite(file, { readonly: true });
    const seen: unknown[] = [];
    engine.onCommit(() => {
      seen.push(outside.prepare('select name from projects where id = ?').get('p1'));
    });
    engine.dispatch('c1', create);
    outside.close();
    expect(seen).toEqual([{ name: 'wow' }]);
  });

  it('hears nothing when the transaction rolls back after the events were written', () => {
    database.sqlite.exec(`create temp trigger fail_receipt before insert on command_receipts
      begin select raise(abort, 'receipt failed'); end`);
    const commits: Commit[] = [];
    engine.onCommit((commit) => commits.push(commit));
    expect(() => engine.dispatch('c1', create)).toThrow(/receipt failed/);
    expect(commits).toEqual([]);
    expect(count('events')).toBe(0);
    expect(count('projects')).toBe(0);
  });

  it('pushes the committed projection to subscribers of the changed topic only', () => {
    const subscriptions = new Subscriptions(database.db, engine);
    const pushes: { id: string; data: unknown[] }[] = [];
    const projects = subscriptions.subscribe({ topic: 'projects' }, (id, data) =>
      pushes.push({ id, data }),
    );
    subscriptions.subscribe({ topic: 'threads' }, (id, data) => pushes.push({ id, data }));
    expect(projects.data).toEqual([]);

    engine.dispatch('c1', create);
    const expected: Project = {
      id: 'p1',
      name: 'wow',
      cwd: '/work/wow',
      defaultProviderInstanceId: null,
      defaultModel: null,
      createdAt: '2026-11-02T08:00:00.000Z',
    };
    expect(pushes).toEqual([{ id: projects.subscriptionId, data: [expected] }]);

    expect(subscriptions.unsubscribe(projects.subscriptionId)).toBe(true);
    engine.dispatch('c2', { type: 'project.update', projectId: 'p1', name: 'renamed' });
    expect(pushes).toHaveLength(1);
  });

  it('keeps a commit when a listener throws', () => {
    const errors: unknown[] = [];
    const guarded = new Engine(database.db, { clock, onListenerError: (e) => errors.push(e) });
    guarded.onCommit(() => {
      throw new Error('listener broke');
    });
    expect(guarded.dispatch('c1', create).seqs).toEqual([1]);
    expect(errors).toHaveLength(1);
    expect(count('projects')).toBe(1);
  });
});

describe('projects', () => {
  it('records no event for an update that changes nothing', () => {
    engine.dispatch('c1', create);
    expect(
      engine.dispatch('c2', { type: 'project.update', projectId: 'p1', name: 'wow' }).seqs,
    ).toEqual([]);
    expect(count('events')).toBe(1);
  });

  it('rejects a second project with the same id', () => {
    engine.dispatch('c1', create);
    expect(() => engine.dispatch('c2', create)).toThrow(/already exists/);
  });
});

describe('migrations', () => {
  it('creates every table from the architecture', () => {
    const tables = (
      database.sqlite
        .prepare(`select name from sqlite_master where type = 'table' order by name`)
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'approvals',
        'backlog_items',
        'calendar_items',
        'command_receipts',
        'events',
        'mail_items',
        'outlook_status',
        'projects',
        'provider_instances',
        'questions',
        'settings',
        'skills',
        'thread_items',
        'threads',
        'triggers',
        'turns',
        'workflow_runs',
        'workflows',
      ]),
    );
  });

  it('is safe to run again on an existing store', () => {
    database.close();
    database = openDatabase(file);
    expect(count('events')).toBe(0);
  });
});
