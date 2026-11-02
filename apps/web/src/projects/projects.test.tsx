import type { Project, SubscriptionTopic } from '@wow/contracts';
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

// Settings → Projects and its palette commands against a fake server connection.

interface FakeServer {
  readonly connection: Connection;
  readonly commands: unknown[];
  publish(topic: SubscriptionTopic, rows: unknown[]): void;
}

// `refuse` answers a dispatch with an error, the way the server refuses a missing folder.
function fakeServer(
  initial: Partial<Record<SubscriptionTopic, unknown[]>>,
  refuse: (command: { type: string; cwd?: string }) => string | undefined = () => undefined,
): FakeServer {
  const rows = new Map<SubscriptionTopic, unknown[]>(
    Object.entries(initial) as [SubscriptionTopic, unknown[]][],
  );
  const listeners = new Map<SubscriptionTopic, Set<(data: unknown) => void>>();
  const commands: unknown[] = [];
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      if (method !== 'dispatch') return Promise.resolve([]);
      const { command } = params as { command: { type: string; cwd?: string } };
      const refused = refuse(command);
      if (refused) return Promise.reject(new Error(refused));
      commands.push(command);
      return Promise.resolve({ commandId: 'x', seqs: [1], duplicate: false });
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
    commands,
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

const wow: Project = {
  id: 'p1',
  name: 'wow',
  cwd: '/home/me/code/wow',
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: '2026-11-02T08:00:00.000Z',
};

// An instance, so the first-run wizard stays closed.
const instance = {
  id: 'claude-work',
  kind: 'claude',
  name: 'Work',
  binaryPath: '',
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
};

describe('Settings → Projects', () => {
  it('lists the projects and sits after Providers in the settings navigation', async () => {
    const server = fakeServer({ projects: [wow], providerInstances: [instance] });
    await renderApp('/settings/projects', runtimeFor(server.connection));
    const row = within(await screen.findByRole('listitem', { name: 'wow' }));
    expect(row.getByText('/home/me/code/wow')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Settings groups' });
    const links = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(links.slice(0, 2)).toEqual(['Providers', 'Projects']);
    expect(within(nav).getByRole('link', { name: 'Projects' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('creates a project and keeps the dialog open with the reason the server refused', async () => {
    const user = userEvent.setup();
    const server = fakeServer({ projects: [], providerInstances: [instance] }, (command) =>
      command.type === 'project.create' && command.cwd === '/nowhere'
        ? 'No folder /nowhere'
        : undefined,
    );
    await renderApp('/settings/projects', runtimeFor(server.connection));
    expect(await screen.findByText('No projects yet.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'New project' }));
    await user.click(dialog.getByRole('button', { name: 'Add project' }));
    expect(dialog.getByRole('alert').textContent).toBe('Give the project a name and a folder');

    await user.type(dialog.getByLabelText('Name'), ' Site ');
    await user.type(dialog.getByLabelText('Folder'), '/nowhere');
    await user.click(dialog.getByRole('button', { name: 'Add project' }));
    expect((await dialog.findByRole('alert')).textContent).toBe('No folder /nowhere');
    expect(server.commands).toEqual([]);

    await user.clear(dialog.getByLabelText('Folder'));
    await user.type(dialog.getByLabelText('Folder'), '/home/me/site');
    await user.click(dialog.getByRole('button', { name: 'Add project' }));
    expect(server.commands).toEqual([
      {
        type: 'project.create',
        projectId: expect.stringMatching(/^project-[0-9a-f]{8}$/),
        name: 'Site',
        cwd: '/home/me/site',
      },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renames and removes a project from its row', async () => {
    const user = userEvent.setup();
    const server = fakeServer({ projects: [wow], providerInstances: [instance] });
    await renderApp('/settings/projects', runtimeFor(server.connection));
    const row = within(await screen.findByRole('listitem', { name: 'wow' }));

    await user.click(row.getByRole('button', { name: 'Rename' }));
    const rename = within(await screen.findByRole('dialog', { name: 'Rename wow' }));
    expect(rename.getByLabelText('Name')).toHaveProperty('value', 'wow');
    await user.clear(rename.getByLabelText('Name'));
    await user.type(rename.getByLabelText('Name'), 'wow app');
    await user.click(rename.getByRole('button', { name: 'Save' }));
    expect(server.commands).toEqual([{ type: 'project.update', projectId: 'p1', name: 'wow app' }]);
    server.publish('projects', [{ ...wow, name: 'wow app' }]);

    const renamed = within(await screen.findByRole('listitem', { name: 'wow app' }));
    await user.click(renamed.getByRole('button', { name: 'Remove' }));
    const remove = within(await screen.findByRole('dialog', { name: 'Remove wow app?' }));
    expect(remove.getByText(/Threads keep working in the folder/)).toBeTruthy();
    await user.click(remove.getByRole('button', { name: 'Remove project' }));
    expect(server.commands.at(-1)).toEqual({ type: 'project.delete', projectId: 'p1' });
    server.publish('projects', []);
    expect(await screen.findByText('No projects yet.')).toBeTruthy();
  });
});

describe('project palette commands', () => {
  it('opens New project, and rename and remove for each project, from anywhere', async () => {
    const user = userEvent.setup();
    const server = fakeServer({ projects: [wow], providerInstances: [instance] });
    const { router } = await renderApp('/calendar', runtimeFor(server.connection));

    await user.keyboard('{Control>}k{/Control}');
    await user.type(within(await screen.findByRole('dialog')).getByRole('combobox'), 'new project');
    await user.keyboard('{Enter}');
    expect(router.state.location.pathname).toBe('/settings/projects');
    const create = await screen.findByRole('dialog', { name: 'New project' });
    await user.click(within(create).getByRole('button', { name: 'Cancel' }));

    await user.keyboard('{Control>}k{/Control}');
    await user.type(
      within(await screen.findByRole('dialog')).getByRole('combobox'),
      'rename project wow',
    );
    await user.keyboard('{Enter}');
    const rename = await screen.findByRole('dialog', { name: 'Rename wow' });
    await user.click(within(rename).getByRole('button', { name: 'Cancel' }));

    await user.keyboard('{Control>}k{/Control}');
    await user.type(
      within(await screen.findByRole('dialog')).getByRole('combobox'),
      'remove project wow',
    );
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Remove wow?' })).toBeTruthy();
  });
});
