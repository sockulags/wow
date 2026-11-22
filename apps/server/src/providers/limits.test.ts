import type { Command, ProviderLimit, ServerCommand } from '@wow/contracts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../core/engine.js';
import { snapshot } from '../core/subscriptions.js';
import { openDatabase, type Database } from '../db/database.js';

// Plan limits kept per provider instance and told once per window (chat overview spec 25 to 29).
// All invented.

let dir: string;
let database: Database;
let engine: Engine;
let now: number;
let next = 0;

const dispatch = (command: Command | ServerCommand) => engine.dispatch(`c${(next += 1)}`, command);
const report = (...limits: ProviderLimit[]) =>
  dispatch({ type: 'providerInstance.limitsReported', providerInstanceId: 'claude', limits });
const fiveHour = (usedPercent: number, resetsAt = '2026-11-22T16:40:00.000Z'): ProviderLimit => ({
  window: 'fiveHour',
  label: null,
  usedPercent,
  resetsAt,
  state: 'ok',
});
const stored = () =>
  (
    snapshot(database.db, { topic: 'providerLimits' }) as {
      providerInstanceId: string;
      limits: (ProviderLimit & { reportedAt: string })[];
    }[]
  )[0]?.limits;
const told = () =>
  (snapshot(database.db, { topic: 'notifications' }) as { kind: string; title: string }[])
    .filter((row) => row.kind === 'limit')
    .map((row) => row.title);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-limits-'));
  database = openDatabase(path.join(dir, 'wow.sqlite'));
  now = Date.UTC(2026, 10, 22, 12, 0, 0);
  engine = new Engine(database.db, { clock: () => new Date(now) });
  dispatch({
    type: 'providerInstance.create',
    providerInstanceId: 'claude',
    kind: 'claude',
    name: 'Claude Code',
    binaryPath: 'claude',
    configDir: '',
    env: {},
    launchArgs: [],
  });
});

afterEach(async () => {
  database.close();
  await rm(dir, { recursive: true, force: true });
});

describe('plan limits (chat overview spec 25 to 29)', () => {
  it('keeps the latest of each window with when it was reported', () => {
    report(fiveHour(40), { ...fiveHour(10), window: 'week', resetsAt: null });
    now += 60_000;
    report(fiveHour(55));
    expect(stored()).toEqual([
      { ...fiveHour(55), reportedAt: new Date(now).toISOString() },
      {
        ...fiveHour(10),
        window: 'week',
        resetsAt: null,
        reportedAt: new Date(now - 60_000).toISOString(),
      },
    ]);
  });

  it('tells once when a window crosses the warning, again when it is reached, and again after a reset', () => {
    report(fiveHour(50));
    report(fiveHour(84));
    report(fiveHour(90));
    report({ ...fiveHour(100), state: 'reached' });
    report(fiveHour(85, '2026-11-22T21:40:00.000Z'));
    expect(told()).toEqual([
      'Claude Code: 5-hour limit at 84 %',
      'Claude Code: 5-hour limit reached',
      'Claude Code: 5-hour limit at 85 %',
    ]);
  });

  it('tells nothing with notifications off', () => {
    dispatch({ type: 'setting.set', key: 'chat.notifications', scope: 'global', value: 'off' });
    report(fiveHour(95));
    expect(told()).toEqual([]);
    expect(stored()).toHaveLength(1);
  });
});
