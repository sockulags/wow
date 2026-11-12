import type {
  Project,
  ProviderInstance,
  ProviderModel,
  TerminalSession,
  Thread,
} from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { renderApp, renderWithRuntime } from '@/test/render';
import { ModelName } from './model-label';
import { threadDefaults } from './new-thread';
import { openSessionTitle, sessionsByFolder } from './terminal-sessions';

// Agent workbench U14: sessions started in a terminal (spec 72), model labels (spec 86) and a
// project's defaults for a new thread (spec 97). Folders, prompts and models are invented.

const instance: ProviderInstance = {
  id: 'claude',
  kind: 'claude',
  name: 'Work Claude',
  binaryPath: 'claude',
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: null,
  defaultEffort: null,
  defaultPermissionMode: null,
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
};

const models: ProviderModel[] = [
  { id: 'kettle-large', label: 'Kettle Large', description: '', efforts: ['low', 'high'] },
  { id: 'kettle-small', label: 'Kettle Small', description: '', efforts: ['low'] },
];

const project: Project = {
  id: 'kettle',
  name: 'Kettle',
  cwd: '/work/kettle',
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: '2026-11-01T08:00:00.000Z',
};

const lastThread: Thread = {
  id: 'last',
  projectId: null,
  cwd: '/work/tea',
  branch: null,
  providerInstanceId: 'claude',
  providerSessionId: null,
  title: 'Tea',
  model: 'kettle-small',
  effort: 'low',
  permissionMode: 'default',
  state: 'idle',
  pinned: false,
  runId: null,
  stepId: null,
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
};

const session = (overrides: Partial<TerminalSession>): TerminalSession => ({
  id: 's-1',
  cwd: '/work/kettle',
  firstPrompt: 'Make the kettle whistle twice',
  lastUsedAt: '2026-11-03T08:00:00.000Z',
  providerInstanceId: 'claude',
  providerInstanceName: 'Work Claude',
  kind: 'claude',
  projectId: 'kettle',
  threadId: null,
  unavailable: null,
  ...overrides,
});

const sessions: TerminalSession[] = [
  session({}),
  session({
    id: 's-2',
    cwd: '/work/gone',
    firstPrompt: 'Brew in a folder that is gone',
    projectId: null,
    lastUsedAt: '2026-11-02T08:00:00.000Z',
    unavailable: 'Its folder is gone',
  }),
  session({ id: 's-3', firstPrompt: null, lastUsedAt: '2026-11-01T08:00:00.000Z' }),
];

function fakeServer() {
  const sent: unknown[] = [];
  const topics: Record<string, unknown[]> = {
    providerInstances: [instance],
    projects: [project],
    threads: [lastThread],
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      if (method === 'provider.listSessions') return Promise.resolve({ sessions });
      if (method === 'provider.listModels') return Promise.resolve(models);
      if (method === 'dispatch') {
        sent.push((params as { command: unknown }).command);
        return Promise.resolve({ commandId: 'c', seqs: [], duplicate: false });
      }
      return Promise.resolve([]);
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
  return { runtime, sent };
}

describe('Open session from Claude Code / Codex… (spec 72)', () => {
  it('groups sessions per folder in the order of their newest', () => {
    expect(
      sessionsByFolder(sessions, [project]).map((folder) => [
        folder.cwd,
        folder.project?.name,
        folder.sessions.map((entry) => entry.id),
      ]),
    ).toEqual([
      ['/work/kettle', 'Kettle', ['s-1', 's-3']],
      ['/work/gone', undefined, ['s-2']],
    ]);
  });

  it('lists the sessions per folder with first prompt and time, greys a gone folder, and opens a pick as a thread that resumes it', async () => {
    const user = userEvent.setup();
    const { runtime, sent } = fakeServer();
    const { router } = await renderApp('/chat', runtime);
    await user.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog');
    await user.type(within(palette).getByRole('combobox'), 'Open session from Claude Code');
    const option = within(palette).getByRole('option', { name: new RegExp(openSessionTitle) });
    expect(option.getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Enter}');

    // The palette is still closing, so the dialog is found by its rows, not by its role.
    const rows = await screen.findAllByTestId('terminal-session');
    const list = rows[0]!.closest('[cmdk-list]') as HTMLElement;
    expect(list.getAttribute('aria-label')).toBe('Sessions');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^Make the kettle whistle twice.*Claude Code · Work Claude · .*3 Nov/),
      expect.stringMatching(/^No prompt.*1 Nov/),
      expect.stringMatching(/^Brew in a folder that is gone.*Its folder is gone$/),
    ]);
    expect(within(list).getByText('Kettle · /work/kettle')).toBeTruthy();
    expect(within(list).getByText('/work/gone')).toBeTruthy();
    expect(rows[2]?.getAttribute('aria-disabled')).toBe('true');

    await user.click(rows[2]!);
    expect(sent).toEqual([]);
    await user.click(rows[0]!);
    expect(screen.queryAllByTestId('terminal-session')).toEqual([]);
    await act(() => Promise.resolve());
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'thread.create',
        providerInstanceId: 'claude',
        projectId: 'kettle',
        cwd: '/work/kettle',
        title: 'Make the kettle whistle twice',
        model: 'kettle-small',
        effort: 'low',
        permissionMode: 'default',
        resumeSessionId: 's-1',
      }),
    ]);
    const threadId = (sent[0] as { threadId: string }).threadId;
    expect(router.state.location.pathname).toBe(`/chat/${threadId}`);
  });

  it('opens the wow thread that already resumes a session instead of making another', async () => {
    const user = userEvent.setup();
    const { runtime, sent } = fakeServer();
    sessions.splice(0, 1, session({ threadId: 'last' }));
    const { router } = await renderApp('/chat', runtime);
    act(() => runtime.layout.setState({ sessionDialog: true }));
    const rows = await screen.findAllByTestId('terminal-session');
    expect(rows[0]?.textContent).toContain('Open in wow');
    await user.click(rows[0]!);
    await act(() => Promise.resolve());
    expect(sent).toEqual([]);
    expect(router.state.location.pathname).toBe('/chat/last');
    sessions.splice(0, 1, session({}));
  });
});

describe('a project’s defaults for a new thread (spec 97)', () => {
  it('starts a thread in the project with its model, effort and mode, over the last thread’s', () => {
    const named = {
      ...project,
      defaultProviderInstanceId: 'claude',
      defaultModel: 'kettle-large',
      defaultEffort: 'high',
      defaultPermissionMode: 'plan',
    };
    expect(threadDefaults(instance, models, lastThread, named)).toEqual({
      model: 'kettle-large',
      effort: 'high',
      permissionMode: 'plan',
    });
    // Only the model named: the rest as the last thread had it.
    expect(
      threadDefaults(instance, models, lastThread, { ...project, defaultModel: 'kettle-large' }),
    ).toEqual({ model: 'kettle-large', effort: 'low', permissionMode: 'default' });
    // Named for another instance, or a model this one does not list: not used.
    expect(
      threadDefaults(instance, models, lastThread, {
        ...named,
        defaultProviderInstanceId: 'codex',
      }),
    ).toEqual({
      model: 'kettle-small',
      effort: 'low',
      permissionMode: 'default',
    });
    expect(
      threadDefaults(instance, models, lastThread, { ...project, defaultModel: 'other-model' }),
    ).toEqual({ model: 'kettle-small', effort: 'low', permissionMode: 'default' });
  });
});

describe('models by label (spec 86)', () => {
  it('names a model by its label with the id in a tooltip, and by its id before the list is in', async () => {
    const user = userEvent.setup();
    const { runtime } = fakeServer();
    renderWithRuntime(
      <>
        <ModelName providerInstanceId="claude" model="kettle-large" />
        <ModelName providerInstanceId="claude" model="retired-model" />
        <ModelName plain providerInstanceId="claude" model="kettle-small" />
      </>,
      runtime,
    );
    const names = await screen.findAllByTestId('model-name');
    expect(await screen.findByText('Kettle Large')).toBeTruthy();
    expect(names.map((name) => name.textContent)).toEqual([
      'Kettle Large',
      'retired-model',
      'Kettle Small',
    ]);
    expect(names[2]?.getAttribute('title')).toBe('kettle-small');
    await user.tab();
    expect((await screen.findByRole('tooltip')).textContent).toContain('kettle-large');
  });
});
