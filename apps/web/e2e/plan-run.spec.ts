import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  e2eChangesHome,
  e2eChangesTrackerPort,
  e2ePlanRunIntentId,
  e2ePlanRunProjectId,
} from './env';
import { sketchPath, sketching, sketchUse } from './sketch';

// U8 ground truth (review loop spec 40, 41, 44) against the Changes copy of the e2e server:
// project `tea-pot` has a plan with three units and no pull request yet, and a workflow marked
// "For units" whose mock agent opens the unit's pull request on the mock GitHub. The test merges
// pull requests through the mock host's control port and asks with "Refresh now", because that
// server polls once a day.

const control = `http://127.0.0.1:${e2eChangesTrackerPort}`;
const planPath = `/plans/${e2ePlanRunProjectId}/${e2ePlanRunIntentId}`;

// The screenshot of the plan run is taken in the middle of the same run.
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

async function merge(unit: string): Promise<void> {
  const response = await fetch(`${control}/github-pot/merged?unit=${unit}`, { method: 'PUT' });
  expect(response.ok).toBe(true);
}

const status = (page: Page, key: string) =>
  page.getByTestId(`unit-${key}`).getByTestId('unit-status');
const planRun = (page: Page) => page.getByRole('region', { name: 'Plan run' });
const waitingFor = (page: Page) => planRun(page).getByTestId('plan-run-waiting').locator('li');
const refresh = (page: Page) =>
  page.getByRole('article').getByRole('button', { name: 'Refresh now' }).click();

// A unit run makes its own working copy (a git worktree and a fetch) before its step starts,
// which takes several seconds on Windows: longer than an assertion waits by default.
const unitRun = { timeout: 15_000 };

test('a plan run works through ready units @review-loop-40 @review-loop-41', async ({ page }) => {
  // Three unit runs, each with its own working copy: on Windows they alone use most of the
  // default time for one test.
  test.slow();
  await page.goto(planPath);
  await expect(
    page.getByRole('heading', { name: /A tea pot that pours without dripping/ }),
  ).toBeVisible();

  // Only a followed plan has ready units, and the view says so.
  await expect(page.getByRole('button', { name: 'Run ready units' })).toBeDisabled();
  await expect(page.getByTestId('plan-run-blocked')).toContainText('Follow the plan first');
  await page.getByRole('switch', { name: 'Follow' }).click();
  await expect(status(page, 'U1')).toHaveText('Ready');
  await expect(status(page, 'U2')).toHaveText('Waiting');
  await expect(status(page, 'U3')).toHaveText('Ready');

  // U1 and then U3 run, one after the other, each as an ordinary run (spec 40, 41).
  await page.getByRole('button', { name: 'Run ready units' }).click();
  await expect(planRun(page).getByTestId('plan-run-unit-U1')).toContainText('Done', unitRun);
  await expect(planRun(page).getByTestId('plan-run-unit-U3')).toContainText('Done', unitRun);
  await expect(planRun(page).getByTestId('plan-run-unit-U2')).toHaveCount(0);

  // Only U2 remains and U1 is not merged: the plan run waits and says for what (spec 41).
  await expect(planRun(page).getByTestId('plan-run-state')).toHaveText('Waiting');
  await expect(waitingFor(page)).toHaveText([
    'U1 waits for its pull request to merge',
    'U2 waits for U1 to merge',
    'U3 waits for its pull request to merge',
  ]);
  await expect(status(page, 'U1')).toHaveText('Claimed');
  await expect(status(page, 'U3')).toHaveText('Claimed');
  // One unit at a time: no second plan run beside this one.
  await expect(page.getByRole('button', { name: 'Run ready units' })).toBeDisabled();
  if (sketching) {
    await page.screenshot({ path: sketchPath('2026-11-review-loop', 'plan-run') });
  }

  // The unit's run is an ordinary run in its own working copy, and its step was told the intent
  // id, unit key and title (spec 40): its thread shows the prompt, and the mock agent answers
  // with what the prompt said.
  await planRun(page).getByRole('link', { name: 'U1 Shape the pot' }).click();
  await expect(page.getByTestId('run-unit')).toHaveText(
    `Unit U1 Shape the pot of ${e2ePlanRunIntentId}`,
  );
  await expect(page.getByTestId('working-copy')).toBeVisible();
  await page.getByRole('link', { name: 'Open thread' }).click();
  await expect(page.getByText('Unit: U1 Shape the pot').first()).toBeVisible();
  await expect(page.getByText(`Intent: ${e2ePlanRunIntentId}`).first()).toBeVisible();
  await expect(
    page.getByText(`Delivered U1 of ${e2ePlanRunIntentId}: Shape the pot`).first(),
  ).toBeVisible();
  await page.goto(planPath);
  await expect(planRun(page)).toBeVisible();

  // The host shows U1 merged: U2 starts (spec 41).
  await merge('U1');
  await refresh(page);
  await expect(status(page, 'U1')).toHaveText('Delivered');
  await expect(planRun(page).getByTestId('plan-run-unit-U2')).toContainText('Done', unitRun);
  await expect(waitingFor(page)).toHaveText([
    'U2 waits for its pull request to merge',
    'U3 waits for its pull request to merge',
  ]);

  // Every unit delivered: the plan run is done (spec 44).
  await merge('U2');
  await merge('U3');
  await refresh(page);
  await expect(planRun(page).getByTestId('plan-run-state')).toHaveText('Done');
  await expect(planRun(page).getByTestId('plan-run-message')).toHaveText(
    'Every unit is delivered.',
  );
  await expect(planRun(page).getByRole('button', { name: 'Stop' })).toHaveCount(0);
});
