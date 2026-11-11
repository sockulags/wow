import type { Command, Project, Thread, Workflow, WorkflowRun } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
  type SettingValues,
} from '@wow/client-runtime';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { renderApp } from '@/test/render';
import { validateRunSearch } from './changes';
import { workflowCommands } from './commands';
import {
  canSendBack,
  cancelSendBack,
  emptyNoteMessage,
  gateStore,
  openSendBack,
  sendBackDraft,
} from './gate';

// Review at a gate (review loop spec 14 to 18) against a fake server that records the commands
// it is sent. The data is invented.

const route = '/workflows/runs/run-1';

const project: Project = {
  id: 'demo',
  name: 'Demo',
  cwd: '/home/me/demo',
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: '2026-11-02T08:00:00.000Z',
};

const run: WorkflowRun = {
  id: 'run-1',
  workflowId: 'w',
  projectId: 'demo',
  calendarItemId: null,
  backlogItemId: null,
  state: 'waiting',
  currentStep: 0,
  baseSha: null,
  baseFiles: null,
  steps: [
    {
      stepId: 'build',
      state: 'waiting',
      threadId: 'run-1.build',
      startedAt: '2026-11-02T08:00:00.000Z',
      endedAt: '2026-11-02T08:05:00.000Z',
      artifactsFound: ['docs/kettle.md'],
      finalMessage: 'The kettle boils.',
    },
    { stepId: 'review', state: 'not_started', artifactsFound: [] },
  ],
  startedAt: '2026-11-02T08:00:00.000Z',
  endedAt: null,
};

const step = (id: string, skillName: string, gateAfter: boolean) => ({
  id,
  skillName,
  providerInstanceId: 'mock',
  model: 'mock-model',
  effort: 'default',
  permissionMode: 'default',
  gateBefore: false,
  gateAfter,
  expectedArtifacts: ['docs/*.md'],
});

const workflow: Workflow = {
  id: 'w',
  name: 'Build and review',
  templateKind: null,
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
  steps: [step('build', 'deliver-work', true), step('review', 'check-work', false)],
};

const thread: Thread = {
  id: 'run-1.build',
  projectId: 'demo',
  cwd: project.cwd,
  branch: null,
  providerInstanceId: 'mock',
  providerSessionId: null,
  title: 'Build and review: deliver-work',
  model: 'mock-model',
  effort: 'default',
  permissionMode: 'default',
  state: 'needs_you',
  pinned: false,
  runId: 'run-1',
  stepId: 'build',
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:05:00.000Z',
};

function fake(
  runRow: WorkflowRun = run,
  options: { readonly settings?: SettingValues; readonly refuse?: string } = {},
) {
  const sent: Command[] = [];
  const topics: Readonly<Record<string, unknown[]>> = {
    workflowRuns: [runRow],
    workflows: [workflow],
    projects: [project],
    threads: [thread],
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      if (method === 'workflowRuns.detectArtifacts') return Promise.resolve(runRow);
      if (method === 'workflowRuns.diff') {
        return Promise.resolve({
          status: 'noBase',
          message: null,
          baseSha: null,
          files: [],
          omitted: 0,
          patch: null,
        });
      }
      if (method !== 'dispatch') return Promise.resolve([]);
      const { command, commandId } = params as { command: Command; commandId: string };
      sent.push(command);
      return options.refuse === undefined
        ? Promise.resolve({ commandId, seqs: [sent.length], duplicate: false })
        : Promise.reject(new Error(options.refuse));
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
      createMemorySettingsSource(undefined, {
        // No provider instance is seeded; keep the first-run dialog out of the way.
        'providers.offerSetup': false,
        ...options.settings,
      }),
    ),
  };
  return { runtime, sent };
}

const panel = () => screen.findByRole('complementary', { name: 'Context panel' });
const gate = async () => within(await panel()).getByRole('region', { name: 'Gate' });

// The run commands offered for the open run, without the per-run entries.
const ids = (open: WorkflowRun, sendBackRunId?: string) =>
  workflowCommands({
    workflows: [workflow],
    runs: [open],
    templates: [],
    openRun: open,
    sendBackRunId,
  })
    .map((command) => command.id)
    .filter((id) => id.startsWith('workflowRun.') && !id.endsWith(open.id));

const tabTitles = (search: Record<string, unknown>) =>
  workflowCommands({
    workflows: [workflow],
    runs: [run],
    templates: [],
    openRun: run,
    runView: { runId: 'run-1', search, changedFiles: [], project },
  })
    .map((command) => command.title)
    .filter((title) => title.startsWith('Run: show'));

beforeEach(cancelSendBack);

describe('run view at a gate', () => {
  it('shows the review tabs in the main area and the conversation with the gate bar in the panel (spec 14)', async () => {
    await renderApp(route, fake().runtime);
    const tabs = within(await screen.findByRole('tablist', { name: 'Run' }));
    expect(tabs.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Steps',
      'Path',
      'Changes',
      'Artifacts',
      'Pull request',
      'Ticket',
      'Pages',
    ]);
    // The panel opens for the gate although the stored setting keeps it closed.
    const side = await panel();
    expect(within(side).getByTestId('panel-step-thread')).toBeTruthy();
    const bar = within(await gate());
    expect(bar.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(bar.getByRole('button', { name: 'Send back' })).toBeTruthy();
    expect(bar.getByRole('button', { name: 'Stop' })).toBeTruthy();
    // One gate bar: the main area keeps the width for the tabs.
    expect(screen.getAllByRole('region', { name: 'Gate' })).toHaveLength(1);
  });

  it('keeps the gate bar in the run view when the panel is closed', async () => {
    const user = userEvent.setup();
    const { runtime } = fake();
    await renderApp(route, runtime);
    await user.click(within(await panel()).getByRole('button', { name: 'Close context panel' }));
    expect(screen.queryByRole('complementary', { name: 'Context panel' })).toBeNull();
    const bar = within(screen.getByRole('region', { name: 'Gate' }));
    expect(bar.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(bar.getByTestId('gate-review').textContent).toContain('Last message from deliver-work');
    expect(runtime.settings.getState().values['appearance.contextPanel']).not.toBe(true);
  });

  it('does not open the panel for a run that is not waiting', async () => {
    const running: WorkflowRun = {
      ...run,
      state: 'running',
      steps: [{ stepId: 'build', state: 'running', threadId: 'run-1.build', artifactsFound: [] }],
    };
    await renderApp(route, fake(running).runtime);
    expect(await screen.findByRole('region', { name: 'Run controls' })).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Context panel' })).toBeNull();
  });

  it('lists the artifacts by step, and says so on a tab with nothing to show', async () => {
    const user = userEvent.setup();
    await renderApp(`${route}?tab=artifacts`, fake().runtime);
    const found = await screen.findByRole('list', { name: 'Artifacts of deliver-work' });
    expect(within(found).getByRole('button', { name: 'Open docs/kettle.md' })).toBeTruthy();

    for (const name of ['Pull request', 'Ticket', 'Pages']) {
      await user.click(screen.getByRole('tab', { name }));
      const shown = await screen.findByRole('tabpanel', { name });
      expect(within(shown).getByRole('heading', { name: 'Nothing to show yet' })).toBeTruthy();
    }
    expect(screen.getByRole('tab', { name: 'Pages' }).getAttribute('aria-selected')).toBe('true');
  });

  it('says so on the Artifacts tab of a run without found files', async () => {
    const bare = { ...run, steps: run.steps.map((entry) => ({ ...entry, artifactsFound: [] })) };
    await renderApp(`${route}?tab=artifacts`, fake(bare).runtime);
    const shown = await screen.findByRole('tabpanel', { name: 'Artifacts' });
    expect(within(shown).getByRole('heading', { name: 'Nothing to show yet' })).toBeTruthy();
  });

  it('shows the attempt of a step that was sent back', async () => {
    const again: WorkflowRun = {
      ...run,
      steps: [{ ...run.steps[0]!, attempt: 2 }, run.steps[1]!],
    };
    await renderApp(route, fake(again).runtime);
    expect((await screen.findByTestId('step-attempt')).textContent).toBe('Attempt 2');
    expect(within(await panel()).getByText(/· Attempt 2/)).toBeTruthy();
  });

  it('reads every tab from the address', () => {
    expect(validateRunSearch({ tab: 'artifacts', file: 'a' })).toEqual({ tab: 'artifacts' });
    expect(validateRunSearch({ tab: 'pullRequest' })).toEqual({ tab: 'pullRequest' });
    expect(validateRunSearch({ tab: 'ticket' })).toEqual({ tab: 'ticket' });
    expect(validateRunSearch({ tab: 'pages' })).toEqual({ tab: 'pages' });
    expect(validateRunSearch({ tab: 'steps' })).toEqual({});
  });
});

describe('Approve (spec 15)', () => {
  it('continues the run from the gate bar button', async () => {
    const user = userEvent.setup();
    const server = fake();
    await renderApp(route, server.runtime);
    await user.click(within(await gate()).getByRole('button', { name: 'Approve' }));
    expect(server.sent).toEqual([{ type: 'workflowRun.continue', runId: 'run-1' }]);
  });

  it('continues the run with the gateApprove key', async () => {
    const server = fake();
    await renderApp(route, server.runtime);
    await gate();
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter', ctrlKey: true });
    await waitFor(() =>
      expect(server.sent).toEqual([{ type: 'workflowRun.continue', runId: 'run-1' }]),
    );
  });

  it('continues the run from the palette command', async () => {
    const server = fake();
    const command = workflowCommands({
      workflows: [workflow],
      runs: [run],
      templates: [],
      openRun: run,
    }).find((entry) => entry.id === 'workflowRun.approve');
    expect(command).toMatchObject({ title: 'Run: approve', keybinding: 'keybindings.gateApprove' });
    command?.run({ connection: server.runtime.connection } as never);
    await waitFor(() =>
      expect(server.sent).toEqual([{ type: 'workflowRun.continue', runId: 'run-1' }]),
    );
  });
});

describe('Send back (spec 16 to 18)', () => {
  it('opens a note field in place and sends the note', async () => {
    const user = userEvent.setup();
    const server = fake();
    await renderApp(route, server.runtime);
    const bar = within(await gate());
    await user.click(bar.getByRole('button', { name: 'Send back' }));
    const note = bar.getByRole('textbox', { name: 'What should change?' });
    expect(document.activeElement).toBe(note);
    // Approve is off while a note is being written, by button and by key.
    expect(bar.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', true);
    await user.type(note, 'Name the kettle.');
    fireEvent.keyDown(note, { key: 'Enter', code: 'Enter', ctrlKey: true });
    expect(server.sent).toEqual([]);

    await user.click(bar.getByRole('button', { name: 'Send it back' }));
    expect(server.sent).toEqual([
      { type: 'workflowRun.sendBack', runId: 'run-1', note: 'Name the kettle.' },
    ]);
    await waitFor(() => expect(bar.queryByRole('textbox')).toBeNull());
  });

  it('refuses an empty note and sends nothing', async () => {
    const user = userEvent.setup();
    const server = fake();
    await renderApp(route, server.runtime);
    const bar = within(await gate());
    await user.click(bar.getByRole('button', { name: 'Send back' }));
    await user.type(bar.getByRole('textbox'), '   ');
    await user.click(bar.getByRole('button', { name: 'Send it back' }));
    expect(bar.getByRole('alert').textContent).toBe(emptyNoteMessage);
    expect(server.sent).toEqual([]);
    expect(bar.getByRole('textbox')).toBeTruthy();
  });

  it('opens the field with the gateSendBack key and sends the note with it', async () => {
    const user = userEvent.setup();
    const server = fake();
    await renderApp(route, server.runtime);
    const bar = within(await gate());
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true });
    const note = await bar.findByRole('textbox', { name: 'What should change?' });
    await user.type(note, 'Shorter.');
    fireEvent.keyDown(note, { key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true });
    await waitFor(() =>
      expect(server.sent).toEqual([
        { type: 'workflowRun.sendBack', runId: 'run-1', note: 'Shorter.' },
      ]),
    );
  });

  it('puts the field away with Escape or Cancel and keeps the run as it is', async () => {
    const user = userEvent.setup();
    const server = fake();
    await renderApp(route, server.runtime);
    const bar = within(await gate());
    await user.click(bar.getByRole('button', { name: 'Send back' }));
    await user.type(bar.getByRole('textbox'), 'Never mind{Escape}');
    expect(bar.queryByRole('textbox')).toBeNull();
    // The panel stays: Escape went to the note field only.
    expect(screen.getByRole('complementary', { name: 'Context panel' })).toBeTruthy();
    await user.click(bar.getByRole('button', { name: 'Send back' }));
    expect(bar.getByRole('textbox')).toHaveProperty('value', '');
    await user.click(bar.getByRole('button', { name: 'Cancel' }));
    expect(bar.queryByRole('textbox')).toBeNull();
    expect(server.sent).toEqual([]);
  });

  it('shows why the server refused and keeps the note', async () => {
    const user = userEvent.setup();
    const server = fake(run, { refuse: 'Run run-1 is running, not waiting for you' });
    await renderApp(route, server.runtime);
    const bar = within(await gate());
    await user.click(bar.getByRole('button', { name: 'Send back' }));
    await user.type(bar.getByRole('textbox'), 'Again.');
    await user.click(bar.getByRole('button', { name: 'Send it back' }));
    expect((await bar.findByRole('alert')).textContent).toBe(
      'Run run-1 is running, not waiting for you',
    );
    expect(bar.getByRole('textbox')).toHaveProperty('value', 'Again.');
  });

  it('is not offered before the first step or while the run works', () => {
    const before: WorkflowRun = {
      ...run,
      steps: [
        { stepId: 'build', state: 'waiting', artifactsFound: [] },
        { stepId: 'review', state: 'not_started', artifactsFound: [] },
      ],
    };
    expect(canSendBack(run)).toBe(true);
    expect(canSendBack(before)).toBe(false);
    expect(canSendBack({ ...run, state: 'running' })).toBe(false);
    expect(ids(before)).toEqual(['workflowRun.approve', 'workflowRun.stop']);
    expect(ids(run)).toEqual(['workflowRun.approve', 'workflowRun.sendBack', 'workflowRun.stop']);
    expect(ids(run, 'run-1')).toEqual([
      'workflowRun.sendBack',
      'workflowRun.sendBack.cancel',
      'workflowRun.stop',
    ]);
    // A note left open for another run does not change this one's commands.
    expect(ids(run, 'other')).toEqual([
      'workflowRun.approve',
      'workflowRun.sendBack',
      'workflowRun.stop',
    ]);
  });

  it('keeps one note per gate of a run', () => {
    openSendBack(run);
    gateStore.setState((state) => ({ sendBack: { ...state.sendBack!, note: 'kept' } }));
    openSendBack(run);
    expect(gateStore.getState().sendBack?.note).toBe('kept');
    expect(sendBackDraft(gateStore.getState(), run)?.note).toBe('kept');
    // Approved without sending: the run now waits after the next step, and the note written at
    // the first gate is not this gate's.
    const later: WorkflowRun = {
      ...run,
      currentStep: 1,
      steps: [
        { ...run.steps[0]!, state: 'done' },
        {
          stepId: 'review',
          state: 'waiting',
          threadId: 'run-1.review',
          startedAt: '2026-11-02T08:06:00.000Z',
          endedAt: '2026-11-02T08:09:00.000Z',
          artifactsFound: [],
        },
      ],
    };
    expect(sendBackDraft(gateStore.getState(), later)).toBeUndefined();
    openSendBack(later);
    expect(gateStore.getState().sendBack).toMatchObject({ runId: 'run-1', note: '' });
    openSendBack({ ...run, id: 'run-2' });
    expect(gateStore.getState().sendBack).toMatchObject({ runId: 'run-2', note: '' });
  });
});

describe('review tab commands', () => {
  it('offers every tab but the one on screen', () => {
    expect(tabTitles({})).toEqual([
      'Run: show changes',
      'Run: show path',
      'Run: show artifacts',
      'Run: show pull request',
      'Run: show ticket',
      'Run: show pages',
    ]);
    expect(tabTitles({ tab: 'ticket' })).toEqual([
      'Run: show changes',
      'Run: show steps',
      'Run: show path',
      'Run: show artifacts',
      'Run: show pull request',
      'Run: show pages',
    ]);
    expect(tabTitles({ tab: 'changes' })).toEqual([
      'Run: show steps',
      'Run: show path',
      'Run: show artifacts',
      'Run: show pull request',
      'Run: show ticket',
      'Run: show pages',
    ]);
  });
});
