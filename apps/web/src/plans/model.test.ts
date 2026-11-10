import type { PlanIntent, PlanUnit, Project } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { planCommands } from './commands';
import {
  openPlan,
  plansByProject,
  problemLabel,
  revisionLabel,
  staleLabel,
  validatePlanSearch,
} from './model';

const project = (id: string, name: string): Project => ({
  id,
  name,
  cwd: `/work/${id}`,
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: '2026-11-10T08:00:00.000Z',
});

const unit = (key: string, title: string): PlanUnit => ({
  key,
  title,
  line: 12,
  dependsOn: [],
  blocked: null,
  contract: null,
  status: 'unknown',
  statusReason: 'No host is set up for this project',
});

const intent = (
  projectId: string,
  intentId: string,
  changes: Partial<PlanIntent> = {},
): PlanIntent => ({
  id: `${projectId}:${intentId}`,
  projectId,
  intentId,
  title: `Title of ${intentId}`,
  hasIntent: true,
  status: 'accepted',
  rev: 1,
  spec: null,
  plan: null,
  source: null,
  units: [],
  problems: [],
  ...changes,
});

describe('plans model', () => {
  it('says status and revision, leaving out what a file does not say', () => {
    expect(revisionLabel('accepted', 2)).toBe('accepted · rev 2');
    expect(revisionLabel(null, 2)).toBe('rev 2');
    expect(revisionLabel('done', null)).toBe('done');
    expect(revisionLabel(null, null)).toBe('No status');
  });

  it('says what a stale spec or plan was built on', () => {
    const stale = { rev: 1, status: 'accepted', stale: { builtOn: 1, current: 2 } };
    expect(staleLabel('spec', stale)).toBe('Stale: built on intent@1, intent.md is at rev 2');
    expect(staleLabel('plan', stale)).toBe('Stale: built on spec@1, spec.md is at rev 2');
    expect(staleLabel('plan', { ...stale, stale: null })).toBeUndefined();
  });

  it('names a problem by file and line', () => {
    expect(problemLabel({ file: 'plan', line: 11, message: 'Unit key U1 appears twice' })).toBe(
      'plan.md line 11: Unit key U1 appears twice',
    );
  });

  it('lists every project by name with its intents by id', () => {
    const grouped = plansByProject(
      [project('b', 'Tea'), project('a', 'Garden'), project('c', 'Empty')],
      [intent('b', '2026-02-kettle'), intent('a', '2026-03-beds'), intent('b', '2026-01-timer')],
    );
    expect(
      grouped.map(({ project: own, intents }) => [own.name, intents.map((row) => row.intentId)]),
    ).toEqual([
      ['Empty', []],
      ['Garden', ['2026-03-beds']],
      ['Tea', ['2026-01-timer', '2026-02-kettle']],
    ]);
  });

  it('reads the open plan from the path and the open unit from the search', () => {
    const rows = [intent('a', '2026-03-beds'), intent('b', '2026-03-beds')];
    expect(openPlan('/plans/b/2026-03-beds', rows)?.id).toBe('b:2026-03-beds');
    expect(openPlan('/plans', rows)).toBeUndefined();
    expect(openPlan('/plans/c/2026-03-beds', rows)).toBeUndefined();
    expect(openPlan('/plans/b/%zz', rows)).toBeUndefined();
    expect(openPlan('/plans/%E0%A4%A/2026-03-beds', rows)).toBeUndefined();
    expect(openPlan('/plans/b/2026%2D03-beds', rows)?.id).toBe('b:2026-03-beds');
    expect(validatePlanSearch({ unit: 'U2' })).toEqual({ unit: 'U2' });
    expect(validatePlanSearch({ unit: 2 })).toEqual({});
    expect(validatePlanSearch({})).toEqual({});
  });
});

describe('plan palette commands', () => {
  const tea = intent('b', '2026-01-timer', {
    title: 'A tea timer',
    rev: 2,
    units: [unit('U1', 'Count down'), unit('U2', 'Ring the bell')],
  });
  const data = { intents: [tea, intent('a', '2026-03-beds')], projects: [project('b', 'Tea')] };

  it('offers a refresh and every intent, the intents only when searching', () => {
    const commands = planCommands({ ...data, openIntent: undefined });
    expect(commands.map((command) => command.id)).toEqual([
      'plans.refresh',
      'plan.b:2026-01-timer',
      'plan.a:2026-03-beds',
    ]);
    expect(commands[1]).toMatchObject({
      title: 'A tea timer',
      detail: 'Plan · Tea · accepted · rev 2',
      searchOnly: true,
      group: 'Plans',
    });
    expect(commands[0]?.searchOnly).toBeUndefined();
  });

  it('offers the units of the open plan', () => {
    const commands = planCommands({ ...data, openIntent: tea });
    expect(commands.slice(1, 3).map((command) => command.title)).toEqual([
      'Unit U1: Count down',
      'Unit U2: Ring the bell',
    ]);
  });
});
