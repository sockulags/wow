import type {
  Command,
  PathVisit,
  Project,
  RunDiff,
  StepRule,
  Thread,
  Workflow,
  WorkflowRun,
} from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { activeStep } from '@/panel/model';
import { outbox } from '@/test/outbox';
import { renderApp } from '@/test/render';
import { stepUnderReview } from './changes';
import { workflowCommands } from './commands';
import { canSendBack, cancelSendBack } from './gate';
import { gateMessage, gateOf, reviewedStepIndex, stepDisplayState } from './model';
import { factsText, pathRows } from './path';

// The path a run took (workflow branches spec 9, 18, 19) against a fake server that records the
// commands it is sent. The data is invented: a kettle is built, reviewed, sent back by the
// review's rule and built again.

const at = (minute: number) => `2026-11-03T08:${String(minute).padStart(2, '0')}:00.000Z`;

const project: Project = {
  id: 'demo',
  name: 'Demo',
  cwd: '/home/me/demo',
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: at(0),
};

const changesRequested = { fact: 'verdict', is: 'changesRequested' } as const;
const backToBuild: StepRule = { when: changesRequested, goTo: { type: 'step', stepId: 'build' } };

const step = (id: string, skillName: string, rules?: StepRule[]) => ({
  id,
  skillName,
  providerInstanceId: 'mock',
  model: 'mock-model',
  effort: 'default',
  permissionMode: 'default',
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
  ...(rules ? { rules } : {}),
});

const workflow: Workflow = {
  id: 'w',
  name: 'Build, review and wrap up',
  templateKind: null,
  createdAt: at(0),
  updatedAt: at(0),
  steps: [
    step('build', 'deliver-work'),
    step('review', 'check-work', [backToBuild]),
    step('wrap', 'learn-work'),
  ],
};

const visit = (
  stepId: string,
  attempt: number,
  from: number,
  overrides: Partial<PathVisit> = {},
): PathVisit => ({
  stepId,
  attempt,
  startedAt: at(from),
  endedAt: at(from + 2),
  ended: 'done',
  next: null,
  reason: null,
  ...overrides,
});

const toBuild = {
  to: { type: 'step', stepId: 'build' },
  by: 'rule',
  when: changesRequested,
} as const;
const byList = (stepId: string) => ({ to: { type: 'step', stepId }, by: 'list' }) as const;

// The review sent the work back once and then approved; the wrap-up step runs.
const looped: WorkflowRun = {
  id: 'run-1',
  workflowId: 'w',
  projectId: 'demo',
  calendarItemId: null,
  backlogItemId: null,
  state: 'running',
  currentStep: 2,
  baseSha: '1f3c9a7d2b4e6f8091a2b3c4d5e6f708192a3b4c',
  baseFiles: [],
  steps: [
    {
      stepId: 'build',
      state: 'done',
      threadId: 'run-1.build',
      startedAt: at(4),
      endedAt: at(6),
      artifactsFound: [],
      attempt: 2,
      finalMessage: 'The lid is tight now.',
      fileHashes: [
        { path: 'src/kettle.ts', hash: 'k1' },
        { path: 'src/lid.ts', hash: 'l2' },
      ],
    },
    {
      stepId: 'review',
      state: 'done',
      threadId: 'run-1.review',
      startedAt: at(6),
      endedAt: at(8),
      artifactsFound: [],
      attempt: 2,
      finalMessage: 'The lid holds.\n\nAPPROVED',
      facts: { verdict: 'approved', artifacts: 'found' },
      fileHashes: [
        { path: 'src/kettle.ts', hash: 'k1' },
        { path: 'src/lid.ts', hash: 'l2' },
      ],
    },
    {
      stepId: 'wrap',
      state: 'running',
      threadId: 'run-1.wrap',
      startedAt: at(8),
      artifactsFound: [],
    },
  ],
  path: [
    visit('build', 1, 0, { next: byList('review'), reason: 'next step' }),
    visit('review', 1, 2, { next: toBuild, reason: 'verdict changes requested → deliver-work' }),
    visit('build', 2, 4, { next: byList('review'), reason: 'next step' }),
    visit('review', 2, 6, { next: byList('wrap'), reason: 'no rule held → next step' }),
    visit('wrap', 1, 8, { endedAt: null, ended: null }),
  ],
  startedAt: at(0),
  endedAt: null,
};

const limitSentence = 'deliver-work has run 3 times: the limit';

// The review asked for changes a third time, and build has started three times.
const atLimit: WorkflowRun = {
  ...looped,
  state: 'waiting',
  currentStep: 0,
  steps: [
    {
      ...looped.steps[0]!,
      state: 'waiting',
      attempt: 3,
      gate: {
        state: 'waitingAtLimit',
        parts: [],
        detail: limitSentence,
        since: at(12),
        at: at(12),
      },
    },
    {
      ...looped.steps[1]!,
      attempt: 3,
      finalMessage: 'The lid is loose again.\n\nCHANGES_REQUESTED',
      facts: { verdict: 'changesRequested', artifacts: 'found' },
    },
    { stepId: 'wrap', state: 'not_started', artifactsFound: [] },
  ],
  path: [
    ...looped.path!.slice(0, 3),
    visit('review', 2, 6, { next: toBuild, reason: 'verdict changes requested → deliver-work' }),
    visit('build', 3, 8, { next: byList('review'), reason: 'next step' }),
    visit('review', 3, 10, {
      next: toBuild,
      reason: 'verdict changes requested → deliver-work',
      limit: limitSentence,
    }),
  ],
};

const thread = (stepId: string): Thread => ({
  id: `run-1.${stepId}`,
  projectId: 'demo',
  cwd: project.cwd,
  branch: null,
  providerInstanceId: 'mock',
  providerSessionId: null,
  title: `Build, review and wrap up: ${stepId}`,
  model: 'mock-model',
  effort: 'default',
  permissionMode: 'default',
  state: 'done',
  pinned: false,
  runId: 'run-1',
  stepId,
  createdAt: at(0),
  updatedAt: at(8),
});

// What the server answers for the looped run: the second attempt of build changed the lid only.
const diff: RunDiff = {
  status: 'ok',
  message: null,
  baseSha: looped.baseSha ?? null,
  files: [
    { path: 'src/kettle.ts', changedBy: [] },
    { path: 'src/lid.ts', changedBy: ['build'] },
  ].map((file) => ({
    ...file,
    oldPath: null,
    status: 'modified' as const,
    content: 'text' as const,
    added: 1,
    removed: 1,
    size: 120,
  })),
  omitted: 0,
  patch: null,
};

function fake(runRow: WorkflowRun) {
  const dispatches = outbox<Command>();
  const sent = dispatches.sent;
  const diffs = outbox<unknown>();
  const topics: Readonly<Record<string, unknown[]>> = {
    workflowRuns: [runRow],
    workflows: [workflow],
    projects: [project],
    threads: ['build', 'review', 'wrap'].map(thread),
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      if (method === 'workflowRuns.detectArtifacts') return Promise.resolve(runRow);
      if (method === 'workflowRuns.diff') {
        diffs.record(params);
        return Promise.resolve(diff);
      }
      if (method !== 'dispatch') return Promise.resolve([]);
      const { command, commandId } = params as { command: Command; commandId: string };
      dispatches.record(command);
      return Promise.resolve({ commandId, seqs: [sent.length], duplicate: false });
    },
    subscribe(topic, _params, onData) {
      onData(topics[topic] ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  const runtime: Runtime = {
    connection,
    layout: createLayoutStore(),
    draft: createDraftStore(),
    settings: createSettingsStore(
      createMemorySettingsSource(undefined, { 'providers.offerSetup': false }),
    ),
  };
  return { runtime, sent, untilSent: dispatches.until, untilDiff: diffs.until };
}

const texts = (root: HTMLElement, testId: string) =>
  within(root)
    .queryAllByTestId(testId)
    .map((node) => node.textContent);

const runCommands = (open: WorkflowRun, search: Record<string, unknown> = {}) =>
  workflowCommands({
    workflows: [workflow],
    runs: [open],
    templates: [],
    openRun: open,
    runView: { runId: open.id, search, changedFiles: [], project },
  });

beforeEach(cancelSendBack);

const pathKeyCommands = (search: Record<string, unknown>) =>
  runCommands(looped, search)
    .filter((command) => command.keybinding === 'keybindings.runPath')
    .map((command) => [command.id, command.title]);

describe('the Path tab', () => {
  it('lists build 1, review 1, build 2 and review 2 with why the run went on (spec 18)', async () => {
    await renderApp('/workflows/runs/run-1?tab=path', fake(looped).runtime);
    const list = await screen.findByRole('list', { name: 'Run path' });
    const rows = within(list).getAllByTestId('path-visit');
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'Visit 1: deliver-work, attempt 1',
      'Visit 2: check-work, attempt 1',
      'Visit 3: deliver-work, attempt 2',
      'Visit 4: check-work, attempt 2',
      'Visit 5: learn-work, attempt 1',
    ]);
    expect(texts(list, 'path-state')).toEqual(['Done', 'Done', 'Done', 'Done', 'Running']);
    expect(texts(list, 'path-why')).toEqual([
      'next step',
      'verdict changes requested → deliver-work',
      'next step',
      'verdict approved: no rule held → next step',
    ]);
    // Every visit of a step opens the one thread the step has.
    expect(within(rows[2]!).getByRole('link', { name: 'Open thread' }).getAttribute('href')).toBe(
      '/chat/run-1.build',
    );
    const tabs = within(screen.getByRole('tablist', { name: 'Run' }));
    expect(tabs.getByRole('tab', { name: 'Path' }).getAttribute('aria-selected')).toBe('true');
  });

  it('says so for a run without a path and for one that has not started a step', async () => {
    const { path: _none, ...before } = looped;
    expect(pathRows(before, workflow)).toBeUndefined();
    const view = await renderApp('/workflows/runs/run-1?tab=path', fake(before).runtime);
    expect(await screen.findByText('No path kept')).toBeTruthy();
    view.unmount();

    await renderApp('/workflows/runs/run-1?tab=path', fake({ ...looped, path: [] }).runtime);
    expect(await screen.findByText('No step has started yet')).toBeTruthy();
  });

  it('says what a visit waits for, that the user sent it back or stopped it, and names a step that is gone', () => {
    const why = (run: WorkflowRun) => pathRows(run, workflow)?.map((row) => row.why);
    const waiting: WorkflowRun = {
      ...looped,
      state: 'waiting',
      currentStep: 0,
      steps: [{ ...looped.steps[0]!, state: 'waiting' }, ...looped.steps.slice(1)],
      path: [visit('build', 1, 0)],
    };
    expect(why(waiting)).toEqual(['waiting for you']);
    expect(
      why({
        ...waiting,
        steps: [
          {
            ...waiting.steps[0]!,
            gate: {
              state: 'waitingForChecks',
              parts: [{ part: 'checks', state: 'pending', detail: 'Not read yet' }],
              since: at(2),
              at: at(2),
            },
          },
          ...waiting.steps.slice(1),
        ],
      }),
    ).toEqual(['waiting for checks']);
    const stopped: WorkflowRun = {
      ...looped,
      state: 'stopped',
      path: [
        visit('build', 1, 0, {
          next: { to: { type: 'step', stepId: 'build' }, by: 'user' },
          reason: 'you sent it back',
        }),
        visit('gone', 1, 2, { ended: 'stopped', reason: 'you stopped the run' }),
      ],
    };
    expect(pathRows(stopped, workflow)).toMatchObject([
      { stepName: 'deliver-work', stepNumber: 1, state: 'done', why: 'you sent it back' },
      { stepName: 'gone', stepNumber: undefined, state: 'stopped', why: 'you stopped the run' },
    ]);
    // An earlier attempt's facts are gone, so only the reason the engine kept is shown.
    expect(why(looped)?.[1]).toBe('verdict changes requested → deliver-work');
    expect(factsText(workflow.steps[1], { verdict: 'none', artifacts: 'missing' })).toBe(
      'no verdict',
    );
  });

  it('switches between Steps and Path from the palette with one key', () => {
    expect(pathKeyCommands({})).toEqual([['workflowRun.tab.path', 'Run: show path']]);
    expect(pathKeyCommands({ tab: 'changes' })).toEqual([
      ['workflowRun.tab.path', 'Run: show path'],
    ]);
    expect(pathKeyCommands({ tab: 'path' })).toEqual([
      ['workflowRun.tab.steps', 'Run: show steps'],
    ]);
  });
});

describe('a step that ran more than once (spec 19)', () => {
  it('says the attempt on its row, and "this step" in Changes marks what the latest attempt changed', async () => {
    // The review's second attempt has not ended yet: build is the step that ended last.
    const reviewing: WorkflowRun = {
      ...looped,
      currentStep: 1,
      steps: [
        looped.steps[0]!,
        {
          ...looped.steps[1]!,
          state: 'running',
          fileHashes: [{ path: 'src/kettle.ts', hash: 'k1' }],
        },
        { stepId: 'wrap', state: 'not_started', artifactsFound: [] },
      ],
      path: [...looped.path!.slice(0, 3), visit('review', 2, 6, { endedAt: null, ended: null })],
    };
    expect(stepUnderReview(reviewing)?.stepId).toBe('build');

    const view = await renderApp('/workflows/runs/run-1', fake(reviewing).runtime);
    const steps = await screen.findByRole('list', { name: 'Run steps' });
    const rows = within(steps).getAllByTestId('run-step');
    expect(rows.map((row) => texts(row, 'step-attempt'))).toEqual([
      ['Attempt 2'],
      ['Attempt 2'],
      [],
    ]);
    view.unmount();

    const changes = fake(reviewing);
    await renderApp('/workflows/runs/run-1?tab=changes', changes.runtime);
    const only = await screen.findByLabelText(/This step only/);
    expect(only.closest('span')?.textContent).toContain(
      'This step only (deliver-work, attempt 2, 1)',
    );
    fireEvent.click(only);
    const files = await screen.findByRole('navigation', { name: 'Changed files' });
    await act(() => changes.untilDiff((asked) => asked.length > 0));
    expect(within(files).queryByText(/kettle\.ts/)).toBeNull();
    expect(within(files).getByText(/lid\.ts/)).toBeTruthy();
  });

  it('shows a step a rule went past as skipped', async () => {
    const skipped: WorkflowRun = {
      ...looped,
      steps: [
        looped.steps[0]!,
        { stepId: 'review', state: 'skipped', artifactsFound: [] },
        looped.steps[2]!,
      ],
    };
    await renderApp('/workflows/runs/run-1', fake(skipped).runtime);
    const steps = await screen.findByRole('list', { name: 'Run steps' });
    expect(texts(steps, 'step-state')).toEqual(['Done', 'Skipped', 'Running']);
  });
});

describe('waiting at the limit (spec 9)', () => {
  it('reads the gate from the path: before build, coming from the review', () => {
    expect(gateOf(atLimit)).toEqual({ stepIndex: 0, position: 'before', limit: limitSentence });
    expect(reviewedStepIndex(atLimit)).toBe(1);
    expect(activeStep(atLimit)).toEqual({ index: 1, threadId: 'run-1.review' });
    expect(stepUnderReview(atLimit)?.stepId).toBe('review');
    expect(canSendBack(atLimit)).toBe(false);
    expect(stepDisplayState(atLimit.steps[0]!, true)).toBe('waiting');
    expect(gateMessage(gateOf(atLimit)!, workflow)).toBe(
      'deliver-work has run 3 times: the limit. Run once more starts it again; Stop ends the run.',
    );

    // A gate before a step the run comes back to waits the same way, without the limit.
    const { gate: _limit, ...build } = atLimit.steps[0]!;
    const { limit: _waited, ...last } = atLimit.path!.at(-1)!;
    const gateBefore: WorkflowRun = {
      ...atLimit,
      steps: [build, ...atLimit.steps.slice(1)],
      path: [...atLimit.path!.slice(0, -1), last],
    };
    expect(gateOf(gateBefore)).toEqual({ stepIndex: 0, position: 'before' });
    expect(reviewedStepIndex(gateBefore)).toBe(1);
    expect(canSendBack(gateBefore)).toBe(true);
    expect(gateMessage(gateOf(gateBefore)!, workflow)).toBe(
      'Waiting for you before deliver-work starts.',
    );

    // After a step with rules, Approve does not name the next step: its rules choose.
    const afterReview: WorkflowRun = {
      ...atLimit,
      currentStep: 1,
      steps: [looped.steps[0]!, { ...atLimit.steps[1]!, state: 'waiting' }, atLimit.steps[2]!],
      path: [...atLimit.path!.slice(0, -1), visit('review', 3, 10)],
    };
    expect(gateOf(afterReview)).toEqual({ stepIndex: 1, position: 'after' });
    expect(gateMessage(gateOf(afterReview)!, workflow)).toBe(
      'check-work finished. Approve lets its rules choose the next step.',
    );
  });

  it('shows the limit sentence in the gate bar with Run once more and Stop', async () => {
    const { runtime, sent, untilSent } = fake(atLimit);
    await renderApp('/workflows/runs/run-1', runtime);
    const panel = await screen.findByRole('complementary', { name: 'Context panel' });
    const bar = within(panel).getByRole('region', { name: 'Gate' });
    expect(bar.textContent).toContain(
      'deliver-work has run 3 times: the limit. Run once more starts it again; Stop ends the run.',
    );
    expect(
      within(bar)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Run once more', 'Stop']);

    // The step row says the same, and the run waits before it.
    const steps = screen.getByRole('list', { name: 'Run steps' });
    const [build] = within(steps).getAllByTestId('run-step');
    expect(texts(build!, 'step-state')).toEqual(['Waiting']);
    expect(texts(build!, 'step-attempt')).toEqual(['Attempt 3']);
    expect(texts(build!, 'step-limit')).toEqual([limitSentence]);
    expect(steps.firstElementChild?.getAttribute('data-testid')).toBe('gate-marker');

    const offered = runCommands(atLimit).filter((command) =>
      ['workflowRun.approve', 'workflowRun.sendBack', 'workflowRun.stop'].includes(command.id),
    );
    expect(offered.map((command) => [command.title, command.keybinding])).toEqual([
      ['Run: run once more', 'keybindings.gateApprove'],
      ['Stop run', 'keybindings.stopRun'],
    ]);

    fireEvent.click(within(bar).getByRole('button', { name: 'Run once more' }));
    await act(() => untilSent((commands) => commands.length > 0));
    expect(sent).toEqual([{ type: 'workflowRun.continue', runId: 'run-1' }]);
  });

  it('says in the path that the run reached the limit and waits, or waited', async () => {
    await renderApp('/workflows/runs/run-1?tab=path', fake(atLimit).runtime);
    const list = await screen.findByRole('list', { name: 'Run path' });
    expect(texts(list, 'path-why').at(-1)).toBe(
      'verdict changes requested → deliver-work · limit reached, waiting for you',
    );
    expect(texts(list, 'path-limit')).toEqual([limitSentence]);

    // The user let build run once more.
    const again: WorkflowRun = {
      ...atLimit,
      state: 'running',
      path: [...atLimit.path!, visit('build', 4, 12, { endedAt: null, ended: null })],
    };
    expect(pathRows(again, workflow)?.at(-2)?.why).toBe(
      'verdict changes requested → deliver-work · limit reached, waited for you',
    );
  });
});
