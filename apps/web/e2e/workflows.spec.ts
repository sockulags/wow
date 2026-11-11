import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { e2eHome } from './env';
import { choose } from './controls';

// U10 ground truth against the scripted mock provider (e2e/server.ts): build a workflow from the
// Feature template, run it in a project, the mock completes step 1, the gate shows, and Approve
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
    // Nothing to create yet: the button says why instead of failing on press (audit D-06).
    await expect(builder.getByRole('button', { name: 'Create workflow' })).toBeDisabled();
    const templates = builder.getByRole('group', { name: 'Start from' });
    await templates.getByRole('button', { name: 'Feature' }).click();
    await expect(templates.getByRole('button', { name: 'Feature' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(builder.getByLabel('Workflow name')).toHaveValue('Feature');
    await builder.getByLabel('Workflow name').fill('Feature e2e');

    const steps = builder.getByRole('list', { name: 'Steps' }).getByTestId('workflow-step');
    await expect(steps).toHaveCount(4);
    const first = steps.nth(0);
    await expect(first.getByLabel('Step 1 skill')).toHaveText('capture-intent');
    await expect(first.getByText('Turn a rough idea into an intent and a spec.')).toBeVisible();
    // Gates are the stops between steps.
    const gateAt = (name: string) => builder.getByRole('button', { name });
    await expect(gateAt('Gate between step 1 and step 2')).toHaveAttribute('aria-pressed', 'true');
    await expect(first.getByLabel('Step 1 expected artifacts')).toHaveValue(
      'intents/*/intent.md\nintents/*/spec.md',
    );
    await expect(steps.nth(1).getByLabel('Step 2 skill')).toHaveText('plan-work');
    await expect(gateAt('Gate between step 2 and step 3')).toHaveAttribute('aria-pressed', 'true');
    await expect(gateAt('Gate between step 3 and step 4')).toHaveAttribute('aria-pressed', 'false');
    for (const index of [0, 1, 2, 3]) {
      await expect(steps.nth(index).getByLabel('Model')).toContainText('Mock model');
    }
    // A gate toggles on and off where it sits.
    await gateAt('Gate between step 3 and step 4').click();
    await expect(gateAt('Gate between step 3 and step 4')).toHaveAttribute('aria-pressed', 'true');
    await gateAt('Gate between step 3 and step 4').click();
    await expect(gateAt('Gate between step 3 and step 4')).toHaveAttribute('aria-pressed', 'false');

    // Reordering with the keyboard-reachable buttons, then back.
    await steps.nth(3).getByRole('button', { name: 'Move step 4 up' }).click();
    await expect(steps.nth(2).getByLabel('Step 3 skill')).toHaveText('check-work');
    await steps.nth(2).getByRole('button', { name: 'Move step 3 down' }).click();
    await expect(steps.nth(3).getByLabel('Step 4 skill')).toHaveText('check-work');

    // The steps can become a template of their own (audit E-05).
    await builder.getByRole('button', { name: 'Save as template…' }).click();
    const saveTemplate = builder.getByRole('group', { name: 'Save as template' });
    await saveTemplate.getByLabel('Template name').fill('Feature e2e template');
    await saveTemplate.getByRole('button', { name: 'Save template' }).click();
    await expect(templates.getByRole('button', { name: 'Feature e2e template' })).toBeVisible();

    await builder.getByRole('button', { name: 'Create workflow' }).click();
    await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);
    await expect(
      page
        .getByRole('navigation', { name: 'Workflows' })
        .getByRole('link', { name: /Feature e2e/ }),
    ).toBeVisible();

    // Templates are for new workflows; a saved one says where it came from.
    await expect(page.getByTestId('based-on')).toHaveText('Based on Feature');
    const runPanel = page.getByRole('group', { name: 'Run' });
    await choose(runPanel.getByLabel('Run in project'), 'Demo');
    await runPanel.getByRole('button', { name: 'Run now' }).click();
    await expect(page).toHaveURL(/\/workflows\/runs\/[0-9a-f-]{36}$/);

    const runSteps = page.getByRole('list', { name: 'Run steps' }).getByTestId('run-step');
    const gate = page.getByRole('region', { name: 'Gate' });
    await expect(gate).toContainText('capture-intent finished. Approve starts plan-work.');
    await expect(page.getByTestId('run-state')).toHaveText('Waiting for you');
    // The finished step is done; the marker after it says the run waits (audit D-03).
    await expect(runSteps.nth(0).getByTestId('step-state')).toHaveText('Done');
    await expect(page.getByTestId('gate-marker')).toHaveCount(1);
    // At a gate the step's conversation and the gate bar are in the side panel (review loop
    // spec 14).
    await expect(
      page.getByRole('complementary', { name: 'Context panel' }).getByTestId('panel-step-thread'),
    ).toContainText('Step 1 of');
    await expect(runSteps.nth(1).getByTestId('step-state')).toHaveText('Not started');
    await expect(runSteps.nth(1).getByRole('link', { name: 'Open thread' })).toHaveCount(0);
    // Artifacts open in the side panel (e2e/panel.spec.ts); no file:// link is left.
    await expect(
      runSteps.nth(0).getByRole('button', { name: 'Open intents/demo/intent.md' }),
    ).toBeVisible();
    await expect(page.locator('a[href^="file:"]')).toHaveCount(0);

    await gate.getByRole('button', { name: 'Approve' }).click();
    await expect(runSteps.nth(0).getByTestId('step-state')).toHaveText('Done');
    await expect(runSteps.nth(1).getByTestId('step-state')).toHaveText('Done');
    await expect(gate).toContainText('plan-work finished. Approve starts deliver-work.');

    // Step 2's thread got the skill invocation and the handover from step 1.
    await runSteps.nth(1).getByRole('link', { name: 'Open thread' }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}\.step-[0-9a-f]{8}$/);
    const prompt = page.getByRole('list', { name: 'Conversation' }).getByTestId('item-user');
    await expect(prompt).toContainText('/plan-work');
    await expect(prompt).toContainText('The previous step (capture-intent) ended with');
    // The waiting step's thread answers the gate too (spec 9), and so does the palette there.
    const threadGate = page.getByRole('region', { name: 'Gate' });
    await expect(threadGate).toContainText('plan-work finished. Approve starts deliver-work.');
    await expect(threadGate.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(threadGate.getByRole('button', { name: 'Stop' })).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').getByRole('combobox').fill('run: approve');
    await expect(page.getByRole('dialog').getByRole('option').first()).toContainText(
      'Run: approve',
    );
    await page.keyboard.press('Escape');
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

    // Delete happens at once and Undo brings the workflow back (owner decision F-9).
    await page
      .getByRole('region', { name: 'Workflow definitions' })
      .getByRole('link', { name: /Feature e2e/ })
      .click();
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page).toHaveURL(/\/workflows$/);
    const list = page.getByRole('region', { name: 'Workflow definitions' });
    await expect(list.getByRole('link', { name: /Feature e2e/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(list.getByRole('link', { name: /Feature e2e/ })).toBeVisible();
  });
});
