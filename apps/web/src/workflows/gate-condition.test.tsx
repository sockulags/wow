import type { Command, Project, StepGate, Thread, Workflow, WorkflowRun } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { renderApp } from '@/test/render';
import { workflowCommands } from './commands';
import {
  conditionOffered,
  draftOf,
  gateStanding,
  passedByItself,
  runStateLabel,
  setGate,
  stepsOf,
  toggleGatePart,
} from './model';

// Gates that pass by themselves (review loop spec 54 to 58) in the run view, the gate bar, the
// builder's model and the palette, against a fake server. The data is invented.

const T = '2026-11-02T08:05:00.000Z';

const project: Project = {
  id: 'demo',
  name: 'Demo',
  cwd: '/home/me/demo',
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: T,
};

const step = (id: string, skillName: string, more: Partial<Workflow['steps'][number]> = {}) => ({
  id,
  skillName,
  providerInstanceId: 'mock',
  model: 'mock-model',
  effort: 'default',
  permissionMode: 'default',
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
  ...more,
});

const workflow: Workflow = {
  id: 'w',
  name: 'Check and wrap up',
  templateKind: null,
  createdAt: T,
  updatedAt: T,
  steps: [
    step('check', 'check-work', { gateAfter: true, gateAfterCondition: ['verdict', 'checks'] }),
    step('plan', 'plan-work', { gateAfter: true }),
    step('wrap', 'learn-work'),
  ],
};

const gateOfState = (state: StepGate['state'], parts: StepGate['parts']): StepGate => ({
  state,
  parts,
  since: T,
  at: T,
});

const runWith = (gate: StepGate | undefined, passed = false): WorkflowRun => ({
  id: 'run-1',
  workflowId: 'w',
  projectId: 'demo',
  calendarItemId: null,
  backlogItemId: null,
  state: 'waiting',
  currentStep: passed ? 1 : 0,
  baseSha: null,
  baseFiles: null,
  steps: [
    {
      stepId: 'check',
      state: passed ? 'done' : 'waiting',
      threadId: 'run-1.check',
      startedAt: '2026-11-02T08:00:00.000Z',
      endedAt: T,
      artifactsFound: [],
      finalMessage: 'Looked at it.',
      ...(gate ? { gate } : {}),
    },
    passed
      ? {
          stepId: 'plan',
          state: 'waiting',
          threadId: 'run-1.plan',
          startedAt: T,
          endedAt: T,
          artifactsFound: [],
          finalMessage: 'The plan.',
        }
      : { stepId: 'plan', state: 'not_started', artifactsFound: [] },
    { stepId: 'wrap', state: 'not_started', artifactsFound: [] },
  ],
  startedAt: '2026-11-02T08:00:00.000Z',
  endedAt: null,
});

const failedVerdict = gateOfState('waitingForUser', [
  {
    part: 'verdict',
    state: 'failed',
    detail: 'The final message ends with "CHANGES_REQUESTED", not APPROVED',
  },
  { part: 'checks', state: 'pending', detail: 'Not looked at, because another part did not hold' },
]);
const waitingForChecks = gateOfState('waitingForChecks', [
  { part: 'verdict', state: 'held', detail: 'The final message ends with APPROVED' },
  {
    part: 'checks',
    state: 'pending',
    detail: 'Checks of pull request #14 are still running: test',
  },
]);
const failedCheck = gateOfState('waitingForUser', [
  { part: 'verdict', state: 'held', detail: 'The final message ends with APPROVED' },
  { part: 'checks', state: 'failed', detail: 'Pull request #14 has failing checks: test' },
]);
const passed = gateOfState('passedByItself', [
  { part: 'verdict', state: 'held', detail: 'The final message ends with APPROVED' },
  {
    part: 'checks',
    state: 'held',
    detail: 'Every check of pull request #14 is successful (test)',
  },
]);

function fake(run: WorkflowRun): Runtime {
  const thread = (stepId: string): Thread => ({
    id: `run-1.${stepId}`,
    projectId: 'demo',
    cwd: project.cwd,
    branch: null,
    providerInstanceId: 'mock',
    providerSessionId: null,
    title: stepId,
    model: 'mock-model',
    effort: 'default',
    permissionMode: 'default',
    state: 'needs_you',
    pinned: false,
    runId: 'run-1',
    stepId,
    createdAt: T,
    updatedAt: T,
  });
  const topics: Readonly<Record<string, unknown[]>> = {
    workflowRuns: [run],
    workflows: [workflow],
    projects: [project],
    threads: [thread('check'), thread('plan')],
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method) {
      if (method === 'workflowRuns.detectArtifacts') return Promise.resolve(run);
      return Promise.resolve([]);
    },
    subscribe(topic, _params, onData) {
      onData(topics[topic] ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  return {
    connection,
    layout: createLayoutStore(),
    draft: createDraftStore(),
    settings: createSettingsStore(
      createMemorySettingsSource(undefined, { 'providers.offerSetup': false }),
    ),
  };
}

const gateBar = async () =>
  within(
    within(await screen.findByRole('complementary', { name: 'Context panel' })).getByRole(
      'region',
      { name: 'Gate' },
    ),
  );

describe('the gate bar at a gate with a condition', () => {
  it('names the verdict part when the last line was not the approved one (spec 55)', async () => {
    await renderApp('/workflows/runs/run-1', fake(runWith(failedVerdict)));
    const bar = await gateBar();
    expect(bar.getByTestId('gate-condition').textContent).toContain(
      'Did not pass by itself: Approved verdict.',
    );
    const parts = within(bar.getByRole('list', { name: 'Gate condition' })).getAllByRole(
      'listitem',
    );
    expect(parts.map((part) => [part.dataset['state'], part.textContent])).toEqual([
      [
        'failed',
        'Approved verdict (does not hold): The final message ends with "CHANGES_REQUESTED", not APPROVED',
      ],
      [
        'pending',
        'Checks successful (not decided): Not looked at, because another part did not hold',
      ],
    ]);
    expect(bar.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByTestId('run-state').textContent).toBe('Waiting for you');
  });

  it('names the failing check (spec 55)', async () => {
    await renderApp('/workflows/runs/run-1', fake(runWith(failedCheck)));
    const bar = await gateBar();
    expect(bar.getByTestId('gate-condition').textContent).toContain(
      'Did not pass by itself: Checks successful.',
    );
    expect(bar.getByTestId('gate-condition').textContent).toContain(
      'Pull request #14 has failing checks: test',
    );
  });

  it('says that the run waits for checks, in the bar, the run state and the step list (spec 56)', async () => {
    await renderApp('/workflows/runs/run-1', fake(runWith(waitingForChecks)));
    const bar = await gateBar();
    expect(bar.getByTestId('gate-condition').textContent).toContain(
      'Waiting for checks. The gate passes by itself when they are successful; Approve passes it now.',
    );
    expect(bar.getByTestId('gate-condition').textContent).toContain(
      'Checks of pull request #14 are still running: test',
    );
    expect(screen.getByTestId('run-state').textContent).toBe('Waiting for checks');
    expect(screen.getByTestId('gate-marker').textContent).toBe('Waiting for checks');
  });

  it('says nothing more at a gate without a condition', async () => {
    await renderApp('/workflows/runs/run-1', fake(runWith(undefined)));
    const bar = await gateBar();
    expect(bar.queryByTestId('gate-condition')).toBeNull();
    expect(screen.getByTestId('gate-marker').textContent).toBe('Waiting for you');
  });
});

describe('a step whose gate passed by itself (spec 58)', () => {
  it('shows "passed by itself" with the parts that held', async () => {
    await renderApp('/workflows/runs/run-1', fake(runWith(passed, true)));
    const row = within((await screen.findAllByTestId('run-step'))[0] as HTMLElement);
    expect(row.getByTestId('step-state').textContent).toBe('Done');
    expect(row.getByTestId('step-gate').textContent).toContain(
      'Passed by itself: Approved verdict, Checks successful',
    );
    expect(
      within(row.getByRole('list', { name: 'Why the gate after check-work passed' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'The final message ends with APPROVED',
      'Every check of pull request #14 is successful (test)',
    ]);
    // The plan step after it waits at its own gate and passed nothing.
    expect(screen.getAllByTestId('step-gate')).toHaveLength(1);
  });

  it('is not said of a gate the user passed or one that still waits', () => {
    const [byUser] = runWith({ ...passed, state: 'passedByUser' }, true).steps;
    const [waiting] = runWith(waitingForChecks).steps;
    expect(byUser && passedByItself(byUser)).toBeUndefined();
    expect(waiting && passedByItself(waiting)).toBeUndefined();
    expect(gateStanding(runWith(passed, true))).toBeUndefined();
    expect(runStateLabel(runWith(passed, true))).toBe('Waiting for you');
  });
});

describe("the builder's condition", () => {
  const draft = draftOf(workflow);
  const [check, plan] = draft.steps;

  it('is offered for a gate after a step, and never for a skill that always stops (spec 57)', () => {
    expect(conditionOffered({ skillName: 'check-work', gateAfter: true }, [])).toBe(true);
    expect(conditionOffered({ skillName: 'check-work', gateAfter: false }, [])).toBe(false);
    for (const skillName of ['capture-intent', 'plan-work', 'design-work', 'shape-work']) {
      // The four still stop when the setting no longer lists them.
      expect(conditionOffered({ skillName, gateAfter: true }, [])).toBe(false);
    }
    expect(conditionOffered({ skillName: 'agent-os-core:plan-work', gateAfter: true }, [])).toBe(
      false,
    );
    expect(conditionOffered({ skillName: 'write-spec', gateAfter: true }, ['write-spec'])).toBe(
      false,
    );
  });

  it('turns parts on and off in a fixed order and drops an empty condition', () => {
    const withArtifacts = toggleGatePart(check!, 'artifacts');
    expect(withArtifacts.gateAfterCondition).toEqual(['verdict', 'checks', 'artifacts']);
    const onlyChecks = toggleGatePart(toggleGatePart(withArtifacts, 'verdict'), 'artifacts');
    expect(onlyChecks.gateAfterCondition).toEqual(['checks']);
    expect('gateAfterCondition' in toggleGatePart(onlyChecks, 'checks')).toBe(false);
    expect(toggleGatePart(plan!, 'verdict').gateAfterCondition).toEqual(['verdict']);
  });

  it('takes the condition away with the gate', () => {
    const without = setGate(draft, 1);
    expect(without.steps[0]).toMatchObject({ gateAfter: false });
    expect('gateAfterCondition' in (without.steps[0] ?? {})).toBe(false);
    expect(setGate(without, 1).steps[0]?.gateAfterCondition).toBeUndefined();
  });

  it('saves a condition only where one is offered', () => {
    const edited = {
      ...draft,
      steps: [
        check!,
        // The skill was changed to one that always stops after its parts were chosen.
        { ...plan!, gateAfterCondition: ['verdict' as const] },
        { ...draft.steps[2]!, gateAfterCondition: ['checks' as const] },
      ],
    };
    const saved = stepsOf(edited, []);
    expect(saved[0]?.gateAfterCondition).toEqual(['verdict', 'checks']);
    expect(saved[1] && 'gateAfterCondition' in saved[1]).toBe(false);
    expect(saved[2] && 'gateAfterCondition' in saved[2]).toBe(false);
    expect(stepsOf(draft, ['check-work'])[0]?.gateAfterCondition).toBeUndefined();
  });
});

const commands = (alwaysStopSkills: readonly string[] = []) =>
  workflowCommands({
    workflows: [workflow],
    runs: [],
    templates: [],
    openRun: undefined,
    alwaysStopSkills,
  }).filter((command) => command.id.startsWith('workflow.gateCondition.'));

describe('palette commands for the condition', () => {
  it('offers one per part of a gate that may pass by itself, none for plan-work or a step without a gate', () => {
    expect(commands().map((command) => [command.id, command.title])).toEqual([
      [
        'workflow.gateCondition.w.check.verdict',
        'Check and wrap up: gate after check-work no longer needs approved verdict',
      ],
      [
        'workflow.gateCondition.w.check.checks',
        'Check and wrap up: gate after check-work no longer needs checks successful',
      ],
      [
        'workflow.gateCondition.w.check.artifacts',
        'Check and wrap up: gate after check-work passes by itself with expected artifacts found',
      ],
    ]);
    expect(commands(['check-work'])).toEqual([]);
  });

  it('sends the workflow with the part switched', async () => {
    const sent: Command[] = [];
    const connection = {
      request: (_method: string, params: { command: Command; commandId: string }) => {
        sent.push(params.command);
        return Promise.resolve({ commandId: params.commandId, seqs: [1], duplicate: false });
      },
    } as unknown as Connection;
    const [, , artifacts] = commands();
    artifacts?.run({ connection, navigate: () => Promise.resolve() } as never);
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'workflow.update', workflowId: 'w' });
    const steps = sent[0]?.type === 'workflow.update' ? sent[0].steps : undefined;
    expect(steps?.[0]?.gateAfterCondition).toEqual(['verdict', 'checks', 'artifacts']);
    expect(steps?.[1]).toEqual(workflow.steps[1]);
  });
});
