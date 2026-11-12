import { recogniseHostRef } from '@wow/contracts';
import type {
  CalendarItem,
  FileReadResult,
  HostLinkRules,
  ProviderInstance,
  Thread,
  ThreadItem,
  WorkflowRun,
} from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { renderApp } from '@/test/render';
import { loadMarkdown } from '../test/markdown';
import { hostItemCommands, viewerCommands } from './commands';
import { selectTab } from './viewer';

beforeAll(loadMarkdown);

// Agent workbench spec 11 to 17, 87: files open in tabs of the side panel beside a chat, from
// paths in messages, a tool row's Open and "Open file…", against a fake server.

const thread = (id: string, title: string): Thread => ({
  id,
  projectId: null,
  cwd: '/work/tea',
  branch: null,
  providerInstanceId: 'claude',
  providerSessionId: null,
  title,
  model: 'opus',
  effort: 'high',
  permissionMode: 'default',
  state: 'idle',
  pinned: false,
  runId: null,
  stepId: null,
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
});

const instance: ProviderInstance = {
  id: 'claude',
  kind: 'claude',
  name: 'Claude',
  binaryPath: 'claude',
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: 'opus',
  defaultEffort: null,
  defaultPermissionMode: null,
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
};

const item = (id: string, kind: ThreadItem['kind'], payload: unknown): ThreadItem => ({
  id,
  threadId: 'tea',
  turnId: 'turn-1',
  index: Number(id.slice(-1)),
  kind,
  payload,
  streaming: false,
});

const items: ThreadItem[] = [
  item('item-1', 'user', { text: '@src/timer.ts\n\nshow the file', files: ['src/timer.ts'] }),
  item('item-2', 'tool_call', {
    name: 'Read',
    input: { file_path: 'docs/notes.txt' },
    output: 'Notes',
    status: 'ok',
    path: 'docs/notes.txt',
  }),
  item('item-3', 'assistant_text', {
    text: 'The timer is in `src/timer.ts`, as the [spec](docs/spec.md) says. Outside: `../outside.txt`.',
  }),
  item('item-4', 'assistant_text', {
    text: 'Pushed as https://ghe.example.invalid/acme/tea/pull/14.',
  }),
];

const hostRules: HostLinkRules = {
  sites: [{ host: 'github', base: 'https://ghe.example.invalid', name: 'ghe.example.invalid' }],
  repository: null,
  jiraKey: null,
};

const text = (value: string): FileReadResult => ({
  kind: value.startsWith('#') ? 'markdown' : 'text',
  absolutePath: '/work/tea/file',
  size: value.length,
  text: value,
});

const files: Readonly<Record<string, FileReadResult>> = {
  'src/timer.ts': text('export const ring = 2;'),
  'docs/spec.md': text('# Tea timer spec'),
  'docs/notes.txt': text('Invented notes'),
  '../outside.txt': {
    kind: 'refused',
    reason: 'outside',
    message: "../outside.txt is outside the thread's folder, so it was not read.",
  },
};

// Two cards, each with a run whose step thread the calendar's panel shows.
const card = (id: string, runId: string): CalendarItem => ({
  id,
  source: 'local',
  externalId: null,
  title: `Card ${id}`,
  start: '2026-11-02T09:00:00.000Z',
  end: '2026-11-02T09:30:00.000Z',
  zone: 'UTC',
  allDay: false,
  location: null,
  joinUrl: null,
  body: null,
  organizer: null,
  projectId: null,
  backlogItemId: null,
  workflowId: 'w',
  runId,
  state: 'running',
  updatedAt: '2026-11-02T08:00:00.000Z',
});

const run = (id: string, threadId: string): WorkflowRun => ({
  id,
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
      stepId: 'build',
      state: 'running',
      threadId,
      startedAt: '2026-11-02T09:00:00.000Z',
      artifactsFound: [],
    },
  ],
  startedAt: '2026-11-02T09:00:00.000Z',
  endedAt: null,
});

const stepThread = (id: string, runId: string): Thread => ({
  ...thread(id, `Step of ${runId}`),
  runId,
  stepId: 'build',
});

function fake() {
  const read: unknown[] = [];
  const sent: unknown[] = [];
  const topics: Readonly<Record<string, unknown[]>> = {
    threads: [
      thread('tea', 'Tea timer'),
      thread('kettle', 'Kettle'),
      stepThread('step-1', 'run-1'),
      stepThread('step-2', 'run-2'),
    ],
    providerInstances: [instance],
    projects: [],
    calendarItems: [card('card-1', 'run-1'), card('card-2', 'run-2')],
    workflowRuns: [run('run-1', 'step-1'), run('run-2', 'step-2')],
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      if (method === 'files.read') {
        read.push(params);
        return Promise.resolve(files[(params as { path: string }).path]);
      }
      if (method === 'files.list') {
        return Promise.resolve({
          files: ['README.md', 'src/timer.ts', 'src/timer.test.ts', 'docs/spec.md'],
          source: 'git',
          truncated: false,
        });
      }
      if (method === 'hosts.lookup') {
        const { ref, read: mode } = params as { ref?: string; read?: string };
        if (mode === 'refresh') return Promise.reject(new Error('The host did not answer'));
        const found = ref === undefined ? undefined : recogniseHostRef(ref, hostRules);
        return Promise.resolve({ rules: hostRules, item: found ?? null, read: null });
      }
      if (method === 'dispatch') {
        sent.push((params as { command: unknown }).command);
        return Promise.resolve({ commandId: 'c', seqs: [], duplicate: false });
      }
      return Promise.resolve([]);
    },
    subscribe(topic, params, onData) {
      if (topic === 'threadItems') {
        const shown = (params as { threadId?: string }).threadId;
        onData(shown === 'tea' || shown?.startsWith('step-') ? items : []);
      } else onData(topics[topic] ?? []);
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
        'appearance.contextPanel': true,
        'providers.offerSetup': false,
      }),
    ),
  };
  return { runtime, read, sent };
}

const panel = () => screen.getByRole('complementary', { name: 'Context panel' });
const tabs = () =>
  within(panel())
    .queryAllByRole('tab')
    .map((tab) => `${tab.textContent}${tab.getAttribute('aria-selected') === 'true' ? ' *' : ''}`);
const conversation = () => screen.getByRole('list', { name: 'Conversation' });
const fileLink = async (name: string) =>
  (await within(conversation()).findAllByTestId('file-link')).find(
    (link) => link.textContent === name,
  ) as HTMLElement;

async function openThread() {
  const server = fake();
  const app = await renderApp('/chat/tea', server.runtime);
  await within(conversation()).findAllByTestId('file-link');
  return { ...server, ...app, user: userEvent.setup() };
}

describe('panel tabs in chat', () => {
  it('shows Details and a tab per open file with its icon and name; opening one again selects it @agent-workbench-11', async () => {
    const { user, read } = await openThread();
    expect(tabs()).toEqual([]);
    await user.click(await fileLink('src/timer.ts'));
    expect(await within(panel()).findByText('export const ring = 2;')).toBeTruthy();
    await user.click(await fileLink('spec'));
    expect(await within(panel()).findByRole('heading', { name: 'Tea timer spec' })).toBeTruthy();
    expect(tabs()).toEqual(['Details', 'timer.ts', 'spec.md *']);
    for (const tab of within(panel()).getAllByRole('tab')) {
      expect(tab.querySelector('svg')).not.toBeNull();
    }
    await user.click(await fileLink('src/timer.ts'));
    expect(tabs()).toEqual(['Details', 'timer.ts *', 'spec.md']);
    expect(read).toContainEqual({ threadId: 'tea', path: 'docs/spec.md' });
    // Details is the thread's details.
    await user.click(within(panel()).getByRole('tab', { name: 'Details' }));
    expect(within(panel()).getByTestId('panel-thread')).toBeTruthy();
  });

  it('closes, moves and goes back with the keys while the focus is in the panel @agent-workbench-12', async () => {
    const { user } = await openThread();
    await user.click(await fileLink('src/timer.ts'));
    await user.click(await fileLink('spec'));
    within(panel()).getByRole('tab', { name: 'spec.md' }).focus();
    await user.keyboard('{Control>}{Tab}{/Control}');
    expect(tabs()).toEqual(['Details *', 'timer.ts', 'spec.md']);
    await user.keyboard('{Control>}{Shift>}{Tab}{/Shift}{/Control}');
    expect(tabs()).toEqual(['Details', 'timer.ts', 'spec.md *']);
    await user.keyboard('{Control>}{Shift>}{Tab}{/Shift}{/Control}');
    expect(tabs()).toEqual(['Details', 'timer.ts *', 'spec.md']);
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(tabs()).toEqual(['Details', 'timer.ts', 'spec.md *']);
    await user.keyboard('{Alt>}w{/Alt}');
    expect(tabs()).toEqual(['Details *', 'timer.ts']);
    // The focus stays in the panel, so the keys go on working.
    expect(panel().contains(document.activeElement)).toBe(true);
    await user.keyboard('{Control>}{Tab}{/Control}');
    expect(tabs()).toEqual(['Details', 'timer.ts *']);
    await user.keyboard('{Alt>}w{/Alt}');
    expect(tabs()).toEqual([]);
    expect(within(panel()).getByTestId('panel-thread')).toBeTruthy();
  });

  it('lists the tab keys in the palette while tabs are open', async () => {
    const { user, runtime } = await openThread();
    await user.click(await fileLink('src/timer.ts'));
    const titles = viewerCommands({
      panelTabs: runtime.layout.getState().panelTabs,
      pathname: '/chat/tea',
      openRun: undefined,
      projects: [],
    }).map((command) => command.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        'Close panel tab',
        'Next panel tab',
        'Previous panel tab',
        'Back to the panel tab shown before',
      ]),
    );
    expect(
      viewerCommands({ panelTabs: {}, pathname: '/chat/tea', openRun: undefined, projects: [] }),
    ).toEqual([]);
  });

  it('keeps a thread’s tabs when another thread was open in between, reading them again @agent-workbench-13', async () => {
    const { user, router, read } = await openThread();
    await user.click(await fileLink('src/timer.ts'));
    await user.click(await fileLink('spec'));
    await act(() => router.navigate({ to: '/chat/$threadId', params: { threadId: 'kettle' } }));
    expect(tabs()).toEqual([]);
    const before = read.length;
    await act(() => router.navigate({ to: '/chat/$threadId', params: { threadId: 'tea' } }));
    expect(tabs()).toEqual(['Details', 'timer.ts', 'spec.md *']);
    expect(await within(panel()).findByRole('heading', { name: 'Tea timer spec' })).toBeTruthy();
    expect(read.length).toBe(before + 1);
  });

  it('shows the server’s refusal for a path that leads outside @agent-workbench-16', async () => {
    const { user } = await openThread();
    await user.click(await fileLink('../outside.txt'));
    expect((await within(panel()).findByTestId('viewer-refusal')).textContent).toBe(
      "../outside.txt is outside the thread's folder, so it was not read.",
    );
    expect(within(panel()).getByText('Outside the thread’s folders')).toBeTruthy();
  });

  it('opens a read row’s file with Open @agent-workbench-17', async () => {
    const { user } = await openThread();
    await user.click(within(conversation()).getByRole('button', { name: 'Open docs/notes.txt' }));
    expect(await within(panel()).findByText('Invented notes')).toBeTruthy();
    expect(tabs()).toEqual(['Details', 'notes.txt *']);
  });

  it('opens a mentioned file from its chip, and shows the text without the mention line @agent-workbench-56', async () => {
    const { user } = await openThread();
    const sent = within(conversation()).getByRole('list', { name: 'Sent with files' });
    expect(within(conversation()).getByText('show the file')).toBeTruthy();
    expect(within(conversation()).queryByText(/@src\/timer\.ts/, { selector: 'div' })).toBeNull();
    await user.click(within(sent).getByRole('button', { name: '@timer.ts' }));
    expect(await within(panel()).findByText('export const ring = 2;')).toBeTruthy();
  });

  it('opens a file and a host link from Details → Mentioned with Enter @agent-workbench-19', async () => {
    const { user } = await openThread();
    const mentioned = await within(panel()).findByRole('list', { name: 'Mentioned' });
    const file = within(mentioned)
      .getAllByTestId('mentioned-file')
      .find((entry) => entry.textContent === 'src/timer.ts');
    file?.focus();
    await user.keyboard('{Enter}');
    expect(await within(panel()).findByText('export const ring = 2;')).toBeTruthy();
    expect(tabs()).toEqual(['Details', 'timer.ts *']);

    await user.click(within(panel()).getByRole('tab', { name: 'Details' }));
    const link = await within(panel()).findByTestId('mentioned-link');
    expect(link.textContent).toBe('PR #14');
    link.focus();
    await user.keyboard('{Enter}');
    expect(tabs()).toEqual(['Details', 'timer.ts', 'PR #14 *']);
  });

  it('shows a failed Refresh now from the palette in the host tab, as its button does', async () => {
    const { user, runtime } = await openThread();
    await user.click(await within(panel()).findByTestId('mentioned-link'));
    expect(tabs()).toEqual(['Details', 'PR #14 *']);
    const refresh = hostItemCommands({
      target: undefined,
      panelTabs: runtime.layout.getState().panelTabs,
      pathname: '/chat/tea',
    }).find((command) => command.id === 'panel.host.refresh');
    act(() =>
      refresh?.run({
        navigate: (() => Promise.resolve()) as never,
        settings: runtime.settings,
        layout: runtime.layout,
        draft: runtime.draft,
        connection: runtime.connection,
      }),
    );
    expect((await within(panel()).findByRole('alert')).textContent).toContain(
      'The host did not answer',
    );
  });

  it('closes a file opened from the main view with Escape while the focus stayed on its link @agent-workbench-87', async () => {
    const { user } = await openThread();
    const link = await fileLink('src/timer.ts');
    await user.click(link);
    expect(document.activeElement).toBe(link);
    expect(tabs()).toEqual(['Details', 'timer.ts *']);
    await user.keyboard('{Escape}');
    expect(tabs()).toEqual([]);
    // In a text field Escape stays the field's.
    await user.click(await fileLink('src/timer.ts'));
    screen.getByRole('combobox', { name: 'Message' }).focus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(tabs()).toEqual(['Details', 'timer.ts *']);
  });

  it('closes with Escape only from the link that opened the tab shown @agent-workbench-87', async () => {
    const { user, runtime } = await openThread();
    const timerLink = await fileLink('src/timer.ts');
    const specLink = await fileLink('spec');
    await user.click(timerLink);
    await user.click(specLink);
    const timerTab = runtime.layout
      .getState()
      .panelTabs['/chat/tea']?.tabs.find((tab) => tab.id.endsWith('src/timer.ts'));
    act(() => selectTab(runtime.layout, '/chat/tea', timerTab?.id ?? ''));
    expect(tabs()).toEqual(['Details', 'timer.ts *', 'spec.md']);
    specLink.focus();
    await user.keyboard('{Escape}');
    expect(tabs()).toEqual(['Details', 'timer.ts *', 'spec.md']);
    timerLink.focus();
    await user.keyboard('{Escape}');
    expect(tabs()).toEqual(['Details', 'spec.md *']);
  });

  it('keeps no entry for a view whose last tab closed', async () => {
    const { user, runtime } = await openThread();
    await user.click(await fileLink('src/timer.ts'));
    expect(Object.keys(runtime.layout.getState().panelTabs)).toEqual(['/chat/tea']);
    await user.keyboard('{Escape}');
    expect(tabs()).toEqual([]);
    expect(runtime.layout.getState().panelTabs).toEqual({});
  });

  it('opens a file from "Open file…" with Ctrl+P, filtered as typed @agent-workbench-18', async () => {
    const { user } = await openThread();
    screen.getByRole('list', { name: 'Conversation' }).focus();
    await user.keyboard('{Control>}p{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Open file' });
    expect(await within(dialog).findByText('README.md')).toBeTruthy();
    await user.keyboard('tmr');
    const options = within(dialog).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'timer.tssrc',
      'timer.test.tssrc',
    ]);
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog', { name: 'Open file' })).toBeNull();
    expect(await within(panel()).findByText('export const ring = 2;')).toBeTruthy();
    expect(tabs()).toEqual(['Details', 'timer.ts *']);
  });
});

describe('panel tabs in the calendar', () => {
  it('keeps each card’s tabs apart, though both are the calendar @agent-workbench-13', async () => {
    const server = fake();
    const { router } = await renderApp('/calendar?item=card-1', server.runtime);
    const user = userEvent.setup();
    expect(await within(panel()).findByTestId('panel-step-thread')).toBeTruthy();
    await user.click(await fileLink('src/timer.ts'));
    expect(await within(panel()).findByText('export const ring = 2;')).toBeTruthy();
    expect(tabs()).toEqual(['Calendar', 'timer.ts *']);
    await act(() => router.navigate({ to: '/calendar', search: { item: 'card-2' } }));
    expect(tabs()).toEqual([]);
    expect(within(panel()).getByTestId('panel-step-thread')).toBeTruthy();
    await act(() => router.navigate({ to: '/calendar', search: { item: 'card-1' } }));
    expect(tabs()).toEqual(['Calendar', 'timer.ts *']);
  });
});
