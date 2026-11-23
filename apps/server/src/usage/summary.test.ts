import type { Command, ProviderEvent, ServerCommand } from '@wow/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../core/engine.js';
import { openDatabase, type Database } from '../db/database.js';
import { usageSummary } from './summary.js';

// The usage view's sums (chat overview spec 39, 40), on a clock the test moves. All invented.

let dir: string;
let database: Database;
let engine: Engine;
let now: number;
let next = 0;

const dispatch = (command: Command | ServerCommand) => engine.dispatch(`c${(next += 1)}`, command);
const events = (threadId: string, ...list: ProviderEvent[]) =>
  dispatch({ type: 'provider.events', threadId, events: list });

function turn(threadId: string, usage: ProviderEvent | undefined) {
  dispatch({ type: 'thread.sendMessage', threadId, text: 'Go on' });
  events(threadId, ...(usage ? [usage] : []), { type: 'turnCompleted', threadId });
}

const used = (threadId: string, costUsd?: number): ProviderEvent => ({
  type: 'usage',
  threadId,
  inputTokens: 1000,
  outputTokens: 100,
  cachedInputTokens: 500,
  model: 'opus',
  ...(costUsd === undefined ? {} : { costUsd }),
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-usage-'));
  database = openDatabase(path.join(dir, 'wow.sqlite'));
  now = Date.UTC(2026, 10, 20, 22, 30, 0);
  engine = new Engine(database.db, { clock: () => new Date(now) });
  dispatch({
    type: 'providerInstance.create',
    providerInstanceId: 'claude',
    kind: 'claude',
    name: 'Claude',
    binaryPath: 'claude',
    configDir: '',
    env: {},
    launchArgs: [],
  });
  dispatch({ type: 'project.create', projectId: 'tea', name: 'Tea', cwd: '/work/tea' });
  dispatch({ type: 'project.create', projectId: 'bell', name: 'Bell', cwd: '/work/bell' });
  for (const [threadId, projectId] of [
    ['t1', 'tea'],
    ['t2', 'bell'],
  ] as const) {
    dispatch({
      type: 'thread.create',
      threadId,
      providerInstanceId: 'claude',
      projectId,
      cwd: `/work/${projectId}`,
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
    });
  }
});

afterEach(async () => {
  database.close();
  await rm(dir, { recursive: true, force: true });
});

describe('the usage summary (chat overview spec 39, 40)', () => {
  it('sums per day in the zone, project and model, and keeps an unknown cost apart', () => {
    turn('t1', used('t1', 0.25));
    turn('t2', used('t2'));
    now += 2 * 3_600_000;
    turn('t1', used('t1', 0.5));
    turn('t1', undefined);
    const range = { from: '2026-11-20T00:00:00.000Z', to: '2026-11-22T00:00:00.000Z' };
    const utc = usageSummary(database.db, { ...range, timeZone: 'UTC' }).rows;
    expect(
      utc.map((row) => [
        row.day,
        row.projectId,
        row.turns,
        row.costUsd,
        row.unknownCost,
        row.noUsage,
      ]),
    ).toEqual([
      ['2026-11-20', 'tea', 1, 0.25, 0, 0],
      ['2026-11-20', 'bell', 1, 0, 1, 0],
      ['2026-11-21', 'tea', 2, 0.5, 0, 1],
    ]);
    // 22:30 UTC is already the next morning in Tokyo, so every turn falls on the 21st there.
    const tokyo = usageSummary(database.db, { ...range, timeZone: 'Asia/Tokyo' }).rows;
    expect(tokyo.map((row) => [row.day, row.projectId, row.turns])).toEqual([
      ['2026-11-21', 'tea', 3],
      ['2026-11-21', 'bell', 1],
    ]);
    expect(utc[0]).toMatchObject({ inputTokens: 1000, outputTokens: 100, cachedInputTokens: 500 });
  });
});
