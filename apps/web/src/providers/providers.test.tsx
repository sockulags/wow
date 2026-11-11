import type { ProviderInstance, SubscriptionTopic } from '@wow/contracts';
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
import { firstStartStore } from '@/app/first-start';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { setupStore } from '@/settings/setup';
import { renderApp } from '@/test/render';
import { connectCommands } from './commands';
import { connectStore } from './connect-step';

// Settings → Providers, the first-run wizard and the first-start step "Connect an agent" against
// a fake server connection (app spec 31, 32; app assistant spec 25 to 27).

interface FakeServer {
  readonly connection: Connection;
  readonly requests: { method: string; params: unknown }[];
  publish(topic: SubscriptionTopic, rows: unknown[]): void;
}

function fakeServer(
  answer: (method: string, params: unknown) => unknown,
  initial: Partial<Record<SubscriptionTopic, unknown[]>>,
): FakeServer {
  const rows = new Map<SubscriptionTopic, unknown[]>(
    Object.entries(initial) as [SubscriptionTopic, unknown[]][],
  );
  const listeners = new Map<SubscriptionTopic, Set<(data: unknown) => void>>();
  const requests: { method: string; params: unknown }[] = [];
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      requests.push({ method, params });
      try {
        return Promise.resolve(answer(method, params));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    subscribe(topic, _params, onData) {
      const set = listeners.get(topic) ?? new Set();
      listeners.set(topic, set);
      set.add(onData);
      onData(rows.get(topic) ?? []);
      return () => set.delete(onData);
    },
    retry: () => undefined,
    close: () => undefined,
  };
  return {
    connection,
    requests,
    publish(topic, next) {
      rows.set(topic, next);
      act(() => {
        for (const listener of listeners.get(topic) ?? []) listener(next);
      });
    },
  };
}

// The first-start gate stays down unless a case asks for it.
const runtimeFor = (
  connection: Connection,
  initial: SettingValues = { 'providers.offerSetup': false },
): Runtime => ({
  connection,
  layout: createLayoutStore(),
  draft: createDraftStore(),
  settings: createSettingsStore(createMemorySettingsSource(undefined, initial)),
});

const work: ProviderInstance = {
  id: 'claude-work',
  kind: 'claude',
  name: 'Work',
  binaryPath: '/usr/local/bin/claude',
  configDir: '/home/me/.claude-work',
  env: { ANTHROPIC_API_KEY: { secretRef: 'provider:claude-work:env:ANTHROPIC_API_KEY' } },
  launchArgs: [],
  defaultModel: null,
  defaultEffort: null,
  defaultPermissionMode: null,
  status: 'error',
  account: null,
  version: null,
  statusMessage: 'Not logged in',
  update: null,
  updateRun: null,
};

const dispatched = (server: FakeServer) =>
  server.requests
    .filter((request) => request.method === 'dispatch')
    .map((request) => (request.params as { command: unknown }).command);

describe('first-run wizard', () => {
  it('opens from "Detect installed providers", creates the detected CLIs and tests them', async () => {
    const user = userEvent.setup();
    const server = fakeServer(
      (method) => {
        if (method === 'provider.detect') {
          return [
            { kind: 'claude', binaryPath: '/opt/bin/claude', configDir: '/home/me/.claude' },
            { kind: 'codex', binaryPath: null, configDir: '/home/me/.codex' },
          ];
        }
        if (method === 'provider.test') {
          return { ok: true, account: 'me@example.com', version: '2.1.316', message: null };
        }
        if (method === 'dispatch') return { commandId: 'x', seqs: [1], duplicate: false };
        return [];
      },
      { providerInstances: [] },
    );
    const runtime = runtimeFor(server.connection);
    runtime.layout.setState({ providerDialog: { type: 'wizard' } });
    await renderApp('/calendar', runtime);

    const wizard = await screen.findByRole('dialog', { name: 'Set up providers' });
    const list = await within(wizard).findByRole('list', { name: 'Detected providers' });
    expect(within(list).getAllByTestId('path-text')[0]?.textContent).toBe('/opt/bin/claude');
    expect(within(list).getByText('codex is not installed, or not on the PATH.')).toBeTruthy();
    expect(within(list).getByRole('checkbox', { name: 'Claude' }).getAttribute('data-state')).toBe(
      'checked',
    );

    // The primary action has focus, not "Not now" (audit A-11).
    const primary = within(wizard).getByRole('button', { name: 'Set up 1 provider' });
    expect(document.activeElement).toBe(primary);
    await user.click(primary);
    const [create] = dispatched(server);
    expect(create).toMatchObject({
      type: 'providerInstance.create',
      kind: 'claude',
      name: 'Claude',
      binaryPath: '/opt/bin/claude',
      configDir: '/home/me/.claude',
    });
    const id = (create as { providerInstanceId: string }).providerInstanceId;
    expect(server.requests).toContainEqual({
      method: 'provider.test',
      params: { providerInstanceId: id },
    });

    server.publish('providerInstances', [
      {
        ...work,
        id,
        name: 'Claude',
        env: {},
        status: 'ready',
        account: 'me@example.com',
        version: '2.1.316',
        statusMessage: null,
      },
    ]);
    const created = within(wizard).getByRole('list', { name: 'Created instances' });
    expect(within(created).getByTestId('provider-status').textContent).toBe('Ready');
    expect(within(created).getByText('me@example.com · 2.1.316')).toBeTruthy();

    // Then projects (owner decision F-10).
    await user.click(within(wizard).getByRole('button', { name: 'Continue' }));
    expect(await within(wizard).findByRole('heading', { name: 'Add your projects' })).toBeTruthy();
    // Nothing to import here, so Continue is the only way on.
    await user.click(within(wizard).getByRole('button', { name: 'Continue' }));
    await user.click(within(wizard).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('remembers "Not now"', async () => {
    const user = userEvent.setup();
    const server = fakeServer((method) => (method === 'provider.detect' ? [] : []), {
      providerInstances: [],
    });
    const runtime = runtimeFor(server.connection, {});
    runtime.layout.setState({ providerDialog: { type: 'wizard' } });
    await renderApp('/settings/providers', runtime);
    const wizard = await screen.findByRole('dialog', { name: 'Set up providers' });
    await user.click(within(wizard).getByRole('button', { name: 'Not now' }));
    expect(runtime.settings.getState().values['providers.offerSetup']).toBe(false);
  });
});

const created = (server: FakeServer, kind: string) =>
  dispatched(server).find(
    (command) =>
      (command as { type: string; kind?: string }).type === 'providerInstance.create' &&
      (command as { kind?: string }).kind === kind,
  ) as { providerInstanceId: string } | undefined;

describe('first start', () => {
  const detected = [
    { kind: 'claude', binaryPath: '/opt/bin/claude', configDir: '/home/me/.claude' },
    { kind: 'codex', binaryPath: '/opt/bin/codex', configDir: '/home/me/.codex' },
  ];
  const codexError = 'Codex is not signed in. Run "codex login", then test again.';
  const firstStartServer = (initial: unknown[] = []) =>
    fakeServer(
      (method, params) => {
        if (method === 'provider.detect') return detected;
        if (method === 'provider.test') {
          const id = (params as { providerInstanceId: string }).providerInstanceId;
          return id.startsWith('codex')
            ? { ok: false, account: null, version: null, message: codexError }
            : { ok: true, account: 'me@example.invalid', version: '2.1.316', message: null };
        }
        if (method === 'dispatch') return { commandId: 'x', seqs: [1], duplicate: false };
        if (method === 'assistant.open') return { thread: null, problem: null };
        return [];
      },
      { providerInstances: initial },
    );
  beforeEach(() => firstStartStore.setState({ up: false }));
  afterEach(() => vi.restoreAllMocks());

  it('shows only "Connect an agent", with the binary found, Test and the error in words @app-assistant-25', async () => {
    const user = userEvent.setup();
    const server = firstStartServer();
    await renderApp('/calendar', runtimeFor(server.connection, {}));

    const step = await screen.findByTestId('first-start');
    expect(within(step).getByRole('heading', { name: 'Connect an agent' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull();
    const claude = within(step).getByRole('region', { name: 'Claude Code' });
    const codex = within(step).getByRole('region', { name: 'Codex' });
    expect((await within(claude).findByTestId('path-text')).textContent).toBe('/opt/bin/claude');
    expect(within(codex).getByTestId('path-text').textContent).toBe('/opt/bin/codex');
    expect(within(step).getByRole('button', { name: 'Start from a setup file' })).toBeTruthy();

    await user.click(within(codex).getByRole('button', { name: 'Test' }));
    const id = created(server, 'codex')?.providerInstanceId;
    expect(id).toMatch(/^codex/);
    expect(server.requests).toContainEqual({
      method: 'provider.test',
      params: { providerInstanceId: id },
    });
    expect((await within(codex).findByRole('alert')).textContent).toBe(codexError);
    server.publish('providerInstances', [
      { ...work, id, kind: 'codex', name: 'Codex', status: 'error', statusMessage: codexError },
    ]);
    // A failed test keeps the step up.
    expect(screen.getByTestId('first-start')).toBeTruthy();

    // The palette offers only what acts on the step.
    await user.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog');
    const search = within(palette).getByRole('combobox');
    await user.type(search, 'connect');
    const offered = (await within(palette).findAllByRole('option')).map(
      (option) => option.textContent ?? '',
    );
    expect(offered.filter((text) => text.includes('Connect '))).toHaveLength(2);
    await user.clear(search);
    await user.type(search, 'calendar');
    expect(within(palette).queryAllByRole('option')).toEqual([]);
  });

  it('opens the assistant once an agent passes, and stays down when it is removed later @app-assistant-26 @app-assistant-27', async () => {
    const user = userEvent.setup();
    const server = firstStartServer();
    const runtime = runtimeFor(server.connection, {});
    const { router } = await renderApp('/calendar', runtime);
    const step = await screen.findByTestId('first-start');
    const claude = within(step).getByRole('region', { name: 'Claude Code' });
    await within(claude).findByTestId('path-text');
    await user.click(within(claude).getByRole('button', { name: 'Test' }));
    const id = created(server, 'claude')?.providerInstanceId;
    expect(id).toMatch(/^claude/);

    server.publish('providerInstances', [
      { ...work, id, name: 'Claude', env: {}, status: 'ready', statusMessage: null },
    ]);
    expect(await screen.findByRole('navigation', { name: 'Sections' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/assistant');
    expect(runtime.settings.getState().values['providers.offerSetup']).toBe(false);

    // Removed later: the app stays usable, and Assistant shows the same step.
    server.publish('providerInstances', []);
    expect(screen.queryByTestId('first-start')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeTruthy();
  });

  it('never gates an install that already has an instance, even one whose test failed', async () => {
    const server = firstStartServer([work]);
    await renderApp('/calendar', runtimeFor(server.connection, {}));
    expect(await screen.findByRole('navigation', { name: 'Sections' })).toBeTruthy();
    expect(screen.queryByTestId('first-start')).toBeNull();
  });

  it('gates an install without any instance, and asks the server for the greeting then', async () => {
    const server = firstStartServer([]);
    await renderApp('/calendar', runtimeFor(server.connection, {}));
    expect(await screen.findByTestId('first-start')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull();
    // The server keeps it owed until the assistant can run it, so a reload does not lose it.
    expect(
      server.requests.filter(
        ({ method, params }) =>
          method === 'dispatch' &&
          (params as { command?: { type?: string } }).command?.type === 'thread.greetAssistant',
      ),
    ).toHaveLength(1);
  });

  it('waits for the test of an instance that was never tested', async () => {
    const server = firstStartServer([{ ...work, status: 'unknown', statusMessage: null }]);
    await renderApp('/calendar', runtimeFor(server.connection, {}));
    expect(await screen.findByRole('navigation', { name: 'Sections' })).toBeTruthy();
    expect(screen.queryByTestId('first-start')).toBeNull();
    expect(server.requests).toContainEqual({
      method: 'provider.test',
      params: { providerInstanceId: 'claude-work' },
    });
  });

  it('opens the setup file picker of the step in the Assistant view from the palette, and keeps the file', async () => {
    const user = userEvent.setup();
    const picked = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const server = fakeServer(
      (method) => {
        if (method === 'provider.detect') return [];
        if (method === 'assistant.open') return { thread: null, problem: null };
        if (method === 'setup.preview') {
          return {
            outcome: 'ready',
            preview: {
              added: [{ what: 'Interval (Hosts)', from: '60 (default)', to: '600' }],
              replaced: [],
              marked: [],
              toFillIn: [],
              warnings: [],
            },
          };
        }
        return [];
      },
      { providerInstances: [] },
    );
    const { router } = await renderApp('/assistant', runtimeFor(server.connection));
    const step = await screen.findByRole('heading', { name: 'Connect an agent' });
    await user.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog');
    await user.type(within(palette).getByRole('combobox'), 'start from a setup file');
    await user.keyboard('{Enter}');
    expect(router.state.location.pathname).toBe('/assistant');
    expect(picked).toHaveBeenCalledOnce();
    const input = screen.getByLabelText('Setup file to start from');
    expect(picked.mock.contexts[0]).toBe(input);
    expect(step.isConnected).toBe(true);
    await user.upload(input, new File(['version: 1\n'], 'team.yaml', { type: 'application/yaml' }));
    expect(await screen.findByRole('dialog', { name: 'Start from team.yaml' })).toBeTruthy();
    expect(server.requests).toContainEqual({
      method: 'setup.preview',
      params: { text: 'version: 1\n' },
    });
    setupStore.setState({ draft: undefined, pickWanted: false });
  });

  it('offers "Connect Claude Code" and "Connect Codex" only while the step is on screen', () => {
    expect(connectCommands(false)).toEqual([]);
    expect(connectCommands(true).map((command) => [command.id, command.title])).toEqual([
      ['connect.claude', 'Connect Claude Code'],
      ['connect.codex', 'Connect Codex'],
    ]);
    connectCommands(true)[1]?.run({} as never);
    expect(connectStore.getState().wanted).toBe('codex');
    connectStore.setState({ wanted: undefined });
  });
});

describe('Settings → Providers', () => {
  it('shows status and test result, and edits an instance with a new secret', async () => {
    const user = userEvent.setup();
    const server = fakeServer(
      (method, params) => {
        if (method === 'secrets.set') return { secretRef: (params as { name: string }).name };
        if (method === 'dispatch') return { commandId: 'x', seqs: [2], duplicate: false };
        if (method === 'provider.test') {
          return { ok: false, account: null, version: null, message: 'Not logged in' };
        }
        return [];
      },
      { providerInstances: [work] },
    );
    await renderApp('/settings/providers', runtimeFor(server.connection));

    const row = within(await screen.findByRole('listitem', { name: 'Work' }));
    expect(row.getByTestId('provider-status').textContent).toBe('Error');
    expect(row.getByText('Not logged in')).toBeTruthy();
    await user.click(row.getByRole('button', { name: 'Test' }));
    expect(server.requests).toContainEqual({
      method: 'provider.test',
      params: { providerInstanceId: 'claude-work' },
    });

    await user.click(row.getByRole('button', { name: 'Edit' }));
    const editor = await screen.findByRole('dialog', { name: 'Edit Work' });
    const form = within(editor);
    expect(form.getByLabelText('Config folder')).toHaveProperty('value', '/home/me/.claude-work');
    expect(form.getByLabelText('Variable 1 value').getAttribute('placeholder')).toBe(
      'Stored. Type to replace.',
    );
    await user.click(form.getByRole('button', { name: 'Add variable' }));
    await user.type(form.getByLabelText('Variable 2 name'), 'HTTPS_PROXY');
    await user.type(form.getByLabelText('Variable 2 value'), 'http://proxy:8080');
    await user.click(form.getByRole('checkbox', { name: 'Variable 2 secret' }));
    await user.type(form.getByLabelText('Launch arguments'), '--verbose');
    await user.click(form.getByRole('combobox', { name: 'Default permissions' }));
    await user.click(await screen.findByRole('option', { name: 'Accept edits' }));
    await user.click(form.getByRole('button', { name: 'Save' }));

    expect(server.requests).toContainEqual({
      method: 'secrets.set',
      params: { name: 'provider:claude-work:env:HTTPS_PROXY', value: 'http://proxy:8080' },
    });
    expect(dispatched(server)).toContainEqual(
      expect.objectContaining({
        type: 'providerInstance.update',
        providerInstanceId: 'claude-work',
        env: {
          ANTHROPIC_API_KEY: { secretRef: 'provider:claude-work:env:ANTHROPIC_API_KEY' },
          HTTPS_PROXY: { secretRef: 'provider:claude-work:env:HTTPS_PROXY' },
        },
        launchArgs: ['--verbose'],
        defaultPermissionMode: 'acceptEdits',
      }),
    );
    expect(screen.queryByRole('dialog', { name: 'Edit Work' })).toBeNull();
    // Many typed keys through a full dialog; the default 5 s is tight on a loaded machine.
  }, 15_000);

  it('asks before removing an instance with stored secrets, and shows why the server refused', async () => {
    const user = userEvent.setup();
    const server = fakeServer(
      (method) => {
        if (method === 'dispatch') throw new Error('Work is used by 2 threads');
        return [];
      },
      { providerInstances: [work] },
    );
    await renderApp('/settings/providers', runtimeFor(server.connection));
    const row = within(await screen.findByRole('listitem', { name: 'Work' }));
    await user.click(row.getByRole('button', { name: 'Remove' }));
    expect(dispatched(server)).toEqual([]);
    const confirm = within(await screen.findByRole('alertdialog', { name: 'Remove Work?' }));
    await user.click(confirm.getByRole('button', { name: 'Remove' }));
    expect(dispatched(server)).toEqual([
      { type: 'providerInstance.delete', providerInstanceId: 'claude-work' },
    ]);
    expect((await row.findByRole('alert')).textContent).toBe('Work is used by 2 threads');
  });

  it('offers the Codex update, names the command, and shows the run the server stores', async () => {
    const user = userEvent.setup();
    const codex: ProviderInstance = {
      ...work,
      id: 'codex-work',
      kind: 'codex',
      name: 'Codex',
      env: {},
      status: 'error',
      version: '0.150.0',
      statusMessage: 'codex 0.150.0 is not compatible with wow. Update codex to 0.166.0.',
      update: {
        method: 'npm',
        targetVersion: '0.166.0',
        reason: 'incompatible',
        packageSpec: '@openai/codex@0.166.0',
        prefix: null,
      },
    };
    const server = fakeServer(
      (method) => (method === 'provider.update' ? { command: 'npm install -g x' } : []),
      { providerInstances: [codex] },
    );
    await renderApp('/settings/providers', runtimeFor(server.connection));
    const row = within(await screen.findByRole('listitem', { name: 'Codex' }));
    await user.click(row.getByRole('button', { name: 'Update Codex to 0.166.0' }));
    const confirm = within(
      await screen.findByRole('alertdialog', { name: 'Update Codex to 0.166.0?' }),
    );
    expect(confirm.getByTestId('provider-update-command').textContent).toBe(
      'npm install -g @openai/codex@0.166.0',
    );
    await user.click(confirm.getByRole('button', { name: 'Update' }));
    expect(server.requests.filter((request) => request.method === 'provider.update')).toEqual([
      { method: 'provider.update', params: { providerInstanceId: 'codex-work' } },
    ]);

    const run = {
      state: 'running' as const,
      command: 'npm install -g @openai/codex@0.166.0',
      targetVersion: '0.166.0',
      output: 'added 1 package',
      message: null,
      startedAt: '2026-11-03T10:00:00.000Z',
      endedAt: null,
    };
    server.publish('providerInstances', [{ ...codex, updateRun: run }]);
    expect(row.getByTestId('provider-update-run').textContent).toBe('Updating Codex to 0.166.0…');
    expect(row.getByText(/added 1 package/)).toBeTruthy();
    expect(row.queryByRole('button', { name: 'Update Codex to 0.166.0' })).toBeNull();
    server.publish('providerInstances', [
      {
        ...codex,
        status: 'ready',
        version: '0.166.0',
        statusMessage: null,
        update: null,
        updateRun: { ...run, state: 'succeeded', endedAt: '2026-11-03T10:01:00.000Z' },
      },
    ]);
    expect(row.getByTestId('provider-status').textContent).toBe('Ready');
    expect(row.getByTestId('provider-update-run').textContent).toBe(
      'Codex 0.166.0 installed. wow tested it again.',
    );
  });

  it('shows a different but compatible version as ready with a notice, and a manual update', async () => {
    const codex: ProviderInstance = {
      ...work,
      id: 'codex-brew',
      kind: 'codex',
      name: 'Codex',
      env: {},
      status: 'ready',
      version: '0.164.0',
      statusMessage: 'codex 0.164.0 differs from the tested 0.166.0; compatible.',
      update: {
        method: 'manual',
        targetVersion: '0.166.0',
        reason: 'older',
        instruction: 'codex was installed with Homebrew. Run "brew upgrade codex".',
      },
    };
    const server = fakeServer(() => [], { providerInstances: [codex] });
    await renderApp('/settings/providers', runtimeFor(server.connection));
    const row = within(await screen.findByRole('listitem', { name: 'Codex' }));
    expect(row.getByTestId('provider-status').textContent).toBe('Ready');
    expect(row.getByTestId('provider-notice').textContent).toBe(
      'codex 0.164.0 differs from the tested 0.166.0; compatible.',
    );
    expect(row.getByTestId('provider-update-instruction').textContent).toContain('brew upgrade');
    expect(row.queryByRole('button', { name: /Update Codex/ })).toBeNull();
  });
});
