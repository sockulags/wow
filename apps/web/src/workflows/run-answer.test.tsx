import type { Project, Thread, Workflow, WorkflowRun } from '@wow/contracts';
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
import { runStateLabel } from './model';

// A run whose step waits for an answer says so where runs are listed and in the run view
// (questions-and-models spec 7), from the step thread's state the server keeps. Invented data.

const T = '2026-11-11T08:00:00.000Z';

const project: Project = {
  id: 'demo',
  name: 'Demo',
  cwd: '/home/me/demo',
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: T,
};

const workflow: Workflow = {
  id: 'w',
  name: 'Brew the tea',
  templateKind: null,
  createdAt: T,
  updatedAt: T,
  steps: [
    {
      id: 'check',
      skillName: 'check-work',
      providerInstanceId: 'mock',
      model: 'mock-model',
      effort: 'default',
      permissionMode: 'default',
      gateBefore: false,
      gateAfter: false,
      expectedArtifacts: [],
    },
  ],
};

const run: WorkflowRun = {
  id: 'run-1',
  workflowId: 'w',
  projectId: 'demo',
  calendarItemId: null,
  backlogItemId: null,
  state: 'running',
  currentStep: 0,
  baseSha: null,
  baseFiles: null,
  steps: [
    {
      stepId: 'check',
      state: 'running',
      threadId: 'run-1.check',
      startedAt: T,
      artifactsFound: [],
    },
  ],
  startedAt: T,
  endedAt: null,
};

const thread = (state: Thread['state']): Thread => ({
  id: 'run-1.check',
  projectId: 'demo',
  cwd: project.cwd,
  branch: null,
  providerInstanceId: 'mock',
  providerSessionId: null,
  title: 'check',
  model: 'mock-model',
  effort: 'default',
  permissionMode: 'default',
  state,
  pinned: false,
  runId: 'run-1',
  stepId: 'check',
  createdAt: T,
  updatedAt: T,
});

function fake(threads: readonly Thread[]): Runtime {
  const topics: Readonly<Record<string, readonly unknown[]>> = {
    workflowRuns: [run],
    workflows: [workflow],
    projects: [project],
    threads,
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: () => Promise.resolve([]),
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
      createMemorySettingsSource(undefined, {
        'providers.offerSetup': false,
        'appearance.contextPanel': true,
      }),
    ),
  };
}

describe('a run whose step waits for an answer (spec 7)', () => {
  it('says so only while the running step thread needs you', () => {
    expect(runStateLabel(run, [thread('needs_you')])).toBe('Waiting for an answer');
    expect(runStateLabel(run, [thread('working')])).toBe('Running');
    expect(runStateLabel(run)).toBe('Running');
  });

  it('says so on its row in the list of runs and in the run view', async () => {
    await renderApp('/workflows/runs/run-1', fake([thread('needs_you')]));
    expect((await screen.findByTestId('run-state')).textContent).toBe('Waiting for an answer');
    const row = screen
      .getAllByRole('link', { name: /Brew the tea/ })
      .find((link) => link.getAttribute('href') === '/workflows/runs/run-1');
    expect(row && within(row).getByText('Waiting for an answer')).toBeTruthy();
  });
});

const panel = () => screen.getByRole('complementary', { name: 'Context panel' });

describe('the other lists of runs (spec 7)', () => {
  it("says so in the run's panel", async () => {
    await renderApp('/workflows/runs/run-1', fake([thread('needs_you')]));
    await screen.findByTestId('panel-run');
    expect(within(panel()).getByText(/^Waiting for an answer · Demo · /)).toBeTruthy();
  });

  it('says so in "Runs of this workflow" and in the workflow\'s panel', async () => {
    await renderApp('/workflows/w', fake([thread('needs_you')]));
    const section = await screen.findByRole('region', { name: 'Runs of this workflow' });
    expect(within(section).getByText('Waiting for an answer')).toBeTruthy();
    const runs = within(await screen.findByTestId('panel-workflow'));
    expect(runs.getByText(/^Waiting for an answer · /)).toBeTruthy();
    expect(runs.queryByText(/^Running · /)).toBeNull();
  });
});
