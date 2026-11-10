import {
  defaultHandoverTemplate,
  defaultSendBackTemplate,
  defaultUnitPromptTemplate,
  type PlanIntent,
  type PlanRun,
  type PlanUnit,
  type PlanUnitStatus,
  type Workflow,
} from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import {
  advancePlanRun,
  planRunRefusal,
  RunRejected,
  startRun,
  stopPlanRun,
  type PlanRunAdvance,
} from './index.js';

// The plan run decisions of review loop spec 40 to 47, with an invented plan: U1, U2 that
// depends on U1, and U3.

const T0 = '2026-11-02T08:00:00.000Z';
const T1 = '2026-11-02T09:00:00.000Z';

const unit = (
  key: string,
  status: PlanUnitStatus,
  dependsOn: string[] = [],
  statusReason = '',
): PlanUnit => ({
  key,
  title: `Title of ${key}`,
  line: 1,
  dependsOn,
  blocked: status === 'blocked' ? statusReason : null,
  contract: null,
  status,
  statusReason,
  changeRequestId: null,
});

const units = (u1: PlanUnitStatus, u2: PlanUnitStatus, u3: PlanUnitStatus): PlanUnit[] => [
  unit('U1', u1),
  unit('U2', u2, ['U1']),
  unit('U3', u3),
];

const planRun = (overrides: Partial<PlanRun> = {}): PlanRun => ({
  id: 'pr1',
  planId: 'tea:2026-01-tea-timer',
  projectId: 'tea',
  intentId: '2026-01-tea-timer',
  workflowId: 'wf1',
  state: 'running',
  units: [],
  waitingFor: [],
  message: null,
  startedAt: T0,
  endedAt: null,
  ...overrides,
});

const input = (overrides: Partial<PlanRunAdvance>): PlanRunAdvance => ({
  now: T1,
  units: units('ready', 'waiting', 'ready'),
  unitRunState: undefined,
  onFailure: 'stop',
  runIdFor: (key) => `pr1.${key}`,
  ...overrides,
});

const started = (key: string, outcome: PlanRun['units'][number]['outcome'] = 'running') => ({
  unitKey: key,
  title: `Title of ${key}`,
  runId: `pr1.${key}`,
  outcome,
});

describe('picking the next unit (spec 40, 41, 42)', () => {
  it('starts the first ready unit in plan order', () => {
    const decision = advancePlanRun(planRun(), input({}));
    expect(decision.start).toEqual(started('U1'));
    expect(decision.planRun).toMatchObject({ state: 'running', units: [started('U1')] });
  });

  it('does nothing while the run of its unit is running or waiting at a gate', () => {
    const before = planRun({ units: [started('U1')] });
    for (const unitRunState of ['running', 'waiting'] as const) {
      const decision = advancePlanRun(before, input({ unitRunState }));
      expect(decision.planRun).toBe(before);
      expect(decision.start).toBeUndefined();
    }
  });

  it('starts the next ready unit when the run of the one before is done', () => {
    const decision = advancePlanRun(
      planRun({ units: [started('U1')] }),
      input({ unitRunState: 'done' }),
    );
    expect(decision.start).toEqual(started('U3'));
    expect(decision.planRun.units).toEqual([started('U1', 'done'), started('U3')]);
  });

  it('waits and says "U2 waits for U1 to merge" when only U2 remains and U1 is not merged', () => {
    const decision = advancePlanRun(
      planRun({ units: [started('U1', 'done'), started('U3')] }),
      input({ unitRunState: 'done', units: units('claimed', 'waiting', 'delivered') }),
    );
    expect(decision.start).toBeUndefined();
    expect(decision.planRun).toMatchObject({
      state: 'waiting',
      waitingFor: ['U1 waits for its pull request to merge', 'U2 waits for U1 to merge'],
      endedAt: null,
    });
  });

  it('starts U2 once the hosts show U1 merged', () => {
    const waiting = planRun({
      state: 'waiting',
      units: [started('U1', 'done'), started('U3', 'done')],
      waitingFor: ['U2 waits for U1 to merge'],
    });
    const decision = advancePlanRun(
      waiting,
      input({ units: units('delivered', 'ready', 'delivered') }),
    );
    expect(decision.start).toEqual(started('U2'));
    expect(decision.planRun).toMatchObject({ state: 'running', waitingFor: [] });
  });

  it('skips a unit that a pull request claims', () => {
    const decision = advancePlanRun(
      planRun(),
      input({ units: units('claimed', 'waiting', 'ready') }),
    );
    expect(decision.start?.unitKey).toBe('U3');
  });

  it('never starts a unit twice: a unit whose run ended without a pull request stays ready and is named', () => {
    const decision = advancePlanRun(
      planRun({ units: [started('U1', 'done'), started('U3')] }),
      input({ unitRunState: 'done', units: units('ready', 'waiting', 'ready') }),
    );
    expect(decision.start).toBeUndefined();
    expect(decision.planRun.waitingFor).toEqual([
      'No pull request found for U1',
      'U2 waits for U1 to merge',
      'No pull request found for U3',
    ]);
  });

  it('says why blocked, stale and unread units are waited for', () => {
    const decision = advancePlanRun(
      planRun(),
      input({
        units: [
          unit('U1', 'blocked', [], 'the pump is on order'),
          unit('U2', 'waiting', ['U1', 'U3', 'U4']),
          unit('U3', 'waiting', [], 'Not ready: plan.md is stale'),
          unit('U4', 'unknown', [], 'The host answered 500'),
        ],
      }),
    );
    expect(decision.planRun.waitingFor).toEqual([
      'U1 is blocked: the pump is on order',
      'U2 waits for U1, U3 and U4 to merge',
      'U3: Not ready: plan.md is stale',
      'U4: The host answered 500',
    ]);
  });
});

describe('a unit run that fails or is stopped (spec 43)', () => {
  it('stops the plan run there when planRunOnFailure is stop', () => {
    const decision = advancePlanRun(
      planRun({ units: [started('U1')] }),
      input({ unitRunState: 'failed', onFailure: 'stop' }),
    );
    expect(decision.start).toBeUndefined();
    expect(decision.planRun).toMatchObject({
      state: 'failed',
      units: [started('U1', 'failed')],
      message: 'The run for U1 failed, so no further unit was started',
      endedAt: T1,
    });
  });

  it('treats a stopped unit run the same way', () => {
    const decision = advancePlanRun(
      planRun({ units: [started('U1')] }),
      input({ unitRunState: 'stopped', onFailure: 'stop' }),
    );
    expect(decision.planRun).toMatchObject({
      state: 'failed',
      message: 'The run for U1 was stopped, so no further unit was started',
    });
  });

  it('leaves the unit and starts the next ready one that does not depend on it when planRunOnFailure is skip', () => {
    const decision = advancePlanRun(
      planRun({ units: [started('U1')] }),
      input({ unitRunState: 'failed', onFailure: 'skip' }),
    );
    // U2 depends on U1 and stays waiting; U3 does not.
    expect(decision.start?.unitKey).toBe('U3');
    expect(decision.planRun.units).toEqual([started('U1', 'failed'), started('U3')]);

    const after = advancePlanRun(
      decision.planRun,
      input({ unitRunState: 'done', onFailure: 'skip' }),
    );
    expect(after.start).toBeUndefined();
    expect(after.planRun).toMatchObject({
      state: 'waiting',
      waitingFor: [
        'The run for U1 failed',
        'U2 waits for U1 to merge',
        'No pull request found for U3',
      ],
    });
  });
});

describe('ending (spec 44, 45)', () => {
  it('is done when every unit is delivered', () => {
    const decision = advancePlanRun(
      planRun({ state: 'waiting', units: [started('U2', 'done')], waitingFor: ['x'] }),
      input({ units: units('delivered', 'delivered', 'delivered') }),
    );
    expect(decision.planRun).toMatchObject({
      state: 'done',
      waitingFor: [],
      message: null,
      endedAt: T1,
    });
  });

  it('is not done because a plan that lost its units has none left', () => {
    const decision = advancePlanRun(planRun({ state: 'waiting' }), input({ units: [] }));
    expect(decision.planRun).toMatchObject({
      state: 'waiting',
      waitingFor: ['The plan has no units to read'],
    });
  });

  it('fails when the plan is gone', () => {
    const decision = advancePlanRun(planRun({ state: 'waiting' }), input({ units: undefined }));
    expect(decision.planRun).toMatchObject({
      state: 'failed',
      message: 'The plan is no longer there',
    });
  });

  it('stops: the unit that was running is marked stopped and nothing starts afterwards', () => {
    const stopped = stopPlanRun(planRun({ units: [started('U1')] }), T1);
    expect(stopped).toMatchObject({
      state: 'stopped',
      units: [started('U1', 'stopped')],
      endedAt: T1,
    });
    const decision = advancePlanRun(stopped, input({ unitRunState: 'stopped' }));
    expect(decision.planRun).toBe(stopped);
    expect(decision.start).toBeUndefined();
    expect(() => stopPlanRun(stopped, T1)).toThrow(RunRejected);
  });
});

describe('refusing a start (spec 46, 47)', () => {
  const workflow: Workflow = {
    id: 'wf1',
    name: 'Deliver',
    templateKind: null,
    steps: [],
    forUnits: true,
    createdAt: T0,
    updatedAt: T0,
  };
  const intent: PlanIntent = {
    id: 'tea:2026-01-tea-timer',
    projectId: 'tea',
    intentId: '2026-01-tea-timer',
    title: 'A tea timer',
    hasIntent: true,
    status: 'accepted',
    rev: 1,
    spec: { rev: 1, status: 'accepted', stale: null },
    plan: { rev: 1, status: 'accepted', stale: null },
    source: 'files',
    units: units('ready', 'waiting', 'ready'),
    problems: [],
    followed: true,
  };
  const start = { intent, workflow, staleReason: null, liveOnPlan: false };

  it('lets a followed, current plan in files start with a workflow for units', () => {
    expect(planRunRefusal(start)).toBeUndefined();
  });

  it('refuses a stale plan or spec with the stale file named', () => {
    expect(
      planRunRefusal({
        ...start,
        staleReason: 'plan.md is stale (built on spec@1, spec.md is at rev 2)',
      }),
    ).toBe('Not started: plan.md is stale (built on spec@1, spec.md is at rev 2)');
  });

  it('refuses a plan with source: issues', () => {
    expect(planRunRefusal({ ...start, intent: { ...intent, source: 'issues' } })).toMatch(
      /source: issues/,
    );
  });

  it('refuses a workflow that is not for units', () => {
    expect(planRunRefusal({ ...start, workflow: { ...workflow, forUnits: false } })).toBe(
      'Workflow Deliver is not marked "For units"; turn that on in the builder first',
    );
  });

  it('refuses a second plan run on the same plan', () => {
    expect(planRunRefusal({ ...start, liveOnPlan: true })).toMatch(/one unit at a time/);
  });

  it('refuses a plan that is gone, not followed, without units or fully delivered', () => {
    expect(planRunRefusal({ ...start, intent: undefined })).toMatch(/no longer there/);
    expect(planRunRefusal({ ...start, intent: { ...intent, followed: false } })).toMatch(
      /^Follow the plan first/,
    );
    expect(planRunRefusal({ ...start, intent: { ...intent, units: [] } })).toBe(
      'This plan has no units',
    );
    expect(
      planRunRefusal({
        ...start,
        intent: { ...intent, units: units('delivered', 'delivered', 'delivered') },
      }),
    ).toBe('Every unit of this plan is delivered');
  });
});

const step = (id: string) => ({
  id,
  skillName: id,
  providerInstanceId: 'claude-work',
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
});

describe('the unit in the step prompt (spec 40)', () => {
  const workflow: Workflow = {
    id: 'wf1',
    name: 'Deliver',
    templateKind: null,
    steps: [step('deliver-work'), step('check-work')],
    forUnits: true,
    createdAt: T0,
    updatedAt: T0,
  };
  const context = {
    now: T1,
    handoverTemplate: defaultHandoverTemplate,
    sendBackTemplate: defaultSendBackTemplate,
    unitPromptTemplate: defaultUnitPromptTemplate,
    verdictApprovedLine: 'APPROVED',
    alwaysStopSkills: [],
    gateChecksTimeoutMinutes: 30,
    invocationFor: (s: { skillName: string }) => `/${s.skillName}`,
  };
  const runUnit = {
    planRunId: 'pr1',
    planId: 'tea:2026-01-tea-timer',
    intentId: '2026-01-tea-timer',
    unitKey: 'U1',
    title: 'Count down',
  };

  it('gives the step the intent id, unit key and title through the unit template', () => {
    const { run, effects } = startRun(
      workflow,
      { runId: 'pr1.U1', projectId: 'tea', unit: runUnit },
      context,
    );
    expect(run.unit).toEqual(runUnit);
    expect(effects).toEqual([
      expect.objectContaining({
        type: 'startStep',
        prompt: [
          '/deliver-work',
          '',
          'This run delivers one unit of a plan.',
          '',
          'Intent: 2026-01-tea-timer',
          'Unit: U1 Count down',
          '',
          'When you open a pull request for it, put this line in its body: Intent-Unit: 2026-01-tea-timer/U1',
        ].join('\n'),
      }),
    ]);
  });

  it('uses the template as it is set, and says nothing about a unit in a run without one', () => {
    const custom = startRun(
      workflow,
      { runId: 'r2', projectId: 'tea', unit: runUnit },
      { ...context, unitPromptTemplate: '{{intentId}}/{{unitKey}}: {{unitTitle}}' },
    );
    expect(custom.effects[0]).toMatchObject({
      prompt: '/deliver-work\n\n2026-01-tea-timer/U1: Count down',
    });
    const plain = startRun(workflow, { runId: 'r3', projectId: 'tea' }, context);
    expect(plain.run.unit).toBeUndefined();
    expect(plain.effects[0]).toMatchObject({ prompt: '/deliver-work' });
  });
});
