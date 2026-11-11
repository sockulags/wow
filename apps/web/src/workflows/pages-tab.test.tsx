import type { PageLink, PageRead, Project, Workflow, WorkflowRun } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { viewerCommands } from '@/panel/commands';
import { pageDocument } from '@/panel/viewer';
import { renderApp } from '@/test/render';
import { emptyPages } from './pages-tab';

// The Pages tab of a run and the page viewer in the side panel (review loop spec 31, 32 and 35)
// against a fake server. The data is invented.

const T = '2026-11-03T09:00:00.000Z';
const wiki = 'https://wiki.example.invalid';

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

const design: PageLink = {
  ref: 'id:123',
  link: `${wiki}/pages/viewpage.action?pageId=123`,
  source: 'ticket',
  page: {
    id: '123',
    title: 'Kettle design',
    space: 'ENG',
    version: 4,
    body: '<h1>Kettle design</h1><script>parent.ran = true</script>',
    url: `${wiki}/spaces/ENG/pages/123`,
  },
  fetchedAt: T,
  error: null,
};

const notes: PageLink = {
  ref: 'title:ENG/Design notes',
  link: `${wiki}/display/ENG/Design+notes`,
  source: 'intent',
  page: null,
  fetchedAt: null,
  error: {
    kind: 'refused',
    message:
      'wiki.example.invalid shows no page “Design notes” in space ENG to the Confluence token.',
    setting: 'trackers.confluence.token',
    at: T,
  },
};

const read = (pages: PageLink[], error: PageRead['error'] = null): PageRead => ({
  id: 'run:run-1',
  projectId: 'tea',
  runId: 'run-1',
  host: 'confluence',
  hostName: 'wiki.example.invalid',
  pages,
  fetchedAt: T,
  error,
});

function fake(pageRead: PageRead | undefined): { runtime: Runtime; asked: string[] } {
  const asked: string[] = [];
  const topics: Readonly<Record<string, unknown[]>> = {
    workflowRuns: [run],
    workflows: [workflow],
    projects: [project],
    pageReads: pageRead ? [pageRead] : [],
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method) {
      asked.push(method);
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
    asked,
    runtime: {
      connection,
      layout: createLayoutStore(),
      draft: createDraftStore(),
      settings: createSettingsStore(
        createMemorySettingsSource(undefined, { 'providers.offerSetup': false }),
      ),
    },
  };
}

const route = '/workflows/runs/run-1';
const tab = async () => within(await screen.findByRole('tabpanel', { name: 'Pages' }));

describe('the Pages tab', () => {
  it('lists the linked pages with title, where they were linked from and when fetched', async () => {
    await renderApp(`${route}?tab=pages`, fake(read([design, notes])).runtime);
    const panel = await tab();
    const list = within(panel.getByRole('list', { name: 'Linked pages' }));
    const first = within(list.getByTestId('page-id:123'));
    expect(first.getByRole('button', { name: 'Kettle design' })).toBeTruthy();
    expect(first.getByText('Linked from the ticket description')).toBeTruthy();
    expect(first.getByTestId('page-fetched').textContent).toMatch(/^Last fetched /);
    expect(first.getByRole('link', { name: 'Open on host' }).getAttribute('href')).toBe(
      `${wiki}/spaces/ENG/pages/123`,
    );
    // A page that could not be read keeps its link and says why, pointing to the setting.
    const second = within(list.getByTestId('page-title:ENG/Design notes'));
    expect(second.getByText('Design notes')).toBeTruthy();
    expect(second.queryByRole('button')).toBeNull();
    expect(second.getByTestId('page-fetched').textContent).toBe('Not fetched yet');
    expect(second.getByRole('alert').textContent).toContain('shows no page');
    expect(
      second.getByRole('link', { name: 'Open Confluence token in Settings' }).getAttribute('href'),
    ).toBe('/settings/trackers');
    expect(panel.getByTestId('host-fetched').textContent).toContain('wiki.example.invalid');
  });

  it('points a page too large to keep to its setting under Hosts', async () => {
    const large: PageLink = {
      ...notes,
      error: {
        kind: 'failed',
        message: 'wiki.example.invalid answered page 123 with 2000000 bytes, more than wow keeps.',
        setting: 'hosts.pageMaxBytes',
        at: T,
      },
    };
    await renderApp(`${route}?tab=pages`, fake(read([large])).runtime);
    const item = within((await tab()).getByTestId('page-title:ENG/Design notes'));
    expect(
      item
        .getByRole('link', { name: 'Open Largest Confluence page kept in Settings' })
        .getAttribute('href'),
    ).toBe('/settings/hosts');
  });

  it('says so when nothing links to a page, or Confluence was not asked yet', async () => {
    await renderApp(`${route}?tab=pages`, fake(read([])).runtime);
    expect((await tab()).getByText(/No Confluence page is linked from this run/)).toBeTruthy();
    expect(emptyPages(undefined)).toBe('Confluence has not been asked about this run yet.');
    expect(
      emptyPages(
        read([], { kind: 'notSetUp', message: 'Confluence is not set up', setting: null, at: T }),
      ),
    ).toContain('until the error above is fixed');
  });

  it('opens a page in the side panel in a frame where nothing runs, and back', async () => {
    const user = userEvent.setup();
    const { runtime } = fake(read([design]));
    await renderApp(`${route}?tab=pages`, runtime);
    await user.click((await tab()).getByRole('button', { name: 'Kettle design' }));
    const viewer = within(await screen.findByRole('region', { name: 'Page viewer' }));
    expect(viewer.getByTestId('page-viewer-title').textContent).toBe('Kettle design');
    expect(viewer.getByRole('link', { name: 'Open on host' }).getAttribute('href')).toBe(
      `${wiki}/spaces/ENG/pages/123`,
    );
    expect(viewer.getByTestId('page-pictures-note').textContent).toContain('do not load here');
    const frame = viewer.getByTestId('page-frame');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toBe(pageDocument(design.page?.body ?? ''));
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'");
    expect(frame.getAttribute('srcdoc')).not.toContain('script-src');

    await user.click(viewer.getByRole('button', { name: 'Back to conversation' }));
    expect(screen.queryByRole('region', { name: 'Page viewer' })).toBeNull();
    expect(runtime.layout.getState().page).toBeUndefined();
  });

  it('opens each read page from the palette, and the open one on the host', () => {
    const titles = (page?: { runId: string; ref: string; from: string }) =>
      viewerCommands({
        viewer: undefined,
        pathname: route,
        openRun: run,
        projects: [project],
        page,
        pageReads: [read([design, notes])],
      }).map((command) => command.title);
    expect(titles()).toEqual(['Open page: Kettle design']);
    expect(titles({ runId: 'run-1', ref: 'id:123', from: route })).toEqual([
      'Open page: Kettle design',
      'Back to conversation',
      'Open page on host: Kettle design',
    ]);
    // The page belongs to the view it was opened on.
    expect(titles({ runId: 'run-1', ref: 'id:123', from: '/chat' })).toEqual([
      'Open page: Kettle design',
    ]);
  });
});
