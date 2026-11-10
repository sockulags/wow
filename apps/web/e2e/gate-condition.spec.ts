import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  e2eChangesHome,
  e2eChangesTrackerPort,
  e2eConditionWorkflowId,
  e2ePlanningWorkflowId,
} from './env';
import { sketchPath, sketching, sketchUse } from './sketch';

// U10 ground truth (review loop spec 54, 55, 57) against the Changes copy of the e2e server.
// The mock agent ends its check with APPROVED, or with CHANGES_REQUESTED when the step's extra
// prompt asks it to check strictly. The first test changes the workflow, so the tests run in
// order.
test.describe.configure({ mode: 'serial' });

// The screenshot of the builder is taken in the first test.
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

async function startRun(workflowId: string, runId: string): Promise<void> {
  const query = new URLSearchParams({ workflowId, runId });
  const response = await fetch(`http://127.0.0.1:${e2eChangesTrackerPort}/run?${query}`, {
    method: 'POST',
  });
  expect(response.ok).toBe(true);
}

const gate = (page: Page) => page.getByRole('region', { name: 'Gate' }).first();
const steps = (page: Page) => page.getByRole('list', { name: 'Run steps' }).getByTestId('run-step');
const condition = (page: Page) =>
  page.getByRole('group', { name: 'Pass the gate after step 1 by itself when' });
const save = async (page: Page) => {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
};

test.describe('gate conditions', () => {
  test('a gate passes by itself @review-loop-54 @review-loop-55', async ({ page }) => {
    // The gate after the check gets its condition in the builder, stored with Save.
    await page.goto(`/workflows/${e2eConditionWorkflowId}`);
    const verdict = condition(page).getByRole('checkbox', {
      name: 'The final message ends with the approved verdict',
    });
    await expect(condition(page).getByRole('checkbox')).toHaveCount(3);
    await expect(verdict).toHaveAttribute('aria-checked', 'false');
    await verdict.click();
    await save(page);
    await page.reload();
    await expect(verdict).toHaveAttribute('aria-checked', 'true');
    if (sketching) {
      await page.getByRole('button', { name: 'Expand step 1' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toHaveCount(0, {
        timeout: 15_000,
      });
      await page.screenshot({ path: sketchPath('2026-11-review-loop', 'builder-gate-condition') });
    }

    // The check ends with APPROVED: nobody is asked, the next step runs, and the step says why
    // its gate passed (spec 54, 58). The run then waits at the wrap up step's ordinary gate.
    await startRun(e2eConditionWorkflowId, 'condition-e2e-passes');
    await page.goto('/workflows/runs/condition-e2e-passes');
    await expect(gate(page)).toContainText('learn-work finished. Approve ends the run.');
    const check = steps(page).nth(0);
    await expect(check.getByTestId('step-state')).toHaveText('Done');
    await expect(check.getByTestId('step-gate')).toContainText(
      'Passed by itself: Approved verdict',
    );
    await expect(check.getByTestId('step-gate')).toContainText(
      'The final message ends with APPROVED',
    );
    await expect(steps(page).nth(1).getByTestId('step-gate')).toHaveCount(0);
    await expect(gate(page).getByTestId('gate-condition')).toHaveCount(0);
    // The run ends here, so the workflow's steps can be changed again.
    await gate(page).getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('run-state')).toHaveText('Done');

    // A stricter check ends with CHANGES_REQUESTED: the run waits and the gate bar names the
    // part that did not hold (spec 55).
    await page.goto(`/workflows/${e2eConditionWorkflowId}`);
    await page.getByRole('button', { name: 'Expand step 1' }).click();
    await page
      .getByRole('textbox', { name: 'Step 1 extra prompt' })
      .fill('Check the kettle strictly.');
    await save(page);
    await startRun(e2eConditionWorkflowId, 'condition-e2e-waits');
    await page.goto('/workflows/runs/condition-e2e-waits');
    await expect(gate(page)).toContainText('check-work finished. Approve starts learn-work.');
    await expect(gate(page).getByTestId('gate-condition')).toContainText(
      'Did not pass by itself: Approved verdict.',
    );
    await expect(gate(page).getByRole('list', { name: 'Gate condition' })).toContainText(
      'The final message ends with "CHANGES_REQUESTED", not APPROVED',
    );
    await expect(page.getByTestId('run-state')).toHaveText('Waiting for you');
    await expect(steps(page).nth(1).getByTestId('step-state')).toHaveText('Not started');
    // Approve still passes it, as at any gate.
    await gate(page).getByRole('button', { name: 'Approve' }).click();
    await expect(gate(page)).toContainText('learn-work finished. Approve ends the run.');
    await expect(steps(page).nth(0).getByTestId('step-gate')).toHaveCount(0);
  });

  test('a planning gate always stops @review-loop-57', async ({ page }) => {
    // The builder offers no condition for the gate after plan-work, only the reason (spec 57).
    await page.goto(`/workflows/${e2ePlanningWorkflowId}`);
    await expect(page.getByTestId('gate-always-stops')).toHaveText(
      'plan-work plans or specifies, so this gate always waits for you.',
    );
    await expect(page.getByTestId('gate-condition-editor')).toHaveCount(0);
    await expect(page.getByRole('checkbox')).toHaveCount(0);

    // Its answer ends with APPROVED and the run waits for the user all the same.
    await startRun(e2ePlanningWorkflowId, 'planning-e2e-run');
    await page.goto('/workflows/runs/planning-e2e-run');
    await expect(gate(page)).toContainText('plan-work finished. Approve starts deliver-work.');
    await expect(page.getByTestId('run-state')).toHaveText('Waiting for you');
    // Only the plan has a thread: the next step did not start.
    await expect(
      page.getByRole('list', { name: 'Run steps' }).getByRole('link', { name: 'Open thread' }),
    ).toHaveCount(1);
    await expect(page.getByTestId('step-gate')).toHaveCount(0);
    await expect(gate(page).getByTestId('gate-condition')).toHaveCount(0);
    await expect(steps(page).nth(1).getByTestId('step-state')).toHaveText('Not started');
  });
});
