import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { e2eChangesHome, e2eChangesTrackerPort, e2eGateProjectId, e2eGateWorkflowId } from './env';
import { sketchPath, sketching, sketchUse } from './sketch';

// U4 ground truth (review loop spec 14 to 16, 20) against the Changes copy of the e2e server,
// which holds a second invented tea timer repository for these tests. Its workflow waits after
// each of its three steps; the mock agent answers a send back with a second attempt that adds a
// document. Each run reseeds that repository, so these tests run in order.
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  // What the desktop preload injects: the contents of `~/.wow/server.json`.
  const info: unknown = JSON.parse(
    await readFile(path.join(e2eChangesHome, 'server.json'), 'utf8'),
  );
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

async function startRun(runId: string): Promise<void> {
  const query = new URLSearchParams({
    workflowId: e2eGateWorkflowId,
    projectId: e2eGateProjectId,
    runId,
  });
  const response = await fetch(`http://127.0.0.1:${e2eChangesTrackerPort}/run?${query}`, {
    method: 'POST',
  });
  expect(response.ok).toBe(true);
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Context panel' });
const gate = (page: Page) => panel(page).getByRole('region', { name: 'Gate' });
// The run view keeps its own bar at its top (agent workbench spec 77); the send-back note is
// written there while the run view is on screen.
const runGate = (page: Page) => page.getByTestId('run-gate').getByRole('region', { name: 'Gate' });
const conversation = (page: Page) => panel(page).getByTestId('conversation');
const steps = (page: Page) => page.getByRole('list', { name: 'Run steps' }).getByTestId('run-step');
const NOTE = 'Name the kettle in the bell and write it down.';

test.describe('gate', () => {
  test('approve and send back at a gate @review-loop-14 @review-loop-15 @review-loop-16', async ({
    page,
  }) => {
    await startRun('gate-e2e-run');
    await page.goto('/workflows/runs/gate-e2e-run');

    // The review tabs are in the main area; the step's conversation and the gate bar are in the
    // side panel, which opens for the gate (spec 14).
    await expect(page.getByRole('tablist', { name: 'Run' }).getByRole('tab')).toHaveText([
      'Steps',
      'Path',
      'Changes',
      'Artifacts',
      'Pull request',
      'Ticket',
      'Pages',
    ]);
    await expect(panel(page).getByTestId('panel-step-thread')).toContainText('Step 1 of 3');
    await expect(conversation(page)).toContainText('The tea timer rings twice now.');
    await expect(gate(page)).toContainText('deliver-work finished. Approve starts check-work.');
    await expect(page.getByRole('region', { name: 'Gate' })).toHaveCount(2);
    for (const name of ['Approve', 'Send back', 'Stop']) {
      await expect(gate(page).getByRole('button', { name, exact: true })).toBeVisible();
      await expect(runGate(page).getByRole('button', { name, exact: true })).toBeVisible();
    }

    await page.getByRole('tab', { name: 'Changes' }).click();
    await expect(
      page.getByRole('navigation', { name: 'Changed files' }).getByTestId('changed-file'),
    ).toHaveCount(7);
    await page.getByRole('tab', { name: 'Artifacts' }).click();
    const artifacts = page.getByRole('list', { name: 'Artifacts of deliver-work' });
    await expect(artifacts.getByRole('button', { name: /^Open docs/ })).toHaveText([
      /Open docs\/guide\.md/,
    ]);
    for (const name of ['Pull request', 'Ticket', 'Pages']) {
      await page.getByRole('tab', { name }).click();
      await expect(
        page.getByRole('tabpanel', { name }).getByRole('heading', { name: 'Nothing to show yet' }),
      ).toBeVisible();
    }

    // Send back by key: the note field opens in place. An empty note is refused (spec 18).
    await page.keyboard.press('Control+Shift+Enter');
    const note = runGate(page).getByRole('textbox', { name: 'What should change?' });
    await expect(note).toBeFocused();
    await expect(page.getByRole('textbox', { name: 'What should change?' })).toHaveCount(1);
    await runGate(page).getByRole('button', { name: 'Send it back' }).click();
    await expect(runGate(page).getByRole('alert')).toHaveText(
      'Write what should change before you send the step back.',
    );
    await expect(page.getByTestId('run-state')).toHaveText('Waiting for you');

    // With a note the step runs again in the same thread and waits at the same gate (spec 16).
    await note.fill(NOTE);
    await page.keyboard.press('Control+Shift+Enter');
    await expect(conversation(page)).toContainText(
      'Second attempt: the bell and a new document name the kettle.',
    );
    await expect(conversation(page).getByTestId('item-user').last()).toContainText(NOTE);
    await expect(conversation(page)).toContainText('The tea timer rings twice now.');
    await expect(gate(page)).toContainText('deliver-work finished. Approve starts check-work.');
    await expect(panel(page).getByTestId('panel-step-thread')).toContainText(
      'Step 1 of 3 · deliver-work · Attempt 2',
    );
    await expect(gate(page).getByRole('textbox')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Artifacts' }).click();
    await expect(artifacts.getByRole('button', { name: /^Open docs/ })).toHaveText([
      /Open docs\/guide\.md/,
      /Open docs\/kettle\.md/,
    ]);
    await page.getByRole('tab', { name: 'Steps' }).click();
    await expect(steps(page).nth(0).getByTestId('step-attempt')).toHaveText('Attempt 2');
    await expect(steps(page).nth(1).getByTestId('step-state')).toHaveText('Not started');

    // An ordinary message at the gate is a side conversation: the run stays where it is (spec 20).
    const composer = panel(page).getByRole('combobox', { name: 'Message' });
    await composer.fill('Why twice?');
    await composer.press('Enter');
    await expect(conversation(page)).toContainText('You said: Why twice?');
    await expect(page.getByTestId('run-state')).toHaveText('Waiting for you');
    await expect(steps(page).nth(0).getByTestId('step-attempt')).toHaveText('Attempt 2');
    await expect(steps(page).nth(1).getByTestId('step-state')).toHaveText('Not started');

    // Approve continues the run: by key, by the gate bar button and from the palette (spec 15).
    await page.getByRole('tab', { name: 'Steps' }).focus();
    await page.keyboard.press('Control+Enter');
    await expect(gate(page)).toContainText('check-work finished. Approve starts learn-work.');
    await expect(steps(page).nth(0).getByTestId('step-state')).toHaveText('Done');

    await gate(page).getByRole('button', { name: 'Approve' }).click();
    await expect(gate(page)).toContainText('learn-work finished. Approve ends the run.');

    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await palette.getByRole('combobox').fill('Run: approve');
    await palette.getByRole('option', { name: 'Run: approve' }).click();
    await expect(page.getByTestId('run-state')).toHaveText('Done');
    await expect(steps(page).getByTestId('step-state')).toHaveText(['Done', 'Done', 'Done']);
    await expect(page.getByRole('region', { name: 'Gate' })).toHaveCount(0);
  });
});

test.describe('a narrow window', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('keeps the gate bar in view at 1024 px @agent-workbench-77 @agent-workbench-78', async ({
    page,
  }) => {
    await startRun('gate-narrow-run');
    await page.goto('/workflows/runs/gate-narrow-run?tab=changes');
    await expect(runGate(page)).toContainText('deliver-work finished');
    // Below 1200 px the panel does not open by itself; opened, it lies over the view.
    await expect(panel(page)).toHaveCount(0);
    await page.keyboard.press('Control+j');
    await expect(panel(page)).toHaveAttribute('data-overlay', '');
    await expect(conversation(page)).toContainText('The tea timer rings twice now.');
    const edge = await panel(page).boundingBox();
    expect(edge).not.toBeNull();
    const text = await runGate(page).getByText('deliver-work finished').boundingBox();
    for (const name of ['Approve', 'Send back', 'Stop']) {
      const button = runGate(page).getByRole('button', { name, exact: true });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      // Left of the panel, and under the gate's text.
      expect((box?.x ?? Infinity) + (box?.width ?? 0)).toBeLessThanOrEqual(edge?.x ?? 0);
      expect(box?.y ?? 0).toBeGreaterThan(text?.y ?? Infinity);
      // Nothing lies over it: a trial click finds the button itself under the pointer.
      await button.click({ trial: true, timeout: 2000 });
    }
    // A file in the panel leaves the run view's bar where it is (spec 77).
    await runGate(page).getByRole('button', { name: 'Open docs/guide.md' }).click();
    await expect(panel(page).getByRole('region', { name: 'File viewer' })).toBeVisible();
    await expect(panel(page).getByRole('region', { name: 'Gate' })).toHaveCount(0);
    await runGate(page).getByRole('button', { name: 'Approve' }).click({ trial: true });
    await page.keyboard.press('Control+Enter');
    await expect(runGate(page)).toContainText('check-work finished');
  });

  test('keeps the gate bar in view at 1024 px with the widest panel @agent-workbench-78', async ({
    page,
  }) => {
    await startRun('gate-narrow-wide-run');
    await page.goto('/workflows/runs/gate-narrow-wide-run?tab=changes');
    await expect(runGate(page)).toContainText('deliver-work finished');
    await page.keyboard.press('Control+j');
    await expect(panel(page)).toHaveAttribute('data-overlay', '');
    const handle = page.getByTestId('context-panel-resize');
    const start = await handle.boundingBox();
    expect(start).not.toBeNull();
    const x = (start?.x ?? 0) + (start?.width ?? 0) / 2;
    const y = (start?.y ?? 0) + (start?.height ?? 0) / 2;
    const buttonsClearOfPanel = async (click: boolean) => {
      const edge = await panel(page).boundingBox();
      for (const name of ['Approve', 'Send back', 'Stop']) {
        const button = runGate(page).getByRole('button', { name, exact: true });
        const box = await button.boundingBox();
        expect((box?.x ?? Infinity) + (box?.width ?? 0)).toBeLessThanOrEqual(edge?.x ?? 0);
        if (click) await button.click({ trial: true, timeout: 2000 });
      }
    };
    // From the default 380 px towards the largest width, 720 px: over the run view the edge stops
    // where the gate bar's room begins (1024 px less 35rem), while it is dragged and once it is
    // stored, and the width stored is the width shown.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 340, y);
    await expect(handle).toHaveAttribute('aria-valuenow', '464');
    await buttonsClearOfPanel(false);
    await page.mouse.up();
    await expect(handle).toHaveAttribute('aria-valuenow', '464');
    expect((await panel(page).boundingBox())?.width).toBe(464);
    await buttonsClearOfPanel(true);
    // Back to the default for the tests after this one: the edge moves at once, no dead zone.
    const moved = await handle.boundingBox();
    const back = (moved?.x ?? 0) + (moved?.width ?? 0) / 2;
    await page.mouse.move(back, y);
    await page.mouse.down();
    await page.mouse.move(back + 84, y);
    await page.mouse.up();
    await expect(handle).toHaveAttribute('aria-valuenow', '380');
  });
});

test.describe('a small window', () => {
  test.use({ viewport: { width: 800, height: 768 } });

  test('keeps the panel at its minimum and the gate bar beside it at 800 px @agent-workbench-78', async ({
    page,
  }) => {
    await startRun('gate-small-run');
    await page.goto('/workflows/runs/gate-small-run?tab=changes');
    await expect(runGate(page)).toContainText('deliver-work finished');
    await page.keyboard.press('Control+j');
    await expect(panel(page)).toHaveAttribute('data-overlay', '');
    await expect(page.getByTestId('context-panel-resize')).toHaveAttribute('aria-valuenow', '280');
    const edge = await panel(page).boundingBox();
    expect(edge?.width).toBe(280);
    for (const name of ['Approve', 'Send back', 'Stop']) {
      const button = runGate(page).getByRole('button', { name, exact: true });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect((box?.x ?? Infinity) + (box?.width ?? 0)).toBeLessThanOrEqual(edge?.x ?? 0);
      await button.click({ trial: true, timeout: 2000 });
    }
  });
});

test.describe('sketch', () => {
  test.skip(!sketching, 'Set WOW_E2E_SKETCHES to write the screenshots');
  test.use(sketchUse);

  test('the run view at a gate', async ({ page }) => {
    await startRun('gate-sketch-run');
    await page.goto('/workflows/runs/gate-sketch-run?tab=changes');
    await expect(gate(page)).toContainText('deliver-work finished');
    await gate(page).getByRole('button', { name: 'Send back' }).click();
    await runGate(page).getByRole('textbox', { name: 'What should change?' }).fill(NOTE);
    await runGate(page).getByRole('button', { name: 'Send it back' }).click();
    await expect(conversation(page)).toContainText('Second attempt');
    await expect(gate(page)).toContainText('deliver-work finished');
    await page
      .getByRole('navigation', { name: 'Changed files' })
      .getByRole('button', { name: 'Changed: src/bell.ts' })
      .click();
    await expect(page.getByRole('table', { name: 'Diff of src/bell.ts' })).toContainText('kettle');
    await gate(page).getByRole('button', { name: 'Send back' }).click();
    await runGate(page)
      .getByRole('textbox', { name: 'What should change?' })
      .fill('Ring once more when the tea has steeped for too long.');
    // The "Waiting for you" toasts would cover the composer in the picture.
    for (const close of await page.locator('[data-sonner-toast] [data-close-button]').all()) {
      await close.click();
    }
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
    await page.screenshot({ path: sketchPath('2026-11-review-loop', 'gate-review') });
  });

  test.describe('narrow', () => {
    test.use({ ...sketchUse, viewport: { width: 1024, height: 768 } });

    test('the run view at a gate with the panel over it', async ({ page }) => {
      await startRun('gate-sketch-narrow-run');
      await page.goto('/workflows/runs/gate-sketch-narrow-run?tab=changes');
      await expect(runGate(page)).toContainText('deliver-work finished');
      await page
        .getByRole('navigation', { name: 'Changed files' })
        .getByRole('button', { name: 'Changed: src/bell.ts' })
        .click();
      const diff = page.getByRole('table', { name: 'Diff of src/bell.ts' });
      await diff.locator('tr[data-kind="add"]').first().focus();
      await page.keyboard.press('c');
      await page.keyboard.type('Say which kettle rings.');
      await page.keyboard.press('Enter');
      await expect(runGate(page).getByRole('textbox', { name: 'What should change?' })).toHaveValue(
        /src\/bell\.ts:\d+ – Say which kettle rings\./,
      );
      await page.keyboard.press('Control+j');
      await expect(panel(page)).toHaveAttribute('data-overlay', '');
      await expect(conversation(page)).toContainText('The tea timer rings twice now.');
      for (const close of await page.locator('[data-sonner-toast] [data-close-button]').all()) {
        await close.click();
      }
      await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
      await page.screenshot({ path: sketchPath('2026-11-agent-workbench', 'run-gate') });
    });
  });
});
