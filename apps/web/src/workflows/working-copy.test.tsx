import type { Command, Project, Workflow, WorkflowRun, WorkingCopy } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { renderApp } from '@/test/render';
import { workflowCommands } from './commands';
import {
  canRemoveWorkingCopy,
  unpushedSummary,
  workingCopyStatus,
  workingCopyStore,
} from './working-copy';

// A run's own working copy in the run view (review loop spec 36 to 38) against a fake server
// that records what it is asked. The data is invented.

const route = '/workflows/runs/run-1';
const folder = '/home/me/.wow/workspaces/tea-timer-1a2b3c4d';

const project: Project = {
  id: 'tea',
  name: 'Tea timer',
  cwd: '/home/me/tea timer',
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: '2026-11-02T08:00:00.000Z',
};

const copy = (changes: Partial<WorkingCopy> = {}): WorkingCopy => ({
  path: folder,
  state: 'ready',
  startSha: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
  defaultBranch: 'main',
  note: null,
  unpushed: null,
  error: null,
  ...changes,
});

const kept = copy({
  state: 'kept',
  unpushed: {
    uncommittedFiles: 2,
    unpushedCommits: 1,
    newestSubject: 'Ring the bell at zero',
    branch: 'agent/u2-bell',
  },
});

const run = (workingCopy: WorkingCopy | null, changes: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'run-1',
  workflowId: 'w',
  projectId: 'tea',
  calendarItemId: null,
  backlogItemId: null,
  state: 'done',
  currentStep: 0,
  baseSha: null,
  baseFiles: null,
  workingCopy,
  steps: [
    {
      stepId: 'build',
      state: 'done',
      threadId: 'run-1.build',
      startedAt: '2026-11-02T08:00:00.000Z',
      endedAt: '2026-11-02T08:05:00.000Z',
      artifactsFound: ['docs/bell.md'],
      finalMessage: 'The bell rings.',
    },
  ],
  startedAt: '2026-11-02T08:00:00.000Z',
  endedAt: '2026-11-02T08:05:00.000Z',
  ...changes,
});

const workflow: Workflow = {
  id: 'w',
  name: 'Deliver a unit',
  templateKind: null,
  ownWorkingCopy: true,
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
  steps: [
    {
      id: 'build',
      skillName: 'deliver-work',
      providerInstanceId: 'mock',
      gateBefore: false,
      gateAfter: false,
      expectedArtifacts: ['docs/*.md'],
    },
  ],
};

function fake(runRow: WorkflowRun, refuse?: string) {
  const asked: { method: string; params: unknown }[] = [];
  const sent: Command[] = [];
  const listeners: ((rows: unknown[]) => void)[] = [];
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      asked.push({ method, params });
      if (method === 'workflowRuns.detectArtifacts') return Promise.resolve(runRow);
      if (method === 'workflowRuns.removeWorkingCopy') {
        if (refuse !== undefined) return Promise.reject(new Error(refuse));
        const removed = { ...runRow, workingCopy: copy({ state: 'removed' }) };
        for (const push of listeners) push([removed]);
        return Promise.resolve(removed);
      }
      if (method === 'dispatch') {
        const { command, commandId } = params as { command: Command; commandId: string };
        sent.push(command);
        return Promise.resolve({ commandId, seqs: [sent.length], duplicate: false });
      }
      return Promise.resolve([]);
    },
    subscribe(topic, _params, onData) {
      if (topic === 'workflowRuns') listeners.push(onData);
      const topics: Readonly<Record<string, unknown[]>> = {
        workflowRuns: [runRow],
        workflows: [workflow],
        projects: [project],
      };
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
  return { runtime, asked, sent };
}

const line = async () => within(await screen.findByRole('group', { name: 'Working copy' }));
const removals = (asked: readonly { method: string }[]) =>
  asked.filter((entry) => entry.method === 'workflowRuns.removeWorkingCopy');

const commands = (runs: WorkflowRun[], openRunId?: string) =>
  workflowCommands({
    workflows: [workflow],
    runs,
    templates: [],
    openRun: undefined,
    runView:
      openRunId === undefined
        ? undefined
        : { runId: openRunId, search: {}, changedFiles: [], project },
  });

beforeEach(() => workingCopyStore.setState({ removing: undefined }));

describe('working copy in the run view', () => {
  it('shows the folder a run works in and the note when it did not start at the fetched tip', async () => {
    const note =
      'Fetching origin failed (no route), so the working copy starts at the local tip of main.';
    await renderApp(route, fake(run(copy({ note }), { state: 'running', endedAt: null })).runtime);
    const shown = await line();
    expect(shown.getByTestId('working-copy-status').textContent).toBe(
      'Works in its own working copy',
    );
    expect(shown.getByTestId('path-text').textContent).toBe(folder);
    expect(shown.getByTestId('working-copy-note').textContent).toBe(note);
    expect(shown.queryByRole('button', { name: 'Remove working copy' })).toBeNull();
  });

  it('links artifacts to the working copy, not the project folder', async () => {
    const user = userEvent.setup();
    const { runtime } = fake(run(copy(), { state: 'running', endedAt: null }));
    await renderApp(route, runtime);
    await user.click(await screen.findByRole('button', { name: 'Open docs/bell.md' }));
    expect(runtime.layout.getState().viewer).toMatchObject({
      path: 'docs/bell.md',
      fullPath: `${folder}/docs/bell.md`,
    });
  });

  it('lists what a kept working copy holds and removes it after a confirmation (spec 37)', async () => {
    const user = userEvent.setup();
    const { runtime, asked } = fake(run(kept));
    await renderApp(route, runtime);
    const shown = await line();
    expect(shown.getByTestId('working-copy-status').textContent).toBe(
      'Working copy kept: 2 files not committed, 1 commit not pushed (on agent/u2-bell)',
    );
    expect(shown.getByText('Newest commit not pushed: Ring the bell at zero')).toBeTruthy();

    await user.click(shown.getByRole('button', { name: 'Remove working copy' }));
    const dialog = within(await screen.findByRole('alertdialog'));
    expect(dialog.getByText('Remove this working copy?')).toBeTruthy();
    expect(dialog.getByText(folder)).toBeTruthy();
    // Cancel removes nothing.
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(removals(asked)).toEqual([]);

    await user.click(shown.getByRole('button', { name: 'Remove working copy' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('working-copy-status').textContent).toBe('Working copy removed'),
    );
    expect(removals(asked)).toEqual([
      { method: 'workflowRuns.removeWorkingCopy', params: { runId: 'run-1' } },
    ]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(workingCopyStore.getState().removing).toBeUndefined();
  });

  it('says why a working copy could not be removed and keeps it listed', async () => {
    const user = userEvent.setup();
    const reason = 'The working copy could not be removed: a file in it is in use';
    await renderApp(route, fake(run(kept), reason).runtime);
    const shown = await line();
    await user.click(shown.getByRole('button', { name: 'Remove working copy' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    expect((await shown.findByRole('alert')).textContent).toBe(reason);
    expect(shown.getByRole('button', { name: 'Remove working copy' })).toBeTruthy();
  });

  it('shows nothing about a working copy for a run in the project folder', async () => {
    await renderApp(route, fake(run(null)).runtime);
    await screen.findByTestId('run-state');
    expect(screen.queryByRole('group', { name: 'Working copy' })).toBeNull();
  });
});

describe('working copy words', () => {
  it('says what is unpushed in one line', () => {
    expect(
      unpushedSummary({
        uncommittedFiles: 1,
        unpushedCommits: 0,
        newestSubject: null,
        branch: null,
      }),
    ).toBe('1 file not committed (on no branch)');
    expect(
      unpushedSummary({
        uncommittedFiles: 0,
        unpushedCommits: 3,
        newestSubject: 'x',
        branch: 'agent/u1',
      }),
    ).toBe('3 commits not pushed (on agent/u1)');
  });

  it('names every state', () => {
    expect(workingCopyStatus(run(null))).toBeUndefined();
    expect(workingCopyStatus(run(copy({ state: 'pending' })))).toBe('Making the working copy…');
    expect(workingCopyStatus(run(copy({ state: 'failed' })))).toBe('No working copy was made');
    expect(workingCopyStatus(run(copy({ state: 'removed' })))).toBe('Working copy removed');
    expect(workingCopyStatus(run(copy({ state: 'kept', error: 'locked' })))).toBe(
      'Working copy kept',
    );
  });

  it('lets only a kept working copy of an ended run be removed', () => {
    expect(canRemoveWorkingCopy(run(kept))).toBe(true);
    expect(canRemoveWorkingCopy(run(copy()))).toBe(false);
    expect(canRemoveWorkingCopy(run(kept, { state: 'waiting' }))).toBe(false);
    expect(canRemoveWorkingCopy(run(null))).toBe(false);
  });
});

describe('working copy palette commands', () => {
  it('lists every kept working copy as "Remove working copy", which opens the question on its run', () => {
    const other = { ...run(kept), id: 'run-2' };
    const listed = commands([run(kept), other, { ...run(copy()), id: 'run-3' }], 'run-1').filter(
      (command) => command.id.startsWith('workflowRun.removeWorkingCopy.'),
    );
    expect(listed.map((command) => [command.id, command.title, command.searchOnly])).toEqual([
      ['workflowRun.removeWorkingCopy.run-1', 'Remove working copy: Deliver a unit', false],
      ['workflowRun.removeWorkingCopy.run-2', 'Remove working copy: Deliver a unit', true],
    ]);
    const went: unknown[] = [];
    listed[1]?.run({ navigate: (to: unknown) => went.push(to) } as never);
    expect(workingCopyStore.getState().removing).toMatchObject({ runId: 'run-2', busy: false });
    expect(went).toEqual([{ to: '/workflows/runs/$runId', params: { runId: 'run-2' } }]);
  });

  it('switches "Own working copy" of a workflow from the palette', async () => {
    const { runtime, sent } = fake(run(null));
    const [toggle] = commands([]).filter((command) =>
      command.id.startsWith('workflow.ownWorkingCopy.'),
    );
    expect(toggle?.title).toBe('Deliver a unit: run in the project folder');
    toggle?.run({ connection: runtime.connection } as never);
    await waitFor(() =>
      expect(sent).toEqual([{ type: 'workflow.update', workflowId: 'w', ownWorkingCopy: false }]),
    );
  });
});
