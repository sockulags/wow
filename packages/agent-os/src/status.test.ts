import { describe, expect, it } from 'vitest';
import { intentUnitLines, unitStatuses, type UnitPullRequest } from './index.js';

const intentId = '2026-01-tea-timer';
const unit = (key: string, dependsOn: string[] = [], blocked: string | null = null) => ({
  key,
  dependsOn,
  blocked,
});
const pullRequest = (
  number: number,
  state: UnitPullRequest['state'],
  ...keys: string[]
): UnitPullRequest => ({
  id: `tea:${number}`,
  label: `Pull request #${number}`,
  state,
  units: keys.map((unitKey) => ({ intentId, unitKey })),
});
const current = { stale: null };
const plan = {
  intentId,
  source: 'files' as const,
  spec: current,
  plan: current,
  units: [
    unit('U1'),
    unit('U2', ['U1']),
    unit('U3', ['U1']),
    unit('U4', ['U2']),
    unit('U5', [], 'the bell is on order'),
  ],
};
const byKey = (statuses: ReturnType<typeof unitStatuses>) =>
  Object.fromEntries(statuses.map(({ key, status }) => [key, status]));

describe('unit status from pull requests', () => {
  it('shows delivered, claimed, ready, waiting and blocked', () => {
    const statuses = unitStatuses({
      ...plan,
      pullRequests: [pullRequest(12, 'merged', 'U1'), pullRequest(14, 'open', 'U2')],
    });
    expect(byKey(statuses)).toEqual({
      U1: 'delivered',
      U2: 'claimed',
      U3: 'ready',
      U4: 'waiting',
      U5: 'blocked',
    });
    expect(statuses.map(({ pullRequestId }) => pullRequestId)).toEqual([
      'tea:12',
      'tea:14',
      null,
      null,
      null,
    ]);
    expect(statuses[3]?.reason).toBe('Waits for U2');
    expect(statuses[4]?.reason).toBe('the bell is on order');
  });

  it('lets a pull request win over a blocked note and ignores a closed one', () => {
    const statuses = unitStatuses({
      ...plan,
      units: [unit('U1', [], 'on hold'), unit('U2', [], 'on hold'), unit('U3')],
      pullRequests: [pullRequest(3, 'merged', 'U1'), pullRequest(4, 'closed', 'U2', 'U3')],
    });
    expect(byKey(statuses)).toEqual({ U1: 'delivered', U2: 'blocked', U3: 'ready' });
  });

  it('takes every unit a pull request carries and leaves other intents alone', () => {
    const statuses = unitStatuses({
      ...plan,
      pullRequests: [
        pullRequest(12, 'merged', 'U1', 'U2'),
        { ...pullRequest(13, 'merged'), units: [{ intentId: '2026-02-kettle', unitKey: 'U3' }] },
      ],
    });
    expect(byKey(statuses)).toMatchObject({ U1: 'delivered', U2: 'delivered', U3: 'ready' });
  });

  it('makes no unit of a stale plan ready and names the file', () => {
    const statuses = unitStatuses({
      ...plan,
      plan: { stale: { builtOn: 1, current: 2 } },
      pullRequests: [pullRequest(12, 'merged', 'U1')],
    });
    expect(byKey(statuses)).toEqual({
      U1: 'delivered',
      U2: 'waiting',
      U3: 'waiting',
      U4: 'waiting',
      U5: 'blocked',
    });
    expect(statuses[1]?.reason).toBe(
      'Not ready: plan.md is stale (built on spec@1, spec.md is at rev 2)',
    );
    expect(statuses[3]?.reason).toBe(
      'Waits for U2; plan.md is stale (built on spec@1, spec.md is at rev 2)',
    );
  });

  it('makes no unit ready when the spec is stale and names it', () => {
    const statuses = unitStatuses({
      ...plan,
      spec: { stale: { builtOn: 2, current: 3 } },
      pullRequests: [],
    });
    expect(statuses.some(({ status }) => status === 'ready')).toBe(false);
    expect(statuses[0]?.reason).toBe(
      'Not ready: spec.md is stale (built on intent@2, intent.md is at rev 3)',
    );
  });

  it('does not call a unit ready when the dependencies are kept in issues', () => {
    const statuses = unitStatuses({
      ...plan,
      source: 'issues',
      units: [unit('K-1'), unit('K-2', [], 'on order'), unit('K-3')],
      pullRequests: [pullRequest(2, 'open', 'K-1')],
    });
    expect(byKey(statuses)).toEqual({ 'K-1': 'claimed', 'K-2': 'blocked', 'K-3': 'unknown' });
  });

  it('treats a dependency the plan does not list as not delivered', () => {
    expect(byKey(unitStatuses({ ...plan, units: [unit('U1', ['U9'])], pullRequests: [] }))).toEqual(
      { U1: 'waiting' },
    );
  });
});

describe('Intent-Unit lines', () => {
  it('reads every line of a pull request body', () => {
    const body = [
      'Counts down and rings.',
      '',
      'Intent-Unit: 2026-01-tea-timer/U1',
      'intent-unit:   2026-01-tea-timer/U2  ',
      'Intent-Unit: 2026-01-tea-timer/U1',
      'See Intent-Unit: 2026-01-tea-timer/U9 for later.',
      'Intent-Unit: no-unit-here',
    ].join('\r\n');
    expect(intentUnitLines(body)).toEqual([
      { intentId: '2026-01-tea-timer', unitKey: 'U1' },
      { intentId: '2026-01-tea-timer', unitKey: 'U2' },
    ]);
  });

  it('reads a line written as a list item, in backticks or with punctuation after it', () => {
    const body = [
      'Intent-Unit: 2026-01-tea-timer/U1.',
      '- Intent-Unit: 2026-01-tea-timer/U2,',
      '`Intent-Unit: 2026-01-tea-timer/U3`',
      '* Intent-Unit: `2026-01-tea-timer/U4`.',
      'Intent-Unit: 2026-01-tea-timer/U5.1',
      'Intent-Unit: 2026-01-tea-timer/.',
    ].join('\n');
    expect(intentUnitLines(body).map((line) => line.unitKey)).toEqual([
      'U1',
      'U2',
      'U3',
      'U4',
      'U5.1',
    ]);
    expect(new Set(intentUnitLines(body).map((line) => line.intentId))).toEqual(
      new Set(['2026-01-tea-timer']),
    );
  });

  it('reads a line in bold, quoted, in quote marks or with words after the key', () => {
    const body = [
      '**Intent-Unit:** 2026-01-tea-timer/U1',
      '**Intent-Unit: 2026-01-tea-timer/U2**',
      '> Intent-Unit: 2026-01-tea-timer/U3',
      '"Intent-Unit: 2026-01-tea-timer/U4"',
      'Intent-Unit: 2026-01-tea-timer/U5 (the bell part)',
      '__Intent-Unit__: `2026-01-tea-timer/U6`.',
      'Not an Intent-Unit: 2026-01-tea-timer/U7',
    ].join('\n');
    expect(intentUnitLines(body)).toEqual(
      ['U1', 'U2', 'U3', 'U4', 'U5', 'U6'].map((unitKey) => ({
        intentId: '2026-01-tea-timer',
        unitKey,
      })),
    );
  });
});
