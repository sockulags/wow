import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  e2eChangesHome,
  e2eChangesTrackerPort,
  e2eEventBranch,
  e2eEventIntentId,
  e2eEventProjectId,
} from './env';
import { sketchPath, sketching, sketchUse } from './sketch';

// U9 ground truth (review loop spec 48, 49) against the Changes copy of the e2e server: project
// `tea-leaf` has a plan whose one unit has an open pull request on the mock GitHub. The test
// makes event triggers in the Triggers tab, merges the pull request through the mock host's
// control port and asks with "Refresh now", because that server polls once a day.

const control = `http://127.0.0.1:${e2eChangesTrackerPort}`;
const planPath = `/plans/${e2eEventProjectId}/${e2eEventIntentId}`;
const pullRequestUrl = `${control}/web/acme/tea-leaf/pull/21`;

// The screenshot of the Triggers tab is taken at the end of the same run.
if (sketching) test.use(sketchUse);

test.beforeEach(async ({ page }) => {
  // What the desktop preload injects: the contents of `~/.wow/server.json`.
  const info: unknown = JSON.parse(
    await readFile(path.join(e2eChangesHome, 'server.json'), 'utf8'),
  );
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

const status = (page: Page) => page.getByTestId('unit-U1').getByTestId('unit-status');
const refresh = (page: Page) =>
  page.getByRole('article').getByRole('button', { name: 'Refresh now' }).click();
const triggers = (page: Page) => page.getByRole('tabpanel', { name: 'Triggers' });

async function newTrigger(page: Page, event: string, workflow: string): Promise<void> {
  await triggers(page).getByRole('button', { name: 'New trigger' }).click();
  const dialog = page.getByRole('dialog', { name: 'New trigger' });
  const choose = async (field: string, option: string) => {
    await dialog.getByRole('combobox', { name: field }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
  };
  await choose('Project', 'Tea leaf');
  await choose('Event', event);
  await choose('Workflow', workflow);
  await dialog.getByRole('button', { name: 'Create trigger' }).click();
  await expect(dialog).toHaveCount(0);
}

test('a merged pull request starts a run @review-loop-48', async ({ page }) => {
  // The plan is followed, so its pull request is one wow reads: open, the unit claimed.
  await page.goto(planPath);
  await page.getByRole('switch', { name: 'Follow' }).click();
  await expect(status(page)).toHaveText('Claimed');

  // The Triggers tab of the Workflows view: New trigger asks for project, event and workflow.
  await page.goto('/workflows');
  await page.getByRole('tab', { name: 'Triggers' }).click();
  await expect(triggers(page).getByText('No event triggers yet')).toBeVisible();
  await newTrigger(page, 'Pull request merged', 'Tidy up after a merge');
  await newTrigger(page, 'Checks failed', 'Water the beds');
  const leaf = triggers(page).getByRole('region', { name: 'Tea leaf' });
  const merged = leaf.getByTestId('trigger-merged');
  await expect(merged).toContainText('Pull request merged starts Tidy up after a merge');
  await expect(merged.getByTestId('trigger-last-run')).toHaveText('On · No run started yet');
  // A trigger can be switched off and on again.
  const failed = leaf.getByRole('switch', { name: 'Checks failed → Water the beds: on' });
  await failed.click();
  await expect(failed).toHaveAttribute('aria-checked', 'false');
  await expect(leaf.getByTestId('trigger-checksFailed').getByTestId('trigger-last-run')).toHaveText(
    'Off · No run started yet',
  );

  // The same state read again starts nothing.
  await page.goto(planPath);
  await refresh(page);
  await expect(status(page)).toHaveText('Claimed');

  // The host shows the pull request merged: one run starts (spec 48).
  const response = await fetch(`${control}/github-leaf/merged`, { method: 'PUT' });
  expect(response.ok).toBe(true);
  await refresh(page);
  await expect(status(page)).toHaveText('Delivered');

  await page.goto('/workflows/triggers');
  await expect(merged.getByRole('link', { name: 'Last run it started' })).toBeVisible();
  if (sketching) {
    // Until the toast about the new run has gone.
    await expect(page.getByRole('status').filter({ hasText: 'Workflow run started' })).toHaveCount(
      0,
      { timeout: 15_000 },
    );
    await page.screenshot({ path: sketchPath('2026-11-review-loop', 'event-triggers') });
  }

  // Its run says what started it and worked in its own working copy; the step's prompt carries
  // the pull request's link, number and branch and the event.
  await merged.getByRole('link', { name: 'Last run it started' }).click();
  await expect(page.getByTestId('run-event')).toHaveText(
    `Started by an event: pull request merged on pull request #21 (${e2eEventBranch})`,
  );
  await expect(page.getByTestId('working-copy')).toBeVisible();
  await page.getByTestId('run-step').getByRole('link', { name: 'Open thread' }).click();
  await expect(
    page.getByText('This run was started by an event: pull request merged.').first(),
  ).toBeVisible();
  await expect(page.getByText(`Pull request #21: ${pullRequestUrl}`).first()).toBeVisible();
  await expect(page.getByText(`Branch: ${e2eEventBranch}`).first()).toBeVisible();

  // Reading the merged pull request again starts no second run (spec 49).
  await page.goto(planPath);
  await refresh(page);
  await expect(status(page)).toHaveText('Delivered');
  await page.goto('/workflows/triggers');
  await expect(
    page
      .getByRole('navigation', { name: 'Workflows' })
      .getByRole('region', { name: 'Runs' })
      .getByRole('link')
      .filter({ hasText: 'Tidy up after a merge' }),
  ).toHaveCount(1);
});
