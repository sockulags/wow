import type { Command, SetupApplication, SetupRead } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { renderApp } from '@/test/render';
import { setupCommands, setupStore } from './setup';

// Settings → Advanced for setup files (app assistant plan U5). The server's reading and
// applying are in apps/server/src/setup; e2e/setup-file.spec.ts runs it all against a server.

const at = '2026-11-11T09:00:00.000Z';

const ready: SetupRead = {
  outcome: 'ready',
  preview: {
    added: [{ what: 'Interval (Hosts)', from: '60 (default)', to: '600' }],
    replaced: [
      {
        what: 'Workflow "Delivery"',
        from: '1 step: deliver-work',
        to: '2 steps: deliver-work, check-work',
      },
    ],
    marked: [{ workflow: 'Brew report', reason: 'skill not installed: brew-report' }],
    toFillIn: [
      {
        key: 'trackers.github.token',
        label: 'GitHub token',
        place: { label: 'Settings → Trackers', path: '/settings/trackers' },
      },
    ],
  },
};

const refused: SetupRead = {
  outcome: 'refused',
  problems: [{ line: 4, reason: 'The file has a key wow does not know: "colour"' }],
};

const application = (extra: Partial<SetupApplication> = {}): SetupApplication => ({
  id: 'setup-1',
  at,
  name: 'team.yaml',
  ...ready.preview,
  state: 'applied',
  undoneAt: null,
  ...extra,
});

function runtimeWith(answer: SetupRead, applications: SetupApplication[] = []) {
  const sent: Command[] = [];
  const asked: { method: string; params: unknown }[] = [];
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: (method, params) => {
      asked.push({ method, params });
      if (method === 'setup.preview') return Promise.resolve(answer);
      if (method === 'setup.save') {
        return Promise.resolve({
          text: 'version: 1\n',
          fileName: 'wow-setup-2026-11-11.yaml',
          toFillIn: ['trackers.github.token'],
          leftOut: [],
        });
      }
      if (method === 'dispatch') {
        const { command, commandId } = params as { command: Command; commandId: string };
        sent.push(command);
        return Promise.resolve({ commandId, seqs: [1], duplicate: false });
      }
      return Promise.resolve([]);
    },
    subscribe(topic, _params, onData) {
      onData(topic === 'setupApplications' ? applications : []);
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
  return { runtime, sent, asked };
}

const yamlFile = (text: string) => new File([text], 'team.yaml', { type: 'application/yaml' });

afterEach(() => {
  setupStore.setState({ draft: undefined, pickWanted: false });
  vi.restoreAllMocks();
});

describe('Start from a setup file (spec 22)', () => {
  it('shows what would be added and replaced, the marks and what is left to fill in, and applies on confirm', async () => {
    const user = userEvent.setup();
    const { runtime, sent, asked } = runtimeWith(ready);
    await renderApp('/settings/advanced', runtime);
    await user.upload(screen.getByLabelText('Setup file to start from'), yamlFile('version: 1\n'));
    expect(asked).toContainEqual({ method: 'setup.preview', params: { text: 'version: 1\n' } });

    const dialog = await screen.findByRole('dialog', { name: 'Start from team.yaml' });
    const added = within(dialog).getByRole('region', { name: 'Added' });
    expect(added.textContent).toContain('Interval (Hosts): 60 (default) → 600');
    const replaced = within(dialog).getByRole('region', { name: 'Replaced' });
    expect(replaced.textContent).toContain(
      'Workflow "Delivery": 1 step: deliver-work → 2 steps: deliver-work, check-work',
    );
    expect(within(dialog).getByTestId('setup-mark').textContent).toBe(
      'Workflow "Brew report": skill not installed: brew-report',
    );
    expect(within(dialog).getByTestId('setup-fill-in').textContent).toContain('GitHub token');

    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(sent).toEqual([
      {
        type: 'setup.apply',
        applicationId: expect.any(String),
        name: 'team.yaml',
        text: 'version: 1\n',
      },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows a refused file with the line and the reason and offers no Apply', async () => {
    const user = userEvent.setup();
    const { runtime, sent } = runtimeWith(refused);
    await renderApp('/settings/advanced', runtime);
    await user.upload(
      screen.getByLabelText('Setup file to start from'),
      yamlFile('colour: blue\n'),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('setup-problem').textContent).toBe(
      'Line 4: The file has a key wow does not know: "colour"',
    );
    expect(within(dialog).queryByRole('button', { name: 'Apply' })).toBeNull();
    expect(sent).toEqual([]);
  });

  it('says nothing would change for a file this install already holds', async () => {
    const user = userEvent.setup();
    const { runtime } = runtimeWith({
      outcome: 'ready',
      preview: { added: [], replaced: [], marked: [], toFillIn: [] },
    });
    await renderApp('/settings/advanced', runtime);
    await user.upload(screen.getByLabelText('Setup file to start from'), yamlFile('version: 1\n'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Nothing would change');
    expect(within(dialog).queryByRole('button', { name: 'Apply' })).toBeNull();
  });
});

describe('Undo of an applied setup file', () => {
  it('sends setup.undo for an applied file and shows Undone for one undone', async () => {
    const user = userEvent.setup();
    const { runtime, sent } = runtimeWith(ready, [
      application({ id: 'old', name: 'old.yaml', state: 'undone', undoneAt: at }),
      application(),
    ]);
    await renderApp('/settings/advanced', runtime);
    const [newest, older] = screen.getAllByTestId('setup-application');
    expect(older?.textContent).toContain('Undone');
    await user.click(within(newest as HTMLElement).getByRole('button', { name: 'Undo' }));
    expect(sent).toEqual([{ type: 'setup.undo', applicationId: 'setup-1' }]);
  });
});

describe('Save setup to a file (spec 21)', () => {
  it('asks the server for the text and hands it over as a file', async () => {
    const user = userEvent.setup();
    const created = vi.fn<(blob: Blob) => string>(() => 'blob:setup');
    Object.assign(URL, {
      createObjectURL: created,
      revokeObjectURL: vi.fn<(url: string) => void>(),
    });
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { runtime, asked } = runtimeWith(ready);
    await renderApp('/settings/advanced', runtime);
    await user.click(screen.getByRole('button', { name: 'Save setup to a file' }));
    expect(asked.map(({ method }) => method)).toContain('setup.save');
    expect(clicked).toHaveBeenCalledOnce();
    expect(await created.mock.calls[0]?.[0].text()).toBe('version: 1\n');
    expect((clicked.mock.contexts[0] as HTMLAnchorElement).download).toBe(
      'wow-setup-2026-11-11.yaml',
    );
  });
});

describe('the palette', () => {
  it('saves, starts from a file, and undoes the newest applied file before typing', () => {
    const commands = setupCommands([
      application({ id: 'a', name: 'first.yaml' }),
      application({ id: 'b', name: 'second.yaml' }),
      application({ id: 'c', name: 'gone.yaml', state: 'undone', undoneAt: at }),
    ]);
    expect(
      commands.map((command) => [command.id, command.title, command.searchOnly ?? false]),
    ).toEqual([
      ['setup.save', 'Save setup to a file', false],
      ['setup.start', 'Start from a setup file', false],
      ['setup.undo.a', 'Undo setup from first.yaml', true],
      ['setup.undo.b', 'Undo setup from second.yaml', false],
    ]);
  });

  it('opens Settings → Advanced and its file picker for "Start from a setup file"', async () => {
    const user = userEvent.setup();
    const picked = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const { runtime } = runtimeWith(ready);
    const { router } = await renderApp('/calendar', runtime);
    await user.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog');
    await user.type(within(palette).getByRole('combobox'), 'start from a setup file');
    await user.keyboard('{Enter}');
    await screen.findByRole('button', { name: 'Start from a setup file' });
    expect(router.state.location.pathname).toBe('/settings/advanced');
    expect(picked).toHaveBeenCalledOnce();
    expect(setupStore.getState().pickWanted).toBe(false);
  });
});
