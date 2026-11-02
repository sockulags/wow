import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { e2eHome } from './env';
import { choose } from './controls';

// U10 ground truth against the scripted mock provider (e2e/server.ts): build a workflow from the
// Feature template, run it in a project, the mock completes step 1, the gate shows, and Continue
// starts step 2 with the handover (behaviors 24, 25, 26, 11).

test.beforeEach(async ({ page }) => {
  // What the desktop preload injects: the contents of `~/.wow/server.json`.
  const info: unknown = JSON.parse(await readFile(path.join(e2eHome, 'server.json'), 'utf8'));
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

test.describe('workflows', () => {
  test('builds from the Feature template, runs, stops at the gate and continues', async ({
    page,
  }) => {
    await page.goto('/workflows');
    await page.getByRole('navigation', { name: 'Workflows' }).getByText('New workflow').click();
    await expect(page).toHaveURL(/\/workflows\/new$/);

    const builder = page.getByRole('form', { name: 'Workflow builder' });
    await builder
      .getByRole('group', { name: 'Start from template' })
      .getByRole('button', { name: 'Feature' })
      .click();
    await expect(builder.getByLabel('Workflow name')).toHaveValue('Feature');
    await expect(builder.getByLabel('Template kind')).toHaveText('Feature');
    await builder.getByLabel('Workflow name').fill('Feature e2e');

    const steps = builder.getByRole('list', { name: 'Steps' }).getByTestId('workflow-step');
    await expect(steps).toHaveCount(4);
    const first = steps.nth(0);
    await expect(first.getByLabel('Step 1 skill')).toHaveText('capture-intent');
    await expect(first.getByText('Turn a rough idea into an intent and a spec.')).toBeVisible();
    await expect(first.getByLabel('Step 1 gate after')).toBeChecked();
    await expect(first.getByLabel('Step 1 expected artifacts')).toHaveValue(
      'intents/*/intent.md\nintents/*/spec.md',
    );
    await expect(steps.nth(1).getByLabel('Step 2 skill')).toHaveText('plan-work');
    await expect(steps.nth(1).getByLabel('Step 2 gate after')).toBeChecked();
    await expect(steps.nth(2).getByLabel('Step 3 gate after')).not.toBeChecked();
    for (const index of [0, 1, 2, 3]) {
      await expect(steps.nth(index).getByLabel('Model')).toHaveText('Mock model');
    }

    // Reordering with the keyboard-reachable buttons, then back.
    await steps.nth(3).getByRole('button', { name: 'Move step 4 up' }).click();
    await expect(steps.nth(2).getByLabel('Step 3 skill')).toHaveText('check-work');
    await steps.nth(2).getByRole('button', { name: 'Move step 3 down' }).click();
    await expect(steps.nth(3).getByLabel('Step 4 skill')).toHaveText('check-work');

    await builder.getByRole('button', { name: 'Create workflow' }).click();
    await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);
    await expect(
      page
        .getByRole('navigation', { name: 'Workflows' })
        .getByRole('link', { name: /Feature e2e/ }),
    ).toBeVisible();

    const runPanel = page.getByRole('region', { name: 'Run' });
    await choose(runPanel.getByLabel('Run in project'), 'Demo');
    await runPanel.getByRole('button', { name: 'Run now' }).click();
    await expect(page).toHaveURL(/\/workflows\/runs\/[0-9a-f-]{36}$/);

    const runSteps = page.getByRole('list', { name: 'Run steps' }).getByTestId('run-step');
    const gate = page.getByRole('region', { name: 'Gate' });
    await expect(gate).toContainText('capture-intent finished. Continue starts plan-work.');
    await expect(page.getByTestId('run-state')).toHaveText('Waiting for you');
    await expect(runSteps.nth(0).getByTestId('step-state')).toHaveText('Waiting');
    await expect(runSteps.nth(1).getByTestId('step-state')).toHaveText('Not started');
    await expect(runSteps.nth(1).getByRole('link', { name: 'Open thread' })).toHaveCount(0);
    await expect(
      runSteps.nth(0).getByRole('link', { name: 'Open intents/demo/intent.md' }),
    ).toHaveAttribute('href', /^file:\/\/.*\/intents\/demo\/intent\.md$/);

    await gate.getByRole('button', { name: 'Continue' }).click();
    await expect(runSteps.nth(0).getByTestId('step-state')).toHaveText('Done');
    await expect(runSteps.nth(1).getByTestId('step-state')).toHaveText('Waiting');
    await expect(gate).toContainText('plan-work finished. Continue starts deliver-work.');

    // Step 2's thread got the skill invocation and the handover from step 1.
    await runSteps.nth(1).getByRole('link', { name: 'Open thread' }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}\.step-[0-9a-f]{8}$/);
    const prompt = page.getByRole('list', { name: 'Conversation' }).getByTestId('item-user');
    await expect(prompt).toContainText('/plan-work');
    await expect(prompt).toContainText('The previous step (capture-intent) ended with');
    await page.goBack();

    // The palette stops the open run; its threads stay.
    await expect(gate).toBeVisible();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await palette.getByRole('combobox').fill('stop run');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('run-state')).toHaveText('Stopped');
    await expect(gate).toBeHidden();
    await expect(runSteps.nth(1).getByRole('link', { name: 'Open thread' })).toBeVisible();
  });
});
