import type { Command, Project, Thread, Workflow, WorkflowRun } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
  type SettingValues,
} from '@wow/client-runtime';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { showSkillComposer } from '@/chat/composer-store';
import { commentInComposer } from '@/chat/thread-changes';
import { outbox } from '@/test/outbox';
import { renderApp } from '@/test/render';
import { firstChangedLine } from './changes';
import { cancelSendBack, gateStore } from './gate';
import { runsTabOrder } from './workflows-view';

// Run review polish (agent workbench spec 77 to 81, 94) against a fake server that records what
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
  baseSha: 'abc1234',
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
      fileHashes: [{ path: 'src/bell.ts', hash: 'h1' }],
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

const workflow = (id: string, name: string): Workflow => ({
  id,
  name,
  templateKind: null,
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
  steps: [step('build', 'deliver-work', true), step('review', 'check-work', false)],
});

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

const bellFile = {
  path: 'src/bell.ts',
  oldPath: null,
  status: 'modified' as const,
  content: 'text' as const,
  added: 2,
  removed: 1,
  size: 60,
  changedBy: ['build'],
};

const bellPatch = [
  '@@ -1,3 +1,4 @@',
  ' export const bell = () => {',
  '-  ding();',
  '+  ring();',
  '+  ring();',
  ' };',
  '',
].join('\n');

function fake(
  options: {
    readonly runs?: readonly WorkflowRun[];
    readonly workflows?: readonly Workflow[];
    readonly settings?: SettingValues;
  } = {},
) {
  const box = outbox<Command>();
  const requests = outbox<{ method: string; params: unknown }>();
  const topics: Readonly<Record<string, readonly unknown[]>> = {
    workflowRuns: options.runs ?? [run],
    workflows: options.workflows ?? [workflow('w', 'Build and review')],
    projects: [project],
    threads: [thread],
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      requests.record({ method, params });
      if (method === 'workflowRuns.detectArtifacts') return Promise.resolve(run);
      if (method === 'workflowRuns.diff') {
        const asked = (params as { path?: string }).path;
        return Promise.resolve({
          status: 'ok',
          message: null,
          baseSha: 'abc1234',
          files: [bellFile],
          omitted: 0,
          patch: asked === undefined ? null : bellPatch,
        });
      }
      if (method === 'files.openInEditor') {
        return Promise.resolve({ path: '/home/me/demo/src/bell.ts' });
      }
      if (method !== 'dispatch') return Promise.resolve([]);
      const { command, commandId } = params as { command: Command; commandId: string };
      box.record(command);
      return Promise.resolve({ commandId, seqs: [box.sent.length], duplicate: false });
    },
    subscribe(topic, _params, onData) {
      onData([...(topics[topic] ?? [])]);
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
        'providers.offerSetup': false,
        ...options.settings,
      }),
    ),
  };
  return { runtime, box, requests };
}

const panel = () => screen.queryByRole('complementary', { name: 'Context panel' });
const runGate = () => within(screen.getByTestId('run-gate')).getByRole('region', { name: 'Gate' });

// jsdom has no matchMedia; a narrow window is one whose max-width queries match.
function narrowWindow() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

beforeEach(cancelSendBack);
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the gate bar of a run view', () => {
  it('stays at the top of the run view, and the panel shows its copy only with the conversation (spec 77)', async () => {
    const user = userEvent.setup();
    await renderApp(route, fake().runtime);
    const top = await screen.findByTestId('run-gate');
    const tabs = screen.getByRole('tablist', { name: 'Run' });
    expect(top.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(runGate()).getByRole('button', { name: 'Approve' })).toBeTruthy();
    // The panel's conversation tab carries its own copy.
    const side = panel();
    expect(side).not.toBeNull();
    expect(within(side as HTMLElement).getByRole('region', { name: 'Gate' })).toBeTruthy();

    // A file in the panel takes the conversation's place, and its copy with it; the run view's
    // bar does not move.
    await user.click(
      screen.getAllByRole('button', { name: 'Open docs/kettle.md' })[0] as HTMLElement,
    );
    expect(await within(panel() as HTMLElement).findByTestId('file-viewer')).toBeTruthy();
    expect(within(panel() as HTMLElement).queryByRole('region', { name: 'Gate' })).toBeNull();
    expect(screen.getAllByRole('region', { name: 'Gate' })).toHaveLength(1);
    expect(within(runGate()).getByRole('button', { name: 'Send back' })).toBeTruthy();
  });

  it("opens the send-back note in the run view's bar only, also from the panel's copy", async () => {
    const user = userEvent.setup();
    await renderApp(route, fake().runtime);
    await screen.findByTestId('run-gate');
    const copy = within(panel() as HTMLElement).getByRole('region', { name: 'Gate' });
    await user.click(within(copy).getByRole('button', { name: 'Send back' }));
    const note = within(runGate()).getByRole('textbox', { name: 'What should change?' });
    expect(document.activeElement).toBe(note);
    expect(screen.getAllByRole('textbox', { name: 'What should change?' })).toHaveLength(1);
  });

  it('ends where a panel laid over the view begins and puts its buttons under its text (spec 78)', async () => {
    narrowWindow();
    const { runtime } = fake();
    await renderApp(route, runtime);
    const top = await screen.findByTestId('run-gate');
    expect(top.style.marginRight).toBe('');
    act(() => runtime.layout.setState({ contextPanelPeek: true }));
    expect(panel()?.hasAttribute('data-overlay')).toBe(true);
    expect(top.style.marginRight).toContain('min(380px');
    expect(within(top).getByTestId('gate-row').className).toContain('flex-col');
    for (const name of ['Approve', 'Send back', 'Stop']) {
      expect(within(runGate()).getByRole('button', { name })).toBeTruthy();
    }
  });
});

// A run of the fifth workflow in a state, started at a time.
const at = (id: string, state: WorkflowRun['state'], startedAt: string): WorkflowRun => ({
  ...run,
  id,
  workflowId: 'w5',
  state,
  startedAt,
  endedAt: state === 'done' ? startedAt : null,
});

describe('the Runs tab (spec 79)', () => {
  it('lists the waiting run first, whatever the number of workflows', async () => {
    const workflows = Array.from({ length: 12 }, (_, index) =>
      workflow(`w${index}`, `Workflow ${String(index + 1).padStart(2, '0')}`),
    );
    const runs = [
      at('done-new', 'done', '2026-11-03T09:00:00.000Z'),
      at('running', 'running', '2026-11-02T10:00:00.000Z'),
      at('waiting-old', 'waiting', '2026-11-01T08:00:00.000Z'),
    ];
    await renderApp('/workflows/runs', fake({ runs, workflows }).runtime);
    const tabs = within(await screen.findByRole('tablist', { name: 'Workflows view' }));
    expect(tabs.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Workflows',
      'Runs1',
      'Triggers',
    ]);
    expect(tabs.getByRole('tab', { name: /Runs/ }).getAttribute('aria-selected')).toBe('true');
    const list = within(screen.getByRole('region', { name: 'Runs' }));
    expect(
      list.getAllByTestId('run-row').map((row) => row.getAttribute('href')?.split('/').at(-1)),
    ).toEqual(['waiting-old', 'running', 'done-new']);
    expect(screen.queryByRole('region', { name: 'Workflow definitions' })).toBeNull();
    expect(runsTabOrder(runs).map((entry) => entry.id)).toEqual([
      'waiting-old',
      'running',
      'done-new',
    ]);
  });
});

describe('the Changes tab', () => {
  it('gathers line comments in the send-back note, which Ctrl+Shift+Enter sends (spec 80)', async () => {
    const user = userEvent.setup();
    const { runtime, box } = fake();
    await renderApp(`${route}?tab=changes`, runtime);
    const second = await screen.findByRole('row', { name: 'Line 2: ring();' });
    act(() => second.focus());
    await user.keyboard('c');
    await user.keyboard('Ring it twice{Enter}');
    expect(document.activeElement).toBe(second);
    await user.click(screen.getByRole('button', { name: 'Comment on line 4' }));
    await user.keyboard('Close the bell{Enter}');

    const note = within(runGate()).getByRole('textbox', {
      name: 'What should change?',
    }) as HTMLTextAreaElement;
    expect(note.value).toBe('src/bell.ts:2 – Ring it twice\nsrc/bell.ts:4 – Close the bell');
    await user.keyboard('{Control>}{Shift>}{Enter}{/Shift}{/Control}');
    await box.until((sent) => sent.some((command) => command.type === 'workflowRun.sendBack'));
    expect(box.sent.at(-1)).toEqual({
      type: 'workflowRun.sendBack',
      runId: 'run-1',
      note: 'src/bell.ts:2 – Ring it twice\nsrc/bell.ts:4 – Close the bell',
    });
  });

  it('puts a comment on a thread diff line into the thread composer (spec 80)', () => {
    const addText = vi.fn<(text: string) => void>();
    const hide = showSkillComposer({
      id: 'composer-1',
      draftKey: 't1',
      chips: [],
      openSkills: () => undefined,
      removeSkill: () => undefined,
      putBack: () => undefined,
      addText,
    });
    commentInComposer('t1', 'src/bell.ts', 12, 'Say why');
    expect(addText).toHaveBeenCalledWith('src/bell.ts:12 – Say why');
    hide();
  });

  it('opens a changed file in the editor at its first changed line with Shift+Enter (spec 81)', async () => {
    const user = userEvent.setup();
    const { runtime, requests } = fake();
    await renderApp(`${route}?tab=changes`, runtime);
    await screen.findByRole('row', { name: 'Line 2: ring();' });
    const file = screen.getByTestId('changed-file');
    act(() => file.focus());
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await requests.until((sent) => sent.some((entry) => entry.method === 'files.openInEditor'));
    expect(requests.sent.find((entry) => entry.method === 'files.openInEditor')?.params).toEqual({
      runId: 'run-1',
      path: 'src/bell.ts',
      line: 2,
    });
    // On a diff line it opens at that line.
    act(() => screen.getByRole('row', { name: 'Line 4: };' }).focus());
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await requests.until(
      (sent) => sent.filter((entry) => entry.method === 'files.openInEditor').length === 2,
    );
    expect(requests.sent.at(-1)?.params).toEqual({ runId: 'run-1', path: 'src/bell.ts', line: 4 });
    expect(gateStore.getState().sendBack).toBeUndefined();
  });

  it('marks "this step" with a dot and a tooltip, and resizes the split (spec 94)', async () => {
    const user = userEvent.setup();
    const { runtime } = fake();
    await renderApp(`${route}?tab=changes`, runtime);
    await screen.findByRole('row', { name: 'Line 2: ring();' });
    const marks = screen.getAllByTestId('this-step-mark');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((mark) => mark.textContent === 'This step')).toBe(true);
    expect(screen.queryByText('This step', { selector: '[data-slot="badge"]' })).toBeNull();

    const split = screen.getByRole('separator', { name: 'Resize changed files list' });
    expect(split.getAttribute('aria-valuenow')).toBe('288');
    act(() => split.focus());
    await user.keyboard('{ArrowRight}');
    expect(runtime.settings.getState().values['appearance.changesListWidth']).toBe(304);
    expect(screen.getByRole('navigation', { name: 'Changed files' }).style.width).toBe('304px');
  });

  it('reads the line "Open in editor" puts the cursor on', () => {
    expect(firstChangedLine(bellPatch)).toBe(2);
    expect(firstChangedLine('@@ -3,2 +3,1 @@\n a\n-b\n')).toBe(4);
    expect(firstChangedLine(null)).toBeUndefined();
  });
});
