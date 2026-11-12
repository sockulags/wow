import type { ProviderInstance, ProviderModel, Thread, WorkflowRun } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
  type SettingValues,
} from '@wow/client-runtime';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, RuntimeProvider, type Runtime } from '@/app/runtime';
import { renderApp } from '@/test/render';
import { createDraftStore } from './draft';
import { assistantBar } from '@/assistant/assistant-view';
import { ModelBar, barKeyOf } from './model-bar';
import { threadDefaults } from './new-thread';
import { activeModelBar, modelBarCommands, modelBarStore } from './model-commands';
import { RunStepThread } from '@/panel/step-thread';
import { ThreadConversation } from './thread-view';

// Agent workbench U1: the composer bar, its keys, its lists and its palette commands.

const claudeModels: ProviderModel[] = [
  {
    id: 'opus',
    label: 'Opus',
    description: 'The largest invented model',
    efforts: ['low', 'high'],
  },
  { id: 'sonnet', label: 'Sonnet', description: 'The balanced one', efforts: ['low', 'medium'] },
];

// As the Codex adapter answers: descriptions, a default flag, default efforts and image input
// (the hidden model is already left out by the adapter).
const codexModels: ProviderModel[] = [
  {
    id: 'kettle-max',
    label: 'Kettle max',
    description: 'Invented: the most capable',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    isDefault: true,
    imageInput: true,
  },
  {
    id: 'kettle-mini',
    label: 'Kettle mini',
    description: 'Invented: small and quick',
    efforts: ['low', 'medium'],
    defaultEffort: 'low',
    isDefault: false,
    imageInput: false,
  },
];

const thread: Thread = {
  id: 'thread-1',
  projectId: null,
  cwd: '/work/kettle',
  branch: null,
  providerInstanceId: 'claude',
  providerSessionId: null,
  title: 'Kettle',
  model: 'opus',
  effort: 'high',
  permissionMode: 'default',
  state: 'idle',
  pinned: false,
  runId: null,
  stepId: null,
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
};

const claude: ProviderInstance = {
  id: 'claude',
  kind: 'claude',
  name: 'Claude',
  binaryPath: 'claude',
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: 'sonnet',
  defaultEffort: 'low',
  defaultPermissionMode: null,
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
};

const codex: ProviderInstance = {
  ...claude,
  id: 'codex',
  kind: 'codex',
  name: 'Codex',
  defaultModel: null,
  defaultEffort: null,
};

function connectionWith(topics: Record<string, unknown>, refused = false) {
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>((method, params) => {
    if (method === 'provider.listModels') {
      const { providerInstanceId } = params as { providerInstanceId: string };
      return Promise.resolve(providerInstanceId === 'codex' ? codexModels : claudeModels);
    }
    if (refused && method === 'dispatch') return Promise.reject(new Error('Refused'));
    return Promise.resolve({
      commandId: '00000000-0000-4000-8000-000000000000',
      seqs: [],
      duplicate: false,
    });
  });
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: request as Connection['request'],
    subscribe(topic, _params, onData) {
      onData(topics[topic] ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  const sent = () =>
    request.mock.calls
      .filter(([method]) => method === 'dispatch')
      .map(([, params]) => (params as { command: unknown }).command);
  return { connection, sent };
}

const runtimeOf = (connection: Connection, values: SettingValues = {}): Runtime => ({
  connection,
  layout: createLayoutStore(),
  draft: createDraftStore(),
  settings: createSettingsStore(
    createMemorySettingsSource(undefined, { 'providers.offerSetup': false, ...values }),
  ),
});

function setup(shown: Partial<Thread> = {}, instance: ProviderInstance = claude) {
  const { connection, sent } = connectionWith({ turns: [], threadItems: [] });
  const value = { ...thread, providerInstanceId: instance.id, ...shown };
  render(
    <RuntimeProvider runtime={runtimeOf(connection)}>
      <button type="button">Before the composer</button>
      <ThreadConversation thread={value} instance={instance} />
    </RuntimeProvider>,
  );
  const box = screen.getByRole('combobox', { name: 'Message' });
  return { box, sent, user: userEvent.setup() };
}

const bar = () => screen.getByTestId('model-bar');

// The bar hands its models to the palette's store in an effect after they are drawn, so a test
// that reads the store waits for that write rather than for the text on screen.
const modelsRegistered = () => (activeModelBar(modelBarStore.getState())?.models.length ?? 0) > 0;

function registeredModels(): Promise<void> {
  return new Promise((resolve) => {
    const loaded = modelsRegistered;
    if (loaded()) return resolve();
    const stop = modelBarStore.subscribe(() => {
      if (!loaded()) return;
      stop();
      resolve();
    });
  });
}
const configured = (sent: () => unknown[]) =>
  sent().filter((command) => (command as { type: string }).type === 'thread.configure') as Record<
    string,
    unknown
  >[];

describe('the composer bar (agent workbench spec 1, 2)', () => {
  it('reads model · effort · mode and opens the lists with Ctrl+Shift+M and Ctrl+Shift+E', async () => {
    const { box, sent, user } = setup();
    expect(await within(bar()).findByText('Opus')).toBeTruthy();
    expect(bar().textContent).toBe('Opus·High·Ask');

    box.focus();
    await user.keyboard('{Control>}{Shift>}M{/Shift}{/Control}');
    const models = await screen.findByRole('listbox', { name: 'Model' });
    await user.click(within(models).getByRole('option', { name: /Sonnet/ }));
    expect(configured(sent)).toEqual([
      { type: 'thread.configure', threadId: thread.id, model: 'sonnet' },
    ]);
    // The pick returns the keyboard to the composer.
    expect(document.activeElement).toBe(box);

    await user.keyboard('{Control>}{Shift>}E{/Shift}{/Control}');
    const efforts = await screen.findByRole('listbox', { name: 'Effort' });
    await user.click(within(efforts).getByRole('option', { name: /^Low/ }));
    expect(configured(sent).at(-1)).toEqual({
      type: 'thread.configure',
      threadId: thread.id,
      effort: 'low',
    });
  });

  it('keeps the selects out of the composer: one bar with three parts', async () => {
    setup();
    await within(bar()).findByText('Opus');
    expect(
      within(bar())
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Model', 'Effort', 'Permission mode']);
    expect(screen.queryAllByRole('combobox', { name: 'Model' })).toHaveLength(0);
  });
});

describe('Shift+Tab and the colours (agent workbench spec 3, 4)', () => {
  it.each([
    ['default', 'acceptEdits'],
    ['acceptEdits', 'plan'],
    ['plan', 'default'],
    ['bypassPermissions', 'default'],
  ])('moves Claude Code from %s to %s', async (from, to) => {
    const { box, sent, user } = setup({ permissionMode: from });
    box.focus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(configured(sent)).toEqual([
      { type: 'thread.configure', threadId: thread.id, permissionMode: to },
    ]);
    expect(document.activeElement).toBe(box);
  });

  it('skips Full access on Codex', async () => {
    const { box, sent, user } = setup({ permissionMode: 'untrusted', model: 'kettle-max' }, codex);
    box.focus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(configured(sent)).toEqual([
      { type: 'thread.configure', threadId: thread.id, permissionMode: 'read-only' },
    ]);
  });

  it.each([
    ['plan', 'text-info'],
    ['acceptEdits', 'text-state-done'],
    ['bypassPermissions', 'text-destructive'],
  ])('draws %s with %s', (permissionMode, colour) => {
    setup({ permissionMode });
    const mode = within(bar()).getByRole('button', { name: 'Permission mode' });
    expect(mode.className).toContain(colour);
    // Only a dangerous mode carries the warning icon.
    expect(mode.querySelector('svg') !== null).toBe(permissionMode === 'bypassPermissions');
  });

  it('leaves the composer with the second key, since Shift+Tab no longer does', async () => {
    const { box, sent, user } = setup();
    box.focus();
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Before the composer' }),
    );
    expect(configured(sent)).toEqual([]);
  });

  it('lets Escape reach a context panel laid over the view, so one press closes it', async () => {
    const { connection } = connectionWith({ turns: [], threadItems: [] });
    const seen: boolean[] = [];
    render(
      <RuntimeProvider runtime={runtimeOf(connection)}>
        <button type="button">Before the panel</button>
        <aside
          id="context-panel"
          data-overlay=""
          onKeyDown={(event) => {
            if (event.key === 'Escape') seen.push(event.defaultPrevented);
          }}
        >
          <ThreadConversation thread={thread} instance={claude} compact />
        </aside>
      </RuntimeProvider>,
    );
    const box = screen.getByRole('combobox', { name: 'Message' });
    box.focus();
    await userEvent.setup().keyboard('{Escape}');
    expect(seen).toEqual([false]);
    expect(document.activeElement).toBe(box);
  });

  it('still leaves the composer in a panel laid over the view when the leave key is not Escape', async () => {
    const { connection } = connectionWith({ turns: [], threadItems: [] });
    render(
      <RuntimeProvider
        runtime={runtimeOf(connection, { 'keybindings.composerLeave': 'Mod+Shift+L' })}
      >
        <aside id="context-panel" data-overlay="">
          <button type="button">Before the panel's composer</button>
          <ThreadConversation thread={thread} instance={claude} compact />
        </aside>
      </RuntimeProvider>,
    );
    const box = screen.getByRole('combobox', { name: 'Message' });
    box.focus();
    await userEvent.setup().keyboard('{Control>}{Shift>}L{/Shift}{/Control}');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: "Before the panel's composer" }),
    );
  });

  it('reads the keys from the keybinding settings', () => {
    const bindings = {
      model: 'Mod+Shift+M',
      effort: 'Mod+Shift+E',
      mode: 'Shift+Tab',
      leave: 'Escape',
    };
    const key = (init: Partial<KeyboardEventInit>) =>
      barKeyOf(
        {
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
          metaKey: false,
          key: '',
          code: '',
          ...init,
        },
        bindings,
        false,
      );
    expect(key({ key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true })).toBe('model');
    expect(key({ key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true })).toBe('effort');
    expect(key({ key: 'Tab', code: 'Tab', shiftKey: true })).toBe('mode');
    expect(key({ key: 'Tab', code: 'Tab' })).toBeUndefined();
    expect(key({ key: 'Escape', code: 'Escape' })).toBe('leave');
    expect(
      barKeyOf(
        { ctrlKey: false, altKey: false, shiftKey: true, metaKey: false, key: 'Tab', code: 'Tab' },
        { ...bindings, mode: '' },
        false,
      ),
    ).toBeUndefined();
  });
});

describe('the lists say what the provider offers (agent workbench spec 7, 8)', () => {
  it('shows Codex models on two lines with the default, image input and default effort', async () => {
    const { box, user } = setup(
      { model: 'kettle-max', effort: 'medium', permissionMode: 'auto' },
      codex,
    );
    await within(bar()).findByText('Kettle max');
    box.focus();
    await user.keyboard('{Control>}{Shift>}M{/Shift}{/Control}');
    const models = await screen.findByRole('listbox', { name: 'Model' });
    const [max, mini] = within(models).getAllByRole('option');
    // The instance names no default, so the provider's own is marked as the provider's.
    expect(max?.textContent).toBe("Kettle max(provider's default)Invented: the most capable");
    expect(within(max!).getByRole('img', { name: 'Takes images' })).toBeTruthy();
    expect(mini?.textContent).toBe('Kettle miniInvented: small and quick');
    expect(within(mini!).queryByRole('img', { name: 'Takes images' })).toBeNull();
    await user.keyboard('{Escape}');

    await user.keyboard('{Control>}{Shift>}E{/Shift}{/Control}');
    const efforts = await screen.findByRole('listbox', { name: 'Effort' });
    expect(
      within(efforts)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Low', 'Medium', "High(model's default)"]);
  });

  it('marks the instance default and shows Claude descriptions without guessing the rest', async () => {
    const { box, user } = setup();
    await within(bar()).findByText('Opus');
    box.focus();
    await user.keyboard('{Control>}{Shift>}M{/Shift}{/Control}');
    const models = await screen.findByRole('listbox', { name: 'Model' });
    expect(
      within(models)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['OpusThe largest invented model', 'Sonnet(default)The balanced one']);
    expect(within(models).queryByRole('img', { name: 'Takes images' })).toBeNull();
    await user.keyboard('{Escape}');
    await user.keyboard('{Control>}{Shift>}E{/Shift}{/Control}');
    const efforts = await screen.findByRole('listbox', { name: 'Effort' });
    expect(
      within(efforts)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Default', 'Low(default)', 'High']);
  });
});

describe('keys pressed faster than the thread echoes them', () => {
  it('cycles on from the mode it sent, so two Shift+Tab reach Plan only', async () => {
    const { box, sent, user } = setup();
    box.focus();
    await user.keyboard('{Shift>}{Tab}{Tab}{/Shift}');
    expect(configured(sent).map((command) => command.permissionMode)).toEqual([
      'acceptEdits',
      'plan',
    ]);
  });

  it('cycles from the mode on screen again after the server refused the last one', async () => {
    const { connection, sent } = connectionWith({ turns: [], threadItems: [] }, true);
    render(
      <RuntimeProvider runtime={runtimeOf(connection)}>
        <ThreadConversation thread={thread} instance={claude} />
      </RuntimeProvider>,
    );
    const box = screen.getByRole('combobox', { name: 'Message' });
    const user = userEvent.setup();
    box.focus();
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    // The refusal settles before the next key, as it would on a real connection.
    await act(() => Promise.resolve());
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(configured(sent).map((command) => command.permissionMode)).toEqual([
      'acceptEdits',
      'acceptEdits',
    ]);
  });

  it('passes over an element before the composer that cannot take the focus', async () => {
    const { box, user } = setup();
    const hidden = document.createElement('button');
    hidden.textContent = 'Hidden by style';
    // As a browser does for display: none.
    hidden.focus = () => undefined;
    screen.getByRole('button', { name: 'Before the composer' }).after(hidden);
    box.focus();
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Before the composer' }),
    );
  });
});

describe('two conversations on screen (agent workbench spec 6)', () => {
  it('keeps the palette on the focused composer while the other one re-renders', async () => {
    const { connection, sent } = connectionWith({ turns: [], threadItems: [] });
    const runtime = runtimeOf(connection);
    const step: Thread = { ...thread, id: 'thread-2', runId: 'run-1', stepId: 'build' };
    const view = (other: Thread) => (
      <RuntimeProvider runtime={runtime}>
        <ThreadConversation thread={thread} instance={claude} />
        <ThreadConversation thread={other} instance={claude} compact />
      </RuntimeProvider>
    );
    const { rerender } = render(view(step));
    const bars = screen.getAllByTestId('model-bar');
    for (const shown of bars) expect(await within(shown).findByText('Opus')).toBeTruthy();
    const [first] = screen.getAllByRole('combobox', { name: 'Message' });
    act(() => first?.focus());
    let writes = 0;
    const stop = modelBarStore.subscribe(() => {
      writes += 1;
    });
    // A streamed item gives the step thread a new row each time.
    rerender(view({ ...step, updatedAt: '2026-11-02T08:01:00.000Z' }));
    rerender(view({ ...step, updatedAt: '2026-11-02T08:02:00.000Z' }));
    stop();
    expect(writes).toBe(0);
    act(() => activeModelBar(modelBarStore.getState())?.apply({ permissionMode: 'plan' }));
    expect(configured(sent)).toEqual([
      { type: 'thread.configure', threadId: 'thread-1', permissionMode: 'plan' },
    ]);
  });
});

describe('the palette (agent workbench spec 6)', () => {
  it('lists model, effort and mode with the current one marked, and applies them', async () => {
    const { sent } = setup();
    await within(bar()).findByText('Opus');
    await act(registeredModels);
    const active = activeModelBar(modelBarStore.getState());
    const commands = modelBarCommands(active);
    const titled = (title: string) => commands.find((command) => command.title === title);
    expect(titled('Model: Opus')?.detail).toBe('Current');
    expect(titled('Model: Sonnet (default)')?.detail).toBe('Composer');
    expect(titled('Effort: High')?.detail).toBe('Current');
    expect(titled('Permission mode: Ask for permissions')?.detail).toBe('Current');
    expect(titled('Permission mode: Bypass permissions')).toBeDefined();
    act(() => titled('Effort: Low (default)')?.run({} as never));
    act(() => titled('Permission mode: Plan only')?.run({} as never));
    expect(configured(sent)).toEqual([
      { type: 'thread.configure', threadId: thread.id, effort: 'low' },
      { type: 'thread.configure', threadId: thread.id, permissionMode: 'plan' },
    ]);
    act(() => titled('Choose model…')?.run({} as never));
    expect(await screen.findByRole('listbox', { name: 'Model' })).toBeTruthy();
  });
});

describe('every composer that runs turns has the bar (agent workbench spec 5)', () => {
  it("shows the bar on a workflow step's thread in the context panel", async () => {
    const step: Thread = { ...thread, runId: 'run-1', stepId: 'build' };
    const run: WorkflowRun = {
      id: 'run-1',
      workflowId: 'w',
      projectId: 'kettle',
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
          threadId: step.id,
          startedAt: '2026-11-02T08:00:00.000Z',
          artifactsFound: [],
        },
      ],
      startedAt: '2026-11-02T08:00:00.000Z',
      endedAt: null,
    };
    const { connection } = connectionWith({
      threads: [step],
      providerInstances: [claude],
      turns: [],
      threadItems: [],
    });
    // The panel's own component, which links to the thread, so it needs a router around it.
    const router = createRouter({
      routeTree: createRootRoute({
        component: () => <RunStepThread run={run} workflow={undefined} />,
      }),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    await router.load();
    render(
      <RuntimeProvider runtime={runtimeOf(connection)}>
        <RouterProvider router={router} />
      </RuntimeProvider>,
    );
    const panel = screen.getByTestId('panel-step-thread');
    expect(await within(within(panel).getByTestId('model-bar')).findByText('Opus')).toBeTruthy();
  });

  it('shows the bar on a new thread in place of the selects', async () => {
    const { connection } = connectionWith({
      providerInstances: [claude],
      threads: [],
      projects: [],
      skills: [],
      backlogItems: [],
    });
    await renderApp('/chat/new', runtimeOf(connection));
    const shown = await screen.findByTestId('model-bar');
    expect(await within(shown).findByText('Sonnet')).toBeTruthy();
    expect(shown.textContent).toBe('Sonnet·Low·Ask');
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
  });
});

describe('a new thread whose providers arrive late', () => {
  it('leaves the focus on a picker the user opened meanwhile', async () => {
    const { connection } = connectionWith({
      threads: [],
      projects: [],
      skills: [],
      backlogItems: [],
    });
    // Every reader of the instances waits, as on a slow start.
    const waiting: ((rows: unknown[]) => void)[] = [];
    const late: Connection = {
      ...connection,
      subscribe(topic, params, onData) {
        if (topic !== 'providerInstances') return connection.subscribe(topic, params, onData);
        waiting.push(onData as (rows: unknown[]) => void);
        return () => undefined;
      },
    };
    await renderApp('/chat/new', runtimeOf(late));
    const picker = await screen.findByRole('combobox', { name: 'Project' });
    act(() => picker.focus());
    act(() => waiting.forEach((onData) => onData([claude])));
    await screen.findByTestId('model-bar');
    expect(document.activeElement).toBe(picker);
  });
});

describe('a new thread starts from what the provider names (agent workbench spec 7, 8)', () => {
  it("takes the provider's default model and that model's default effort", () => {
    expect(threadDefaults(codex, codexModels, undefined)).toEqual({
      model: 'kettle-max',
      effort: 'high',
      permissionMode: 'read-only',
    });
  });
});

describe("the Assistant view's bar (agent workbench spec 10)", () => {
  const assistantThread: Thread = {
    ...thread,
    id: 'assistant',
    kind: 'assistant',
    model: 'opus',
    effort: 'high',
    permissionMode: 'dontAsk',
  };
  const other: ProviderInstance = { ...claude, id: 'claude-home', name: 'Claude at home' };

  it('writes the instance, model and effort settings and shows Read only', async () => {
    const write = vi.fn<(key: string, value: string) => Promise<boolean>>(() =>
      Promise.resolve(true),
    );
    const props = assistantBar({
      thread: assistantThread,
      instances: [claude, other, codex],
      stored: { instanceId: '', model: '', effort: '', allowCodex: false },
      write,
    });
    if (!props) throw new Error('no bar');
    // Codex is offered only when the assistant may run on it.
    expect(props.instances?.choices.map((choice) => choice.id)).toEqual(['claude', 'claude-home']);
    const { connection } = connectionWith({});
    render(
      <RuntimeProvider runtime={runtimeOf(connection)}>
        <ModelBar {...props} />
      </RuntimeProvider>,
    );
    await within(bar()).findByText('Opus');
    expect(bar().textContent).toBe('Claude·Opus·High·Read only');
    expect(within(bar()).queryByRole('button', { name: 'Permission mode' })).toBeNull();

    const user = userEvent.setup();
    await user.click(within(bar()).getByRole('button', { name: 'Model' }));
    await user.click(
      within(await screen.findByRole('listbox', { name: 'Model' })).getByRole('option', {
        name: /Sonnet/,
      }),
    );
    expect(write).toHaveBeenLastCalledWith('assistant.model', 'sonnet');
    await user.click(within(bar()).getByRole('button', { name: 'Effort' }));
    await user.click(
      within(await screen.findByRole('listbox', { name: 'Effort' })).getByRole('option', {
        name: /^Low/,
      }),
    );
    expect(write).toHaveBeenLastCalledWith('assistant.effort', 'low');
    await user.click(within(bar()).getByRole('button', { name: 'Provider instance' }));
    await user.click(
      within(await screen.findByRole('listbox', { name: 'Provider instance' })).getByRole(
        'option',
        { name: /Claude at home/ },
      ),
    );
    await act(async () => undefined);
    // The instance last, so the assistant never opens on it with the old instance's model.
    expect(write.mock.calls.slice(-3)).toEqual([
      ['assistant.model', ''],
      ['assistant.effort', ''],
      ['assistant.providerInstanceId', 'claude-home'],
    ]);
    // Shift+Tab does not change the assistant's mode.
    expect(activeModelBar(modelBarStore.getState())?.modeLocked).toBe(true);
    expect(
      modelBarCommands(activeModelBar(modelBarStore.getState())).some((command) =>
        command.id.startsWith('modelBar.mode.'),
      ),
    ).toBe(false);
  });

  it('shows what the settings name before the thread has caught up', () => {
    const props = assistantBar({
      thread: assistantThread,
      instances: [claude, other],
      stored: { instanceId: 'claude-home', model: 'sonnet', effort: '', allowCodex: false },
      write: () => Promise.resolve(true),
    });
    expect(props?.providerInstanceId).toBe('claude-home');
    // Another instance than the thread's starts from its own defaults.
    expect(props?.value).toEqual({ model: 'sonnet', effort: 'low', permissionMode: 'dontAsk' });
  });
});
