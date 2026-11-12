import type { Project, Ticket, TicketRead, Workflow, WorkflowRun } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { loadMarkdown } from '@/test/markdown';
import { renderApp } from '@/test/render';
import { workflowCommands } from './commands';
import { emptyTicket } from './ticket-tab';

// The Ticket tab of a run (review loop spec 31 to 33) against a fake server. The data is
// invented.

beforeAll(loadMarkdown);

const T = '2026-11-03T09:00:00.000Z';

const project: Project = {
  id: 'tea',
  name: 'Tea',
  cwd: '/home/me/tea',
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: T,
};

const workflow: Workflow = {
  id: 'w',
  name: 'Deliver',
  templateKind: null,
  createdAt: T,
  updatedAt: T,
  steps: [
    {
      id: 'only',
      skillName: 'deliver-work',
      providerInstanceId: 'mock',
      model: 'mock-model',
      effort: 'default',
      permissionMode: 'default',
      gateBefore: true,
      gateAfter: false,
      expectedArtifacts: [],
    },
  ],
};

const run: WorkflowRun = {
  id: 'run-1',
  workflowId: 'w',
  projectId: 'tea',
  calendarItemId: null,
  backlogItemId: null,
  state: 'waiting',
  currentStep: 0,
  baseSha: null,
  baseFiles: null,
  steps: [{ stepId: 'only', state: 'not_started', artifactsFound: [] }],
  startedAt: T,
  endedAt: null,
};

const ticket: Ticket = {
  key: 'ABC-12',
  summary: 'Fix the kettle whistle',
  status: 'In Progress',
  assignee: 'Mira Invented',
  type: 'Bug',
  description:
    '## Steps\n1. Fill the kettle\n1. Wait for the **whistle**\n\n<img src=x onerror=alert(1)> [run](javascript:alert(1))',
  url: 'https://jira.example.invalid/browse/ABC-12',
};

const found: TicketRead = {
  id: 'run:run-1',
  projectId: 'tea',
  runId: 'run-1',
  host: 'jira',
  hostName: 'jira.example.invalid',
  key: 'ABC-12',
  source: 'pullRequest',
  ticket,
  fetchedAt: T,
  error: null,
};

function fake(read: TicketRead | undefined): Runtime {
  const topics: Readonly<Record<string, unknown[]>> = {
    workflowRuns: [run],
    workflows: [workflow],
    projects: [project],
    ticketReads: read ? [read] : [],
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method) {
      if (method === 'workflowRuns.detectArtifacts') return Promise.resolve(run);
      return Promise.resolve([]);
    },
    subscribe(topic, _params, onData) {
      onData(topics[topic] ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  return {
    connection,
    layout: createLayoutStore(),
    draft: createDraftStore(),
    settings: createSettingsStore(
      createMemorySettingsSource(undefined, { 'providers.offerSetup': false }),
    ),
  };
}

const tab = async () => within(await screen.findByRole('tabpanel', { name: 'Ticket' }));

describe('the Ticket tab', () => {
  it('shows key, summary, status, assignee, type and description with a link', async () => {
    await renderApp('/workflows/runs/run-1?tab=ticket', fake(found));
    const panel = await tab();
    const article = within(panel.getByRole('article', { name: 'Ticket ABC-12' }));
    expect(
      article.getByRole('link', { name: /ABC-12 Fix the kettle whistle/ }).getAttribute('href'),
    ).toBe('https://jira.example.invalid/browse/ABC-12');
    expect(article.getByTestId('ticket-status').textContent).toBe('In Progress');
    expect(article.getByTestId('ticket-type').textContent).toBe('Bug');
    expect(article.getByTestId('ticket-assignee').textContent).toBe('Mira Invented');
    expect(article.getByTestId('ticket-source').textContent).toBe("From the pull request's title");
    expect(panel.getByTestId('host-fetched').textContent).toContain('jira.example.invalid');
    expect(panel.getByRole('link', { name: 'Open on host' }).getAttribute('href')).toBe(
      'https://jira.example.invalid/browse/ABC-12',
    );
  });

  it('renders the description as markdown and runs none of it', async () => {
    await renderApp('/workflows/runs/run-1?tab=ticket', fake(found));
    const description = (await tab()).getByTestId('ticket-description');
    await within(description).findByRole('heading', { name: 'Steps' });
    expect(within(description).getByText('whistle').tagName).toBe('STRONG');
    expect(description.querySelector('img')).toBeNull();
    expect(description.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(within(description).queryByRole('link', { name: 'run' })).toBeNull();
  });

  it('says so when no ticket is found', async () => {
    await renderApp(
      '/workflows/runs/run-1?tab=ticket',
      fake({ ...found, key: null, source: null, ticket: null }),
    );
    expect((await tab()).getByText(/No Jira ticket was found for this run/)).toBeTruthy();
  });

  it('keeps the last ticket beside a refusal and points to the setting', async () => {
    await renderApp(
      '/workflows/runs/run-1?tab=ticket',
      fake({
        ...found,
        error: {
          kind: 'refused',
          message:
            'jira.example.invalid refused the Jira token (401: You are not authenticated.). Check the Jira token in Settings → Trackers.',
          setting: 'trackers.jira.token',
          at: '2026-11-03T09:10:00.000Z',
        },
      }),
    );
    const panel = await tab();
    const error = panel.getByTestId('host-error');
    expect(error.textContent).toContain('jira.example.invalid refused the Jira token');
    expect(
      within(error)
        .getByRole('link', { name: /^Open .+ in Settings$/ })
        .getAttribute('href'),
    ).toBe('/settings/trackers');
    expect(panel.getByRole('article', { name: 'Ticket ABC-12' })).toBeTruthy();
  });
});

describe('why there is no ticket', () => {
  it('says what is missing', () => {
    expect(emptyTicket(undefined)).toBe('Jira has not been asked about this run yet.');
    expect(
      emptyTicket({
        ...found,
        ticket: null,
        fetchedAt: null,
        error: { kind: 'failed', message: 'Down', setting: null, at: T },
      }),
    ).toBe('Jira could not be read, so ABC-12 has nothing to show yet.');
  });
});

const ids = (url: string | null) =>
  workflowCommands({
    workflows: [workflow],
    runs: [run],
    templates: [],
    openRun: run,
    runView: {
      runId: 'run-1',
      search: { tab: 'ticket' },
      changedFiles: [],
      project,
      ticket: { ...ticket, url },
    },
  }).map((command) => command.id);

describe('the ticket’s palette command', () => {
  it('opens the ticket only when its link is a web address', () => {
    expect(ids('https://jira.example.invalid/browse/ABC-12')).toContain('workflowRun.ticket.open');
    expect(ids(null)).not.toContain('workflowRun.ticket.open');
  });
});
