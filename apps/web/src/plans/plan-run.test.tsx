import type { PlanIntent, PlanRun, PlanUnit, Project, Workflow, WorkflowRun } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import type { CommandContext } from '@/app/commands';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { renderApp } from '@/test/render';
import { workflowCommands } from '@/workflows/commands';
import { planCommands } from './commands';
import {
  livePlanRun,
  planRunUnitLabel,
  runReadyUnitsBlocked,
  shownPlanRun,
  unitWorkflows,
} from './model';
import { planRunStore } from './plan-run';

// The plan run above a plan's units (review loop spec 40, 41, 45) with invented rows. The
// server decides everything; these tests cover what the view says and sends.

const T0 = '2026-11-03T08:00:00.000Z';
const planId = 'tea:2026-01-tea-timer';

const project: Project = {
  id: 'tea',
  name: 'Tea',
  cwd: '/home/me/tea',
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: T0,
};

const unit = (key: string, title: string, status: PlanUnit['status']): PlanUnit => ({
  key,
  title,
  line: 3,
  dependsOn: key === 'U2' ? ['U1'] : [],
  blocked: null,
  contract: null,
  status,
  statusReason: '',
  changeRequestId: null,
});

const intent: PlanIntent = {
  id: planId,
  projectId: 'tea',
  intentId: '2026-01-tea-timer',
  title: 'Tea timer',
  hasIntent: true,
  status: 'accepted',
  rev: 1,
  spec: { rev: 1, status: 'accepted', stale: null },
  plan: { rev: 1, status: 'accepted', stale: null },
  source: 'files',
  units: [
    unit('U1', 'Count down', 'claimed'),
    unit('U2', 'Ring the bell', 'waiting'),
    unit('U3', 'Show the time left', 'ready'),
  ],
  problems: [],
  followed: true,
};

const workflow = (id: string, name: string, forUnits = true): Workflow => ({
  id,
  name,
  templateKind: null,
  steps: [],
  forUnits,
  createdAt: T0,
  updatedAt: T0,
});

const planRun = (overrides: Partial<PlanRun> = {}): PlanRun => ({
  id: 'pr1',
  planId,
  projectId: 'tea',
  intentId: '2026-01-tea-timer',
  workflowId: 'deliver',
  state: 'waiting',
  units: [{ unitKey: 'U1', title: 'Count down', runId: 'pr1.U1', outcome: 'done' }],
  waitingFor: ['U1 waits for its pull request to merge', 'U2 waits for U1 to merge'],
  message: null,
  startedAt: '2026-11-03T09:00:00.000Z',
  endedAt: null,
  ...overrides,
});

const unitRun = (state: WorkflowRun['state']): WorkflowRun => ({
  id: 'pr1.U3',
  workflowId: 'deliver',
  projectId: 'tea',
  calendarItemId: null,
  backlogItemId: null,
  state,
  currentStep: 0,
  steps: [],
  startedAt: T0,
  endedAt: null,
});

interface Sent {
  readonly method: string;
  readonly params: unknown;
}

// What a test's connection was asked to do. `dispatched` settles when a command has been sent,
// so a test waits for the event and not for time.
interface Outbox {
  readonly sent: Sent[];
  readonly dispatched: Promise<void>;
  readonly noteDispatch: () => void;
}

function outbox(): Outbox {
  const box = { sent: [] as Sent[], noteDispatch: () => undefined as void };
  const dispatched = new Promise<void>((resolve) => {
    box.noteDispatch = resolve;
  });
  return { ...box, dispatched, noteDispatch: () => box.noteDispatch() };
}

function runtimeWith(
  topics: Readonly<Record<string, unknown[]>>,
  box: Outbox = outbox(),
  refuse?: string,
): Runtime {
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: (method: string, params: unknown) => {
      box.sent.push({ method, params });
      if (method === 'dispatch') box.noteDispatch();
      return refuse !== undefined && method === 'dispatch'
        ? Promise.reject(new Error(refuse))
        : Promise.resolve({ commandId: 'c', seqs: [], duplicate: false });
    },
    subscribe(topic, _params, onData) {
      onData(topics[topic] ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  } as Connection;
  return {
    connection,
    layout: createLayoutStore(),
    draft: createDraftStore(),
    settings: createSettingsStore(
      createMemorySettingsSource(undefined, { 'providers.offerSetup': false }),
    ),
  };
}

const commandsSent = ({ sent }: Outbox) =>
  sent
    .filter((entry) => entry.method === 'dispatch')
    .map((entry) => (entry.params as { command: Record<string, unknown> }).command);

const base = { planIntents: [intent], projects: [project] };

afterEach(() => planRunStore.setState({ stopping: undefined, error: undefined }));

describe('which plan run a plan shows', () => {
  const ended = planRun({ id: 'old', state: 'stopped', endedAt: T0, startedAt: T0 });
  const later = planRun({ id: 'new', state: 'done', startedAt: '2026-11-04T09:00:00.000Z' });

  it('shows the live one, else the one started last, and none of another plan', () => {
    const live = planRun({ id: 'live', state: 'running' });
    expect(shownPlanRun([ended, live, later], planId)?.id).toBe('live');
    expect(livePlanRun([ended, later], planId)).toBeUndefined();
    expect(shownPlanRun([ended, later], planId)?.id).toBe('new');
    expect(shownPlanRun([planRun({ planId: 'tea:other' })], planId)).toBeUndefined();
  });

  it('offers only workflows marked for units, by name', () => {
    const offered = unitWorkflows([
      workflow('z', 'Ship'),
      workflow('n', 'Notes', false),
      workflow('a', 'Deliver'),
    ]);
    expect(offered.map((entry) => entry.name)).toEqual(['Deliver', 'Ship']);
  });

  it('says why Run ready units is not offered', () => {
    const workflows = [workflow('deliver', 'Deliver')];
    expect(runReadyUnitsBlocked(intent, [], workflows)).toBeUndefined();
    expect(runReadyUnitsBlocked(intent, [planRun()], workflows)).toBe(
      'A plan run is going on this plan',
    );
    expect(runReadyUnitsBlocked({ ...intent, followed: false }, [], workflows)).toMatch(
      /^Follow the plan first/,
    );
    expect(runReadyUnitsBlocked(intent, [], [workflow('n', 'Notes', false)])).toBe(
      'Turn on “For units” in a workflow first',
    );
    expect(runReadyUnitsBlocked({ ...intent, plan: null }, [], workflows)).toBe(
      'This intent has no plan.md',
    );
  });

  it('says how a unit of the plan run stands, with its run’s gate', () => {
    const going = { unitKey: 'U3', title: 'Show', runId: 'pr1.U3', outcome: 'running' } as const;
    expect(planRunUnitLabel(going, unitRun('running'))).toBe('Running');
    expect(planRunUnitLabel(going, unitRun('waiting'))).toBe('Waiting for you');
    expect(planRunUnitLabel({ ...going, outcome: 'failed' }, unitRun('failed'))).toBe('Failed');
    expect(planRunUnitLabel({ ...going, outcome: 'done' }, undefined)).toBe('Done');
  });
});

describe('the plan run above the units', () => {
  it('starts a plan run with the only workflow for units', async () => {
    const sent = outbox();
    await renderApp(
      '/plans/tea/2026-01-tea-timer',
      runtimeWith(
        { ...base, planRuns: [], workflows: [workflow('deliver', 'Deliver')], workflowRuns: [] },
        sent,
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Run ready units' }));
    await sent.dispatched;
    expect(commandsSent(sent)).toEqual([
      expect.objectContaining({ type: 'planRun.start', planId, workflowId: 'deliver' }),
    ]);
    expect(screen.queryByTestId('plan-run')).toBeNull();
  });

  it('shows what the server said when it refuses the start', async () => {
    await renderApp(
      '/plans/tea/2026-01-tea-timer',
      runtimeWith(
        { ...base, planRuns: [], workflows: [workflow('deliver', 'Deliver')], workflowRuns: [] },
        undefined,
        'Not started: plan.md is stale (built on spec@1, spec.md is at rev 2)',
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Run ready units' }));
    expect((await screen.findByTestId('plan-run-error')).textContent).toBe(
      'Not started: plan.md is stale (built on spec@1, spec.md is at rev 2)',
    );
  });

  it('shows the state, what it waits for and the unit runs with links, and stops after asking', async () => {
    const sent = outbox();
    await renderApp(
      '/plans/tea/2026-01-tea-timer',
      runtimeWith(
        {
          ...base,
          planRuns: [planRun()],
          workflows: [workflow('deliver', 'Deliver')],
          workflowRuns: [],
        },
        sent,
      ),
    );
    const region = await screen.findByRole('region', { name: 'Plan run' });
    expect(within(region).getByTestId('plan-run-state').textContent).toBe('Waiting');
    expect(
      [...within(region).getByTestId('plan-run-waiting').querySelectorAll('li')].map(
        (item) => item.textContent,
      ),
    ).toEqual(['U1 waits for its pull request to merge', 'U2 waits for U1 to merge']);
    const link = within(region).getByRole('link', { name: 'U1 Count down' });
    expect(link.getAttribute('href')).toBe('/workflows/runs/pr1.U1');
    expect(within(region).getByTestId('plan-run-unit-U1').textContent).toContain('Done');
    // One unit at a time: no second plan run while this one is live.
    const startButton = screen.getByRole('button', { name: 'Run ready units' });
    expect(startButton.hasAttribute('disabled')).toBe(true);

    fireEvent.click(within(region).getByRole('button', { name: 'Stop' }));
    expect(commandsSent(sent)).toEqual([]);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await sent.dispatched;
    expect(commandsSent(sent)).toEqual([{ type: 'planRun.stop', planRunId: 'pr1' }]);
  });

  it('says why a plan run stopped after a failure', async () => {
    await renderApp(
      '/plans/tea/2026-01-tea-timer',
      runtimeWith({
        ...base,
        planRuns: [
          planRun({
            state: 'failed',
            waitingFor: [],
            message: 'The run for U1 failed, so no further unit was started',
            units: [{ unitKey: 'U1', title: 'Count down', runId: 'pr1.U1', outcome: 'failed' }],
            endedAt: '2026-11-03T09:30:00.000Z',
          }),
        ],
        workflows: [workflow('deliver', 'Deliver')],
        workflowRuns: [],
      }),
    );
    const region = await screen.findByRole('region', { name: 'Plan run' });
    expect(within(region).getByTestId('plan-run-state').textContent).toBe(
      'Stopped after a failure',
    );
    expect(within(region).getByTestId('plan-run-message').textContent).toBe(
      'The run for U1 failed, so no further unit was started',
    );
    expect(within(region).queryByRole('button', { name: 'Stop' })).toBeNull();
    const startButton = screen.getByRole('button', { name: 'Run ready units' });
    expect(startButton.hasAttribute('disabled')).toBe(false);
  });
});

describe('palette commands for a plan run', () => {
  const data = { intents: [intent], projects: [project], openIntent: intent };
  const ids = (planRuns: PlanRun[], workflows: Workflow[]) =>
    planCommands({ ...data, planRuns, workflows })
      .map((command) => command.id)
      .filter((id) => id.startsWith('plans.planRun.'));

  it('offers Run ready units with each workflow for units', () => {
    expect(
      ids(
        [],
        [workflow('deliver', 'Deliver'), workflow('n', 'Notes', false), workflow('s', 'Ship')],
      ),
    ).toEqual(['plans.planRun.start.deliver', 'plans.planRun.start.s']);
    expect(ids([], [workflow('n', 'Notes', false)])).toEqual([]);
  });

  it('offers Stop and the unit runs while a plan run is live, and sends what they say', async () => {
    expect(ids([planRun()], [workflow('deliver', 'Deliver')])).toEqual([
      'plans.planRun.stop',
      'plans.planRun.unit.U1',
    ]);
    const stop = planCommands({ ...data, planRuns: [planRun()], workflows: [] }).find(
      (command) => command.id === 'plans.planRun.stop',
    );
    stop?.run({} as CommandContext);
    expect(planRunStore.getState().stopping).toBe('pr1');

    const sent = outbox();
    const { connection } = runtimeWith({}, sent);
    const start = planCommands({
      ...data,
      planRuns: [],
      workflows: [workflow('deliver', 'Deliver')],
    }).find((command) => command.id === 'plans.planRun.start.deliver');
    expect(start?.title).toBe('Plan: run ready units with Deliver');
    start?.run({ connection } as CommandContext);
    await sent.dispatched;
    expect(commandsSent(sent)).toEqual([
      expect.objectContaining({ type: 'planRun.start', planId, workflowId: 'deliver' }),
    ]);
  });

  it('switches "For units" of a workflow from the palette', async () => {
    const sent = outbox();
    const { connection } = runtimeWith({}, sent);
    const command = workflowCommands({
      workflows: [workflow('deliver', 'Deliver', false)],
      runs: [],
      templates: [],
      openRun: undefined,
    }).find((entry) => entry.id === 'workflow.forUnits.deliver');
    expect(command?.title).toBe('Deliver: use for plan units');
    command?.run({ connection } as CommandContext);
    await sent.dispatched;
    expect(commandsSent(sent)).toEqual([
      { type: 'workflow.update', workflowId: 'deliver', forUnits: true },
    ]);
  });
});
