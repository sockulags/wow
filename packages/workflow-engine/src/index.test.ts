import {
  defaultHandoverTemplate,
  type MissedTriggerPolicy,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
} from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import {
  advance,
  missedTriggerOutcome,
  pendingGate,
  renderHandover,
  RunRejected,
  startRun,
  stepPrompt,
  type EngineContext,
  type RunInput,
} from './index.js';

const T0 = '2026-11-02T08:00:00.000Z';
const T1 = '2026-11-02T09:00:00.000Z';

const step = (id: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  skillName: id,
  providerInstanceId: id === 'review' ? 'codex-work' : 'claude-work',
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
  ...overrides,
});

const workflow = (...steps: WorkflowStep[]): Workflow => ({
  id: 'wf1',
  name: 'Feature',
  templateKind: 'feature',
  steps,
  createdAt: T0,
  updatedAt: T0,
});

const context = (overrides: Partial<EngineContext> = {}): EngineContext => ({
  now: T1,
  handoverTemplate: defaultHandoverTemplate,
  invocationFor: (s) =>
    s.providerInstanceId.startsWith('codex') ? `$${s.skillName}` : `/${s.skillName}`,
  ...overrides,
});

const newRun = { runId: 'r1', projectId: 'p1' };

const completed = (stepId: string, finalMessage = `${stepId} finished`): RunInput => ({
  type: 'stepCompleted',
  stepId,
  finalMessage,
  artifactsFound: [],
});

// Starts the workflow and feeds it the inputs in order, returning the last transition.
function play(definition: Workflow, inputs: RunInput[], ctx = context()) {
  let transition = startRun(definition, newRun, ctx);
  for (const input of inputs) transition = advance(definition, transition.run, input, ctx);
  return transition;
}

const states = (run: WorkflowRun) => run.steps.map((entry) => entry.state);

describe('starting a run', () => {
  it('starts step one in its own thread with the skill invocation as prompt', () => {
    const { run, effects } = startRun(
      workflow(step('plan-work'), step('deliver-work')),
      newRun,
      context(),
    );
    expect(run).toMatchObject({ state: 'running', currentStep: 0, startedAt: T1, endedAt: null });
    expect(states(run)).toEqual(['running', 'not_started']);
    expect(run.steps[0]).toMatchObject({ threadId: 'r1.plan-work', startedAt: T1 });
    expect(effects).toEqual([
      {
        type: 'startStep',
        runId: 'r1',
        stepId: 'plan-work',
        threadId: 'r1.plan-work',
        prompt: '/plan-work',
      },
    ]);
  });

  it('waits before step one when it has a gate before (behavior 10)', () => {
    const { run, effects } = startRun(
      workflow(step('plan-work', { gateBefore: true })),
      newRun,
      context(),
    );
    expect(run.state).toBe('waiting');
    expect(states(run)).toEqual(['waiting']);
    expect(pendingGate(run)).toEqual({ stepIndex: 0, position: 'before' });
    expect(effects).toEqual([
      { type: 'notify', runId: 'r1', stepId: 'plan-work', reason: 'waiting' },
    ]);
  });

  it('refuses a workflow without steps', () => {
    expect(() => startRun(workflow(), newRun, context())).toThrow(RunRejected);
  });
});

// Every transition of a run, as a table: the workflow's steps, the inputs after starting, and the
// run and step states plus effect types that must result.
interface Row {
  readonly name: string;
  readonly steps: WorkflowStep[];
  readonly inputs: RunInput[];
  readonly runState: WorkflowRun['state'];
  readonly stepStates: string[];
  readonly effects: string[];
  readonly gate?: ReturnType<typeof pendingGate>;
}

const A = (o: Partial<WorkflowStep> = {}) => step('a', o);
const B = (o: Partial<WorkflowStep> = {}) => step('b', o);
const C = (o: Partial<WorkflowStep> = {}) => step('c', o);

const table: Row[] = [
  {
    name: 'step completes without gates: the next step starts',
    steps: [A(), B()],
    inputs: [completed('a')],
    runState: 'running',
    stepStates: ['done', 'running'],
    effects: ['setThreadState:r1.a:done', 'startStep:b'],
  },
  {
    name: 'step with a gate after completes: the run waits for you (behavior 9)',
    steps: [A({ gateAfter: true }), B()],
    inputs: [completed('a')],
    runState: 'waiting',
    stepStates: ['waiting', 'not_started'],
    effects: ['setThreadState:r1.a:needs_you', 'notify:waiting'],
    gate: { stepIndex: 0, position: 'after' },
  },
  {
    name: 'previous step completes before a step with a gate before: the run waits (behavior 10)',
    steps: [A(), B({ gateBefore: true })],
    inputs: [completed('a')],
    runState: 'waiting',
    stepStates: ['done', 'waiting'],
    effects: ['setThreadState:r1.a:needs_you', 'notify:waiting'],
    gate: { stepIndex: 1, position: 'before' },
  },
  {
    name: 'last step completes without a gate: the run is done',
    steps: [A(), B()],
    inputs: [completed('a'), completed('b')],
    runState: 'done',
    stepStates: ['done', 'done'],
    effects: ['setThreadState:r1.b:done', 'notify:done'],
  },
  {
    name: 'Continue after a gate after starts the next step (behavior 11)',
    steps: [A({ gateAfter: true }), B()],
    inputs: [completed('a'), { type: 'continue' }],
    runState: 'running',
    stepStates: ['done', 'running'],
    effects: ['setThreadState:r1.a:done', 'startStep:b'],
  },
  {
    name: 'one Continue passes a gate after followed by a gate before',
    steps: [A({ gateAfter: true }), B({ gateBefore: true })],
    inputs: [completed('a'), { type: 'continue' }],
    runState: 'running',
    stepStates: ['done', 'running'],
    effects: ['setThreadState:r1.a:done', 'startStep:b'],
  },
  {
    name: 'Continue at a gate before starts that step',
    steps: [A(), B({ gateBefore: true })],
    inputs: [completed('a'), { type: 'continue' }],
    runState: 'running',
    stepStates: ['done', 'running'],
    effects: ['setThreadState:r1.a:done', 'startStep:b'],
  },
  {
    name: 'Continue at a gate before step one starts it',
    steps: [A({ gateBefore: true })],
    inputs: [{ type: 'continue' }],
    runState: 'running',
    stepStates: ['running'],
    effects: ['startStep:a'],
  },
  {
    name: 'Continue after the last step with a gate after finishes the run',
    steps: [A({ gateAfter: true })],
    inputs: [completed('a'), { type: 'continue' }],
    runState: 'done',
    stepStates: ['done'],
    effects: ['setThreadState:r1.a:done', 'notify:done'],
  },
  {
    name: 'Stop at a gate after ends the run and keeps the thread',
    steps: [A({ gateAfter: true }), B()],
    inputs: [completed('a'), { type: 'stop' }],
    runState: 'stopped',
    stepStates: ['done', 'not_started'],
    effects: ['setThreadState:r1.a:done'],
  },
  {
    name: 'Stop at a gate before leaves that step not started',
    steps: [A(), B({ gateBefore: true })],
    inputs: [completed('a'), { type: 'stop' }],
    runState: 'stopped',
    stepStates: ['done', 'not_started'],
    effects: ['setThreadState:r1.a:done'],
  },
  {
    name: 'Stop while a step runs interrupts its turn',
    steps: [A(), B()],
    inputs: [{ type: 'stop' }],
    runState: 'stopped',
    stepStates: ['failed', 'not_started'],
    effects: ['interrupt:r1.a', 'setThreadState:r1.a:failed'],
  },
  {
    name: 'a failed step fails the run',
    steps: [A(), B()],
    inputs: [{ type: 'stepFailed', stepId: 'a', error: 'boom' }],
    runState: 'failed',
    stepStates: ['failed', 'not_started'],
    effects: ['setThreadState:r1.a:failed', 'notify:failed'],
  },
  {
    name: 'a three-step Feature-like run with two gates reaches done',
    steps: [A({ gateAfter: true }), B({ gateAfter: true }), C()],
    inputs: [
      completed('a'),
      { type: 'continue' },
      completed('b'),
      { type: 'continue' },
      completed('c'),
    ],
    runState: 'done',
    stepStates: ['done', 'done', 'done'],
    effects: ['setThreadState:r1.c:done', 'notify:done'],
  },
];

const describeEffect = (effect: ReturnType<typeof startRun>['effects'][number]): string => {
  switch (effect.type) {
    case 'startStep':
      return `startStep:${effect.stepId}`;
    case 'interrupt':
      return `interrupt:${effect.threadId}`;
    case 'setThreadState':
      return `setThreadState:${effect.threadId}:${effect.state}`;
    case 'notify':
      return `notify:${effect.reason}`;
  }
};

describe('run transitions', () => {
  it.each(table)('$name', (row) => {
    const { run, effects } = play(workflow(...row.steps), row.inputs);
    expect(run.state).toBe(row.runState);
    expect(states(run)).toEqual(row.stepStates);
    expect(effects.map(describeEffect)).toEqual(row.effects);
    expect(pendingGate(run)).toEqual(row.gate);
    const ended =
      row.runState === 'done' || row.runState === 'failed' || row.runState === 'stopped';
    expect(run.endedAt).toBe(ended ? T1 : null);
  });

  it('keeps the final message, artifacts and end time of a completed step', () => {
    const { run } = play(workflow(A({ gateAfter: true }), B()), [
      {
        type: 'stepCompleted',
        stepId: 'a',
        finalMessage: 'Spec written',
        artifactsFound: ['x.md'],
      },
    ]);
    expect(run.steps[0]).toMatchObject({
      finalMessage: 'Spec written',
      artifactsFound: ['x.md'],
      endedAt: T1,
    });
  });

  it('records the error of a failed step', () => {
    const { run } = play(workflow(A()), [{ type: 'stepFailed', stepId: 'a', error: 'boom' }]);
    expect(run.steps[0]).toMatchObject({ state: 'failed', error: 'boom', endedAt: T1 });
  });

  const rejected: [string, WorkflowStep[], RunInput[]][] = [
    ['Continue while a step runs', [A(), B()], [{ type: 'continue' }]],
    ['completion of a step that is not running', [A(), B()], [completed('b')]],
    [
      'completion while the run waits',
      [A({ gateAfter: true }), B()],
      [completed('a'), completed('a')],
    ],
    [
      'failure after the run is done',
      [A()],
      [completed('a'), { type: 'stepFailed', stepId: 'a', error: 'x' }],
    ],
    ['Stop after the run is done', [A()], [completed('a'), { type: 'stop' }]],
    [
      'Continue after Stop',
      [A({ gateAfter: true }), B()],
      [completed('a'), { type: 'stop' }, { type: 'continue' }],
    ],
    [
      'artifacts for an unknown step',
      [A()],
      [{ type: 'artifactsFound', found: [{ stepId: 'z', paths: [] }] }],
    ],
  ];

  it.each(rejected)('rejects %s', (_name, steps, inputs) => {
    expect(() => play(workflow(...steps), inputs)).toThrow(RunRejected);
  });

  it('rejects input when the workflow no longer has the run steps', () => {
    const { run } = startRun(workflow(A(), B()), newRun, context());
    expect(() => advance(workflow(A(), C()), run, completed('a'), context())).toThrow(
      /no longer has the steps/,
    );
  });

  it('stores artifacts found later without changing states', () => {
    const { run } = play(workflow(A({ gateAfter: true }), B()), [
      completed('a'),
      { type: 'artifactsFound', found: [{ stepId: 'a', paths: ['intents/x/spec.md'] }] },
    ]);
    expect(run.state).toBe('waiting');
    expect(run.steps[0]?.artifactsFound).toEqual(['intents/x/spec.md']);
  });
});

describe('step prompts and handover', () => {
  it('hands the previous final message and the expected artifacts to the next step (behavior 11)', () => {
    const steps = [
      A({ skillName: 'capture-intent', gateAfter: true }),
      step('review', {
        skillName: 'plan-work',
        extraPrompt: 'Keep it short.',
        expectedArtifacts: ['intents/*/plan.md'],
      }),
    ];
    const { effects } = play(workflow(...steps), [
      {
        type: 'stepCompleted',
        stepId: 'a',
        finalMessage: 'Wrote the spec.',
        artifactsFound: ['intents/x/spec.md'],
      },
      { type: 'continue' },
    ]);
    const start = effects.find((effect) => effect.type === 'startStep');
    expect(start?.type === 'startStep' && start.prompt).toBe(
      [
        '$plan-work Keep it short.',
        '',
        'The previous step (capture-intent) ended with:',
        '',
        'Wrote the spec.',
        '',
        'Artifacts from earlier steps:',
        '- intents/x/spec.md',
        '',
        'This step is expected to produce:',
        '- intents/*/plan.md',
      ].join('\n'),
    );
  });

  it('includes the backlog item body when the run has one', () => {
    const { effects } = startRun(workflow(A()), newRun, context({ backlogBody: 'Fix login' }));
    const start = effects[0];
    expect(start?.type === 'startStep' && start.prompt).toBe('/a\n\nBacklog item:\n\nFix login');
  });

  it('uses the configured handover template', () => {
    const { effects } = play(
      workflow(A(), B()),
      [completed('a', 'done here')],
      context({ handoverTemplate: 'From {{previousStep}}: {{previousMessage}} {{unknown}}' }),
    );
    const start = effects.find((effect) => effect.type === 'startStep');
    expect(start?.type === 'startStep' && start.prompt).toBe('/b\n\nFrom a: done here');
  });

  it('drops sections whose value is empty', () => {
    const values = {
      previousStep: '',
      previousMessage: '',
      backlogBody: '',
      previousArtifacts: '',
      expectedArtifacts: '- a.md',
    };
    expect(renderHandover(defaultHandoverTemplate, values)).toBe(
      'This step is expected to produce:\n- a.md',
    );
    expect(renderHandover('{{#backlogBody}}never{{/backlogBody}}', values)).toBe('');
  });

  it('joins invocation, extra prompt and handover', () => {
    expect(stepPrompt('/x', undefined, '')).toBe('/x');
    expect(stepPrompt('/x', '  go  ', '')).toBe('/x go');
    expect(stepPrompt('$x', 'go', 'more')).toBe('$x go\n\nmore');
  });
});

describe('missed trigger policies (behavior 12)', () => {
  const rows: [MissedTriggerPolicy, ReturnType<typeof missedTriggerOutcome>][] = [
    ['run', { triggerState: 'fired', startRun: true, offerRunNow: false }],
    ['mark', { triggerState: 'missed', startRun: false, offerRunNow: true }],
    ['skip', { triggerState: 'missed', startRun: false, offerRunNow: false }],
  ];
  it.each(rows)('%s', (policy, outcome) => {
    expect(missedTriggerOutcome(policy)).toEqual(outcome);
  });
});
