import type { Command, HostRead, Project, Trigger, TriggerEvent, Workflow } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { outbox } from '@/test/outbox';
import { renderApp } from '@/test/render';
import { workflowCommands } from './commands';
import { triggerGroups, triggersHeld, triggersStore } from './triggers';

// The Triggers tab of the Workflows view (review loop spec 48, Interface) against a fake server
// that records the commands it is sent. The data is invented.

const route = '/workflows/triggers';

const project = (id: string, name: string): Project => ({
  id,
  name,
  cwd: `/home/me/${id}`,
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: '2026-11-02T08:00:00.000Z',
});
const projects = [project('tea', 'Tea timer'), project('kettle', 'Kettle')];

const workflow = (id: string, name: string): Workflow => ({
  id,
  name,
  templateKind: null,
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
  steps: [
    {
      id: 'only',
      skillName: 'deliver-work',
      providerInstanceId: 'mock',
      gateBefore: false,
      gateAfter: false,
      expectedArtifacts: [],
    },
  ],
});
const workflows = [workflow('fix', 'Fix the checks'), workflow('tidy', 'Tidy up after a merge')];

const eventTrigger = (
  id: string,
  event: TriggerEvent,
  workflowId: string,
  changes: Partial<Trigger> = {},
): Trigger => ({
  id,
  kind: 'event',
  workflowId,
  runId: null,
  calendarItemId: null,
  runAt: null,
  zone: null,
  state: null,
  offerRunNow: false,
  projectId: 'tea',
  event,
  enabled: true,
  createdAt: `2026-11-02T08:0${id.length}:00.000Z`,
  ...changes,
});

const cardTrigger: Trigger = {
  id: 'c1:trigger',
  kind: 'card',
  workflowId: 'fix',
  runId: null,
  calendarItemId: 'c1',
  runAt: '2026-11-02T09:00:00.000Z',
  zone: 'UTC',
  state: 'scheduled',
  offerRunNow: false,
  projectId: null,
  event: null,
  enabled: null,
  createdAt: null,
};

const merged = eventTrigger('a', 'merged', 'tidy', { runId: 'run-7' });
const failed = eventTrigger('bb', 'checksFailed', 'fix', { enabled: false });
const orphan = eventTrigger('ccc', 'commentAdded', 'gone', { projectId: 'kettle' });

// The last read of a project's code host, which says which host it is.
const gitlabRead = (projectId: string): HostRead => ({
  id: 'plan:kettle-plan',
  projectId,
  scope: 'plan',
  host: 'gitlab',
  hostName: 'gitlab.example.invalid',
  branch: null,
  changeRequestIds: [],
  fetchedAt: '2026-11-02T08:30:00.000Z',
  error: null,
});

function fake(
  rows: Trigger[],
  {
    refuse,
    settings = {},
    reads = [],
  }: { refuse?: string; settings?: Record<string, unknown>; reads?: HostRead[] } = {},
) {
  const box = outbox<Command>();
  const sent = box.sent;
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      if (method === 'dispatch') {
        if (refuse !== undefined) return Promise.reject(new Error(refuse));
        const { command, commandId } = params as { command: Command; commandId: string };
        box.record(command);
        return Promise.resolve({ commandId, seqs: [sent.length], duplicate: false });
      }
      return Promise.resolve([]);
    },
    subscribe(topic, _params, onData) {
      const topics: Readonly<Record<string, unknown[]>> = {
        triggers: rows,
        workflows,
        projects,
        hostReads: reads,
      };
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
      createMemorySettingsSource(undefined, { 'providers.offerSetup': false, ...settings }),
    ),
  };
  return { runtime, sent, until: box.until };
}

const panel = async () => within(await screen.findByRole('tabpanel', { name: 'Triggers' }));

beforeEach(() =>
  triggersStore.setState({ draft: undefined, draftError: undefined, error: undefined }),
);

describe('trigger rows', () => {
  it('groups event triggers by project name, leaves card triggers out and names a workflow that is gone', () => {
    const groups = triggerGroups([orphan, cardTrigger, failed, merged], projects, workflows);
    expect(
      groups.map((group) => [
        group.project,
        group.rows.map((row) => [row.event, row.workflow, row.trigger.enabled]),
      ]),
    ).toEqual([
      ['Kettle', [['Review comment added', undefined, true]]],
      [
        'Tea timer',
        [
          ['Pull request merged', 'Tidy up after a merge', true],
          ['Checks failed', 'Fix the checks', false],
        ],
      ],
    ]);
  });

  it('says "Merge request merged" for a project whose code host is GitLab', () => {
    const groups = triggerGroups([merged], projects, workflows, [gitlabRead('tea')]);
    expect(groups[0]?.rows[0]?.event).toBe('Merge request merged');
  });

  it('says why nothing starts while event triggers are off or the scheduler is paused (spec 52)', () => {
    expect(triggersHeld(true, false)).toBeUndefined();
    expect(triggersHeld(false, false)).toMatch(/^Event triggers are switched off/);
    expect(triggersHeld(true, true)).toMatch(/^The scheduler is paused/);
  });
});

describe('Triggers tab', () => {
  it('is a tab of the Workflows view that lists the event triggers per project with their switch and last run', async () => {
    await renderApp(route, fake([merged, failed, orphan, cardTrigger]).runtime);
    const tabs = within(await screen.findByRole('tablist', { name: 'Workflows view' }));
    expect(tabs.getByRole('tab', { name: 'Triggers3' }).getAttribute('aria-selected')).toBe('true');
    expect(tabs.getByRole('tab', { name: 'Workflows' }).getAttribute('aria-selected')).toBe(
      'false',
    );

    const shown = await panel();
    const tea = within(shown.getByRole('region', { name: 'Tea timer' }));
    const on = tea.getByRole('switch', {
      name: 'Pull request merged → Tidy up after a merge: on',
    });
    expect(on.getAttribute('aria-checked')).toBe('true');
    expect(
      tea
        .getByRole('switch', { name: 'Checks failed → Fix the checks: on' })
        .getAttribute('aria-checked'),
    ).toBe('false');
    expect(tea.getByRole('link', { name: 'Last run it started' }).getAttribute('href')).toBe(
      '/workflows/runs/run-7',
    );
    expect(
      within(shown.getByRole('region', { name: 'Kettle' })).getByText('a workflow that is gone'),
    ).toBeTruthy();
    expect(shown.queryByTestId('triggers-held')).toBeNull();
  });

  it('switches a trigger off and deletes one', async () => {
    const user = userEvent.setup();
    const { runtime, sent, until } = fake([merged, failed]);
    await renderApp(route, runtime);
    const shown = await panel();
    await user.click(
      shown.getByRole('switch', { name: 'Pull request merged → Tidy up after a merge: on' }),
    );
    await user.click(
      shown.getByRole('button', { name: 'Delete trigger: Checks failed → Fix the checks' }),
    );
    await act(() => until((commands) => commands.length === 2));
    expect(sent).toEqual([
      { type: 'trigger.setEnabled', triggerId: 'a', enabled: false },
      { type: 'trigger.delete', triggerId: 'bb' },
    ]);
  });

  it('asks for project, event and workflow in New trigger and creates it', async () => {
    const user = userEvent.setup();
    const { runtime, sent, until } = fake([]);
    await renderApp(route, runtime);
    await user.click(await screen.findByRole('button', { name: 'New trigger' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'New trigger' }));

    // Nothing chosen: it says what is missing and sends nothing.
    await user.click(dialog.getByRole('button', { name: 'Create trigger' }));
    expect((await dialog.findByRole('alert')).textContent).toBe(
      'Choose the project whose pull requests the trigger listens to',
    );
    expect(sent).toEqual([]);

    const choose = async (field: string, option: string) => {
      await user.click(dialog.getByRole('combobox', { name: field }));
      await user.click(await screen.findByRole('option', { name: option }));
    };
    await choose('Project', 'Tea timer');
    await choose('Event', 'Checks failed');
    await choose('Workflow', 'Fix the checks');
    await user.click(dialog.getByRole('button', { name: 'Create trigger' }));

    await act(() => until((commands) => commands.length > 0));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'trigger.create',
      projectId: 'tea',
      event: 'checksFailed',
      workflowId: 'fix',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers "Merge request merged" in New trigger once a GitLab project is chosen', async () => {
    const user = userEvent.setup();
    const { runtime } = fake([], { reads: [gitlabRead('kettle')] });
    await renderApp(route, runtime);
    triggersStore.setState({ draft: { projectId: 'kettle', event: '', workflowId: '' } });
    const dialog = within(await screen.findByRole('dialog', { name: 'New trigger' }));
    await user.click(dialog.getByRole('combobox', { name: 'Event' }));
    expect(await screen.findByRole('option', { name: 'Merge request merged' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Pull request merged' })).toBeNull();
  });

  it('keeps the dialog open with what the server said when it refuses', async () => {
    const user = userEvent.setup();
    const refuse = 'Tea timer already has a trigger that starts Fix the checks for "Checks failed"';
    const { runtime } = fake([], { refuse });
    await renderApp(route, runtime);
    triggersStore.setState({
      draft: { projectId: 'tea', event: 'checksFailed', workflowId: 'fix' },
    });
    const dialog = within(await screen.findByRole('dialog', { name: 'New trigger' }));
    await user.click(dialog.getByRole('button', { name: 'Create trigger' }));
    expect((await dialog.findByRole('alert')).textContent).toBe(refuse);
  });

  it('says so while event triggers are switched off', async () => {
    await renderApp(
      route,
      fake([merged], { settings: { 'triggers.eventsEnabled': false } }).runtime,
    );
    expect((await (await panel()).findByTestId('triggers-held')).textContent).toMatch(
      /^Event triggers are switched off/,
    );
  });
});

const commands = (onTriggers: boolean) =>
  workflowCommands({
    workflows,
    runs: [],
    templates: [],
    openRun: undefined,
    triggers: [merged, failed, cardTrigger],
    projects,
    onTriggers,
  });

describe('palette commands', () => {
  it('offers the tab, New event trigger, and a switch and a delete for every event trigger', () => {
    const listed = commands(true).filter(
      (command) => command.id.startsWith('trigger.') || command.id === 'workflows.triggers',
    );
    expect(listed.map((command) => [command.id, command.title, command.searchOnly])).toEqual([
      ['workflows.triggers', 'Go to event triggers', undefined],
      ['trigger.new', 'New event trigger', undefined],
      [
        'trigger.toggle.a',
        'Turn off trigger: Tea timer · Pull request merged → Tidy up after a merge',
        false,
      ],
      [
        'trigger.delete.a',
        'Delete trigger: Tea timer · Pull request merged → Tidy up after a merge',
        false,
      ],
      ['trigger.toggle.bb', 'Turn on trigger: Tea timer · Checks failed → Fix the checks', false],
      ['trigger.delete.bb', 'Delete trigger: Tea timer · Checks failed → Fix the checks', false],
    ]);
    // Elsewhere a single trigger's commands show only once the user types.
    expect(
      commands(false)
        .filter((command) => /^trigger\.(toggle|delete)\./.test(command.id))
        .every((command) => command.searchOnly === true),
    ).toBe(true);
  });

  it('opens the New trigger dialog from the palette', () => {
    const to: unknown[] = [];
    const context = { navigate: (target: unknown) => to.push(target) } as unknown as Parameters<
      ReturnType<typeof commands>[number]['run']
    >[0];
    commands(false)
      .find((command) => command.id === 'trigger.new')
      ?.run(context);
    expect(triggersStore.getState().draft).toEqual({ projectId: '', event: '', workflowId: '' });
    expect(to).toEqual([{ to: '/workflows/triggers' }]);
  });
});
