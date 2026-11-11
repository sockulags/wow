import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  e2eChangesHome,
  e2eChangesTrackerPort,
  e2eGitLabProjectId,
  e2eHostProjectId,
  e2eHostWorkflowId,
  e2ePagesBacklogItemId,
} from './env';

// U13 ground truth (review loop spec 31, 32 and 35) against the Changes copy of the e2e server: a
// backlog item there is published to the mock Jira with a description that links to a page on
// the mock Confluence, and project `tea-garden`'s intent links to another one by space and title.
// Confluence is the global one the server seeds.
test.describe.configure({ mode: 'serial' });

const control = `http://127.0.0.1:${e2eChangesTrackerPort}`;

interface Asked {
  readonly method: string;
  readonly path: string;
}

const asked = async (): Promise<Asked[]> =>
  (await (await fetch(`${control}/confluence-host/requests`)).json()) as Asked[];

test.beforeEach(async ({ page }) => {
  const info: unknown = JSON.parse(
    await readFile(path.join(e2eChangesHome, 'server.json'), 'utf8'),
  );
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

test.afterEach(async () => {
  await fetch(`${control}/confluence-host/failure`, { method: 'DELETE' });
});

async function startRun(runId: string, projectId: string, backlogItemId?: string): Promise<void> {
  const query = new URLSearchParams({
    workflowId: e2eHostWorkflowId,
    projectId,
    runId,
    ...(backlogItemId ? { backlogItemId } : {}),
  });
  const response = await fetch(`${control}/run?${query}`, { method: 'POST' });
  expect(response.ok).toBe(true);
}

test.describe('pages', () => {
  test('a Confluence page beside a run @review-loop-31 @review-loop-35', async ({ page }) => {
    await startRun('pages-e2e-run', e2eHostProjectId, e2ePagesBacklogItemId);
    await page.goto('/workflows/runs/pages-e2e-run?tab=pages');
    const tab = page.getByRole('tabpanel', { name: 'Pages' });
    const list = tab.getByRole('list', { name: 'Linked pages' });

    // The page the ticket description links to and the one the intent links to, each with its
    // title and when it was fetched (spec 35).
    const schedule = list.getByTestId('page-id:123');
    const notes = list.getByTestId('page-title:ENG/Watering notes');
    await expect(schedule.getByRole('button', { name: 'Watering schedule' })).toBeVisible();
    await expect(schedule).toContainText('Linked from the ticket description');
    await expect(schedule.getByTestId('page-fetched')).toHaveText(/^Last fetched /);
    await expect(notes.getByRole('button', { name: 'Watering notes' })).toBeVisible();
    await expect(notes).toContainText('Linked from the intent');
    await expect(notes.getByTestId('page-fetched')).toHaveText(/^Last fetched /);
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(tab.getByTestId('host-fetched')).toHaveText(
      /^Last fetched .* from 127\.0\.0\.1:\d+$/,
    );

    // Opening one shows its body in the side panel, in a frame where nothing runs and nothing
    // loads, with "Open on host" and a line about pictures.
    await schedule.getByRole('button', { name: 'Watering schedule' }).click();
    const viewer = page.getByRole('region', { name: 'Page viewer' });
    await expect(viewer.getByTestId('page-viewer-title')).toHaveText('Watering schedule');
    await expect(viewer.getByRole('link', { name: 'Open on host' })).toHaveAttribute(
      'href',
      `${control}/confluence/spaces/ENG/pages/123`,
    );
    await expect(viewer.getByTestId('page-pictures-note')).toContainText('do not load here');
    await expect(viewer.getByTestId('page-frame')).toHaveAttribute('sandbox', '');
    const frame = page.frameLocator('[data-testid="page-frame"]');
    await expect(frame.getByRole('heading', { name: 'Watering schedule' })).toBeVisible();
    await expect(frame.locator('strong')).toHaveText('five');
    await expect(frame.locator('#ran')).toHaveCount(0);

    // Only the two linked pages were read: not the link to another path on the same host, and
    // not the picture.
    expect(new Set((await asked()).map((request) => `${request.method} ${request.path}`))).toEqual(
      new Set([
        'GET /rest/api/content/123?expand=body.view,version,space',
        'GET /rest/api/content?spaceKey=ENG&title=Watering%20notes&expand=body.view,version,space',
      ]),
    );

    // Back to the conversation puts the page away.
    await viewer.getByRole('button', { name: 'Back to conversation' }).click();
    await expect(viewer).toHaveCount(0);

    // Confluence refuses the token: the pages and their times stay, the error names the
    // setting (spec 31, 32).
    const fetched = await tab.getByTestId('host-fetched').textContent();
    await fetch(`${control}/confluence-host/failure?status=401`, { method: 'PUT' });
    await tab.getByRole('button', { name: 'Refresh now' }).click();
    await expect(tab.getByTestId('host-error')).toContainText(/refused the Confluence token \(401/);
    await expect(
      tab.getByTestId('host-error').getByRole('link', { name: /^Open .+ in Settings$/ }),
    ).toHaveAttribute('href', '/settings/trackers');
    await expect(tab.getByTestId('host-fetched')).toHaveText(fetched ?? '');
    await expect(schedule.getByRole('button', { name: 'Watering schedule' })).toBeVisible();
  });

  test('a run whose texts link to no page says so and reads nothing', async ({ page }) => {
    const before = (await asked()).length;
    await startRun('no-pages-e2e-run', e2eGitLabProjectId);
    await page.goto('/workflows/runs/no-pages-e2e-run?tab=pages');
    const tab = page.getByRole('tabpanel', { name: 'Pages' });
    await expect(tab.getByText(/No Confluence page is linked from this run/)).toBeVisible();
    await expect(tab.getByRole('list', { name: 'Linked pages' })).toHaveCount(0);
    expect(await asked()).toHaveLength(before);
  });
});
