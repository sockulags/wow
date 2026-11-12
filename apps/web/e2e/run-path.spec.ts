import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { choose } from './controls';
import { e2eChangesHome, e2eChangesTrackerPort, e2eLimitWorkflowId } from './env';
import { sketchPath, sketching, sketchUse } from './sketch';

// Workflow branches U3 ground truth (spec 9, 18, 19, 20) against the Changes copy of the e2e
// server. The mock agent's review asks for changes the first time it looks and approves the
// second time; the review of the seeded limit workflow never approves.

if (sketching) test.use(sketchUse);

const intent = '2026-11-workflow-branches';

test.beforeEach(async ({ page }) => {
  // What the desktop preload injects: the contents of `~/.wow/server.json`.
  const info: unknown = JSON.parse(
    await readFile(path.join(e2eChangesHome, 'server.json'), 'utf8'),
  );
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

const builder = (page: Page) => page.getByRole('form', { name: 'Workflow builder' });
const tab = (page: Page, name: string) =>
  page.getByRole('tablist', { name: 'Run' }).getByRole('tab', { name, exact: true });
const visits = (page: Page) =>
  page.getByRole('list', { name: 'Run path' }).getByTestId('path-visit');
const steps = (page: Page) => page.getByRole('list', { name: 'Run steps' }).getByTestId('run-step');
const gate = (page: Page) => page.getByRole('region', { name: 'Gate' }).first();

test.describe('the path of a run', () => {
  test('a review sends the work back and the run shows its path', async ({ page }) => {
    // A workflow made from the Bug template has the review loop (spec 20).
    await page.goto('/workflows/new?template=bug');
    await builder(page).getByLabel('Workflow name').fill('Bug with a loop');
    await expect(
      builder(page).getByRole('list', { name: 'Step 2 rules' }).getByRole('listitem'),
    ).toHaveText([
      /the verdict is.*changes requested.*go to.*1\. deliver-work/,
      'Otherwise: the next step (this is the last step, so the run ends)',
    ]);
    await builder(page).getByLabel('Step 1 extra prompt').fill('Build the kettle.');
    await builder(page).getByLabel('Step 2 extra prompt').fill('Check the kettle until it holds.');
    await builder(page).getByRole('button', { name: 'Create workflow' }).click();
    await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);

    const runPanel = page.getByRole('group', { name: 'Run' });
    await choose(runPanel.getByLabel('Run in project'), 'Demo');
    await runPanel.getByRole('button', { name: 'Run now' }).click();
    await expect(page).toHaveURL(/\/workflows\/runs\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('run-state')).toHaveText('Done');

    // One row per step, each on its second attempt (spec 19).
    await expect(steps(page)).toHaveCount(2);
    await expect(steps(page).nth(0).getByTestId('step-attempt')).toHaveText('Attempt 2');
    await expect(steps(page).nth(1).getByTestId('step-attempt')).toHaveText('Attempt 2');
    await expect(steps(page).getByTestId('step-state')).toHaveText(['Done', 'Done']);

    // The path has a row per visit, with why the run went where it went next (spec 18). The
    // tab opens with its key.
    await page.keyboard.press('Control+Shift+Y');
    await expect(tab(page, 'Path')).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/\?tab=path$/);
    await expect(visits(page)).toHaveCount(4);
    await expect(visits(page).getByTestId('path-step')).toHaveText([
      'deliver-work',
      'check-work',
      'deliver-work',
      'check-work',
    ]);
    await expect(visits(page).getByTestId('path-attempt')).toHaveText([
      'attempt 1',
      'attempt 1',
      'attempt 2',
      'attempt 2',
    ]);
    await expect(visits(page).getByTestId('path-state')).toHaveText([
      'Done',
      'Done',
      'Done',
      'Done',
    ]);
    await expect(visits(page).getByTestId('path-why')).toHaveText([
      'next step',
      'verdict changes requested → deliver-work',
      'next step',
      'verdict approved: no rule held → End',
    ]);
    if (sketching) await page.screenshot({ path: sketchPath(intent, 'run-path') });

    // Both visits of the build step are one conversation: the rule's message is in its thread.
    await visits(page).nth(2).getByRole('link', { name: 'Open thread' }).click();
    await expect(page).toHaveURL(/\/chat\//);
    await expect(
      page.getByText('The step check-work sent the work back to this step'),
    ).toBeVisible();
    await expect(page.getByText('Second look: the lid is tight now.')).toBeVisible();
    await page.goBack();

    // The same key goes back to the steps.
    await expect(tab(page, 'Path')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Control+Shift+Y');
    await expect(tab(page, 'Steps')).toHaveAttribute('aria-selected', 'true');
  });

  test('a loop that never passes waits at the limit', async ({ page }) => {
    const query = new URLSearchParams({ workflowId: e2eLimitWorkflowId, runId: 'limit-e2e-run' });
    const started = await fetch(`http://127.0.0.1:${e2eChangesTrackerPort}/run?${query}`, {
      method: 'POST',
    });
    expect(started.ok).toBe(true);

    // The build step has started three times: the run waits for the user before a fourth
    // (spec 9), and the answers are to run it once more or to stop.
    await page.goto('/workflows/runs/limit-e2e-run');
    await expect(page.getByTestId('run-state')).toHaveText('Waiting for you');
    await expect(gate(page)).toContainText(
      'deliver-work has run 3 times: the limit. Run once more starts it again; Stop ends the run.',
    );
    await expect(gate(page).getByRole('button')).toHaveText(['Run once more', 'Stop']);
    await expect(steps(page).nth(0).getByTestId('step-state')).toHaveText('Waiting');
    await expect(steps(page).nth(0).getByTestId('step-attempt')).toHaveText('Attempt 3');
    // The step's model by its label, the id in a tooltip (agent workbench spec 86).
    const modelName = steps(page).nth(0).getByTestId('model-name');
    await expect(modelName).toHaveText('Mock model');
    await modelName.focus();
    await expect(page.getByRole('tooltip')).toContainText('mock-model');
    await expect(steps(page).nth(0).getByTestId('step-limit')).toHaveText(
      'deliver-work has run 3 times: the limit',
    );
    if (sketching) await page.screenshot({ path: sketchPath(intent, 'loop-limit') });

    await tab(page, 'Path').click();
    await expect(visits(page)).toHaveCount(6);
    await expect(visits(page).last().getByTestId('path-why')).toHaveText(
      'verdict changes requested → deliver-work · limit reached, waiting for you',
    );

    // Once more: the build runs a fourth time, and the run waits again before the review, which
    // has started three times itself.
    await gate(page).getByRole('button', { name: 'Run once more' }).click();
    await expect(gate(page)).toContainText('check-work has run 3 times: the limit.');
    await expect(visits(page)).toHaveCount(7);
    await expect(visits(page).nth(5).getByTestId('path-why')).toHaveText(
      'verdict changes requested → deliver-work · limit reached, waited for you',
    );
    await expect(visits(page).last().getByTestId('path-why')).toHaveText(
      'next step · limit reached, waiting for you',
    );
    await tab(page, 'Steps').click();
    await expect(steps(page).nth(0).getByTestId('step-attempt')).toHaveText('Attempt 4');
    await expect(steps(page).nth(1).getByTestId('step-limit')).toHaveText(
      'check-work has run 3 times: the limit',
    );

    await gate(page).getByRole('button', { name: 'Stop' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Stop run' }).click();
    await expect(page.getByTestId('run-state')).toHaveText('Stopped');
    await expect(page.getByRole('region', { name: 'Gate' })).toHaveCount(0);
  });
});
