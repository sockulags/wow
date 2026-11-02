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
import { uniqueName } from './model';

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
  discovered: unknown[] = [],
): FakeServer {
  const rows = new Map<SubscriptionTopic, unknown[]>(
    Object.entries(initial) as [SubscriptionTopic, unknown[]][],
  );
  const listeners = new Map<SubscriptionTopic, Set<(data: unknown) => void>>();
  const commands: unknown[] = [];
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      if (method === 'projects.discover') return Promise.resolve({ projects: discovered });
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
    retry: () => undefined,
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

const runtimeFor = (
  connection: Connection,
  pickFolder?: () => Promise<string | null>,
): Runtime => ({
  connection,
  pickFolder,
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
    expect(row.getByTestId('path-text').textContent).toBe('/home/me/code/wow');
    expect(row.getByText('0 threads · 0 cards')).toBeTruthy();
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
    expect(await screen.findByText('No projects yet')).toBeTruthy();

    await user.click(screen.getAllByRole('button', { name: 'Add project' })[0]!);
    const dialog = within(await screen.findByRole('dialog', { name: 'New project' }));
    await user.click(dialog.getByRole('button', { name: 'Add project' }));
    expect(dialog.getByRole('alert').textContent).toBe('Give the project a name and a folder');

    // The folder comes first and names the project until a name is typed (audit E-12).
    await user.type(dialog.getByLabelText('Folder'), '/nowhere');
    expect(dialog.getByLabelText('Name')).toHaveProperty('value', 'nowhere');
    await user.clear(dialog.getByLabelText('Name'));
    await user.type(dialog.getByLabelText('Name'), ' Site ');
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
    const remove = within(await screen.findByRole('alertdialog', { name: 'Remove wow app?' }));
    expect(remove.getByText(/Threads keep working in the folder/)).toBeTruthy();
    await user.click(remove.getByRole('button', { name: 'Remove' }));
    expect(server.commands.at(-1)).toEqual({ type: 'project.delete', projectId: 'p1' });
    server.publish('projects', []);
    expect(await screen.findByText('No projects yet')).toBeTruthy();
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
    expect(await screen.findByRole('alertdialog', { name: 'Remove wow?' })).toBeTruthy();
  });
});

describe('choosing the folder', () => {
  it('uses the desktop folder dialog instead of a typed path', async () => {
    const user = userEvent.setup();
    const server = fakeServer({ projects: [], providerInstances: [instance] });
    const answers: (string | null)[] = [null, '/home/me/picked'];
    const pickFolder = () => Promise.resolve(answers.shift() ?? null);
    await renderApp('/settings/projects', runtimeFor(server.connection, pickFolder));
    await user.click((await screen.findAllByRole('button', { name: 'Add project' }))[0]!);
    const dialog = within(await screen.findByRole('dialog', { name: 'New project' }));
    const folder = dialog.getByLabelText('Folder');
    expect(folder).toHaveProperty('readOnly', true);
    // Cancelling the system dialog leaves the field empty.
    await user.click(dialog.getByRole('button', { name: 'Choose folder…' }));
    expect(folder).toHaveProperty('value', '');
    await user.click(dialog.getByRole('button', { name: 'Choose folder…' }));
    expect(await dialog.findByDisplayValue('/home/me/picked')).toBeTruthy();
    await user.click(dialog.getByRole('button', { name: 'Add project' }));
    expect(server.commands).toEqual([
      expect.objectContaining({ type: 'project.create', name: 'picked', cwd: '/home/me/picked' }),
    ]);
  });
});

describe('Import from Claude and Codex', () => {
  const found = [
    {
      cwd: '/home/me/code/wow',
      name: 'wow',
      lastUsedAt: '2026-11-01T08:00:00.000Z',
      sources: [
        { providerInstanceId: 'claude-work', providerInstanceName: 'Work', kind: 'claude' },
        { providerInstanceId: 'codex', providerInstanceName: 'Codex', kind: 'codex' },
      ],
    },
    {
      cwd: '/home/me/code/site',
      name: 'site',
      lastUsedAt: null,
      sources: [{ providerInstanceId: 'codex', providerInstanceName: 'Codex', kind: 'codex' }],
    },
    {
      cwd: '/home/me/code/old',
      name: 'old',
      lastUsedAt: null,
      sources: [{ providerInstanceId: 'codex', providerInstanceName: 'Codex', kind: 'codex' }],
    },
  ];
  const elsewhere: Project = { ...wow, id: 'p0', cwd: '/elsewhere/wow' };

  it('lists the discovered folders as a checklist and imports the checked ones', async () => {
    const user = userEvent.setup();
    const server = fakeServer(
      { projects: [elsewhere], providerInstances: [instance] },
      undefined,
      found,
    );
    await renderApp('/settings/projects', runtimeFor(server.connection));
    await user.click(await screen.findByRole('button', { name: 'Import from Claude and Codex' }));
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Import from Claude and Codex' }),
    );
    const list = within(await dialog.findByRole('list', { name: 'Folders to import' }));
    expect(list.getAllByTestId('path-text')[0]?.textContent).toBe('/home/me/code/wow');
    // Kinds once each, and the last use in words (audit E-13).
    expect(list.getByText(/^Claude, Codex · last used /)).toBeTruthy();
    expect(list.getAllByText('Codex')).toHaveLength(2);
    expect(dialog.getByText('3 of 3 selected')).toBeTruthy();

    await user.click(list.getByRole('checkbox', { name: 'old' }));
    expect(dialog.getByText('2 of 3 selected')).toBeTruthy();
    await user.click(dialog.getByRole('button', { name: 'Import 2 projects' }));

    // "wow" is taken by the project in /elsewhere/wow, so the import gets a number.
    expect(server.commands).toEqual([
      expect.objectContaining({ type: 'project.create', name: 'wow 2', cwd: '/home/me/code/wow' }),
      expect.objectContaining({ type: 'project.create', name: 'site', cwd: '/home/me/code/site' }),
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the folders the server refused, with the reason', async () => {
    const user = userEvent.setup();
    const server = fakeServer(
      { projects: [], providerInstances: [instance] },
      (command) =>
        command.cwd === '/home/me/code/site' ? 'No folder /home/me/code/site' : undefined,
      found.slice(0, 2),
    );
    await renderApp('/calendar', runtimeFor(server.connection));
    await user.keyboard('{Control>}k{/Control}');
    await user.type(
      within(await screen.findByRole('dialog')).getByRole('combobox'),
      'import projects',
    );
    await user.keyboard('{Enter}');
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Import from Claude and Codex' }),
    );
    await user.click(await dialog.findByRole('button', { name: 'Import 2 projects' }));
    expect((await dialog.findByRole('alert')).textContent).toBe(
      '/home/me/code/site: No folder /home/me/code/site',
    );
    const list = within(dialog.getByRole('list', { name: 'Folders to import' }));
    expect(list.getAllByTestId('path-text').map((path) => path.textContent)).toEqual([
      '/home/me/code/site',
    ]);
  });

  it('says so when there is nothing new', async () => {
    const user = userEvent.setup();
    const server = fakeServer({ projects: [], providerInstances: [instance] });
    await renderApp('/settings/projects', runtimeFor(server.connection));
    await user.click(
      (await screen.findAllByRole('button', { name: 'Import from Claude and Codex' }))[0]!,
    );
    expect(await screen.findByText('Nothing new to import')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import 0 projects' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('uniqueName', () => {
  it('numbers a name another project has, ignoring case', () => {
    expect(uniqueName('site', ['wow'])).toBe('site');
    expect(uniqueName('wow', ['WOW', 'wow 2'])).toBe('wow 3');
  });
});
