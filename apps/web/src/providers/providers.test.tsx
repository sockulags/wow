import type { ProviderInstance, SubscriptionTopic } from '@wow/contracts';
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
import { renderApp } from '@/test/render';

// Settings → Providers and the first-run wizard against a fake server connection (spec 31, 32).

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

const runtimeFor = (connection: Connection): Runtime => ({
  connection,
  layout: createLayoutStore(),
  draft: createDraftStore(),
  settings: createSettingsStore(createMemorySettingsSource()),
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
};

const dispatched = (server: FakeServer) =>
  server.requests
    .filter((request) => request.method === 'dispatch')
    .map((request) => (request.params as { command: unknown }).command);

describe('first-run wizard', () => {
  it('opens when the server has no instance, creates the detected CLIs and tests them', async () => {
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
    await renderApp('/calendar', runtimeFor(server.connection));

    const wizard = await screen.findByRole('dialog', { name: 'Set up providers' });
    const list = await within(wizard).findByRole('list', { name: 'Detected providers' });
    expect(within(list).getByText('/opt/bin/claude')).toBeTruthy();
    expect(within(list).getByText('codex not found on PATH')).toBeTruthy();
    expect(within(list).getByRole('checkbox', { name: 'Claude' }).getAttribute('data-state')).toBe(
      'checked',
    );

    await user.click(within(wizard).getByRole('button', { name: 'Create and test' }));
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
    expect(form.getByLabelText('Config directory (CLAUDE_CONFIG_DIR)')).toHaveProperty(
      'value',
      '/home/me/.claude-work',
    );
    expect(form.getByLabelText('Variable 1 value').getAttribute('placeholder')).toBe(
      'Stored. Type to replace.',
    );
    await user.click(form.getByRole('button', { name: 'Add variable' }));
    await user.type(form.getByLabelText('Variable 2 name'), 'HTTPS_PROXY');
    await user.type(form.getByLabelText('Variable 2 value'), 'http://proxy:8080');
    await user.click(form.getByRole('checkbox', { name: 'Variable 2 secret' }));
    await user.type(form.getByLabelText('Launch arguments'), '--verbose');
    await user.click(form.getByRole('combobox', { name: 'Default permission mode' }));
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
  });

  it('asks before removing and shows why the server refused', async () => {
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
    await user.click(row.getByRole('button', { name: 'Remove Work' }));
    expect(dispatched(server)).toEqual([
      { type: 'providerInstance.delete', providerInstanceId: 'claude-work' },
    ]);
    expect((await row.findByRole('alert')).textContent).toBe('Work is used by 2 threads');
  });
});
