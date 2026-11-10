import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  e2eChangesHome,
  e2eChangesProjectId,
  e2eChangesTrackerPort,
  e2eChangesWorkflowId,
} from './env';
import { sketchPath, sketching, sketchUse } from './sketch';

// U3 ground truth (review loop spec 11, 12) against its own copy of the e2e server, whose home
// holds an invented tea timer repository. The mock agent's build step commits one change and
// leaves others uncommitted; its review step adds notes and renames a new file. Each run adds to
// the same folder, so these tests run in order.
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
    workflowId: e2eChangesWorkflowId,
    projectId: e2eChangesProjectId,
    runId,
  });
  const response = await fetch(`http://127.0.0.1:${e2eChangesTrackerPort}/run?${query}`, {
    method: 'POST',
  });
  expect(response.ok).toBe(true);
}

const gate = (page: Page) => page.getByRole('region', { name: 'Gate' }).first();
const files = (page: Page) =>
  page.getByRole('navigation', { name: 'Changed files' }).getByTestId('changed-file');
const fileRow = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Changed files' }).getByRole('button', { name });

// Opens the run, lets the build step end, and passes its gate so the review step waits.
async function untilReviewWaits(page: Page, runId: string): Promise<void> {
  await startRun(runId);
  await page.goto(`/workflows/runs/${runId}`);
  await expect(gate(page)).toContainText('deliver-work finished');
  await page.getByRole('tab', { name: 'Changes' }).click();
  await expect(files(page).first()).toBeVisible();
  await gate(page).getByRole('button', { name: 'Continue' }).click();
  await expect(gate(page)).toContainText('check-work finished');
}

test.describe('changes', () => {
  test('the Changes tab shows what a step changed', async ({ page }) => {
    await startRun('changes-e2e-run');
    await page.goto('/workflows/runs/changes-e2e-run');
    await expect(gate(page)).toContainText('deliver-work finished');
    await page.getByRole('tab', { name: 'Changes' }).click();
    await expect(page).toHaveURL(/tab=changes/);

    // After the build step: a committed change, uncommitted ones, a rename, a deletion, new
    // files and a binary one. The file git ignores is not listed. All are the waiting step's.
    await expect(files(page)).toHaveText([
      /Changed:README\.md\+1 −1/,
      /Added:assets\/chime\.binBinary file · 10 bytes/,
      /Renamed:docs\/guide\.md\+0 −0/,
      /Changed:src\/bell\.ts\+4 −0/,
      /Added:src\/chime\.ts\+1 −0/,
      /Deleted:src\/legacy\.ts\+0 −1/,
      /Changed:src\/timer\.ts\+2 −2/,
    ]);
    await expect(page.getByTestId('changes-summary')).toContainText('7 files changed since');
    await expect(files(page).filter({ hasText: 'This step' })).toHaveCount(7);

    // The second step waits: the list follows, and only its two files are marked.
    await gate(page).getByRole('button', { name: 'Continue' }).click();
    await expect(gate(page)).toContainText('check-work finished');
    await expect(files(page)).toHaveCount(8);
    await expect(files(page).filter({ hasText: 'This step' })).toHaveText([
      /Added:review\/notes\.md\+4 −0/,
      /Added:src\/soft-chime\.ts\+1 −0/,
    ]);

    await page.getByRole('switch', { name: /This step only/ }).click();
    await expect(files(page)).toHaveCount(2);
    await expect(page).toHaveURL(/stepOnly=true/);
    await expect(page.getByRole('table', { name: 'Diff of review/notes.md' })).toContainText(
      'The timer rings twice.',
    );
    await page.getByRole('switch', { name: /This step only/ }).click();
    await expect(files(page)).toHaveCount(8);

    // One file's unified diff, a rename without a changed line, and a binary file.
    await fileRow(page, 'Changed: src/timer.ts').click();
    const diff = page.getByRole('table', { name: 'Diff of src/timer.ts' });
    await expect(diff.locator('tr[data-kind="remove"]')).toHaveText([
      /import \{ ring \} from/,
      /setTimeout\(\(\) => ring\(\), ms\);/,
    ]);
    await expect(diff.locator('tr[data-kind="add"]')).toHaveText([
      /import \{ ringTwice \} from/,
      /setTimeout\(\(\) => ringTwice\(\), ms\);/,
    ]);
    await fileRow(page, 'Renamed: docs/guide.md').click();
    const renamed = page.getByRole('region', { name: 'Changes in docs/guide.md' });
    await expect(renamed).toContainText('docs/howto.md → docs/guide.md');
    await expect(renamed.getByTestId('diff-unshown')).toHaveText('Renamed without a changed line.');
    await fileRow(page, 'Added: assets/chime.bin').click();
    await expect(
      page.getByRole('region', { name: 'Changes in assets/chime.bin' }).getByTestId('diff-unshown'),
    ).toHaveText('Binary file · 10 bytes. Its lines are not shown.');

    // A changed file opens in the side panel's viewer, next to the tab.
    await fileRow(page, 'Changed: src/bell.ts').click();
    await page
      .getByRole('region', { name: 'Changes in src/bell.ts' })
      .getByRole('button', { name: 'Open file' })
      .click();
    const viewer = page
      .getByRole('complementary', { name: 'Context panel' })
      .getByRole('region', { name: 'File viewer' });
    await expect(viewer.getByTestId('viewer-path')).toHaveText('src/bell.ts');
    await expect(viewer.getByTestId('viewer-text')).toContainText('export const ringTwice');
    await expect(page.getByRole('table', { name: 'Diff of src/bell.ts' })).toBeVisible();

    // The palette switches back to the steps.
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await palette.getByRole('combobox').fill('Run: show steps');
    await palette.getByRole('option', { name: 'Run: show steps' }).click();
    await expect(page.getByRole('list', { name: 'Run steps' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Steps' })).toHaveAttribute('aria-selected', 'true');
  });

  test('a project that is not a Git repository says so and the run view works', async ({
    page,
  }) => {
    // The seeded Demo project's folder is the server's home, which is no repository.
    const query = new URLSearchParams({ workflowId: e2eChangesWorkflowId, runId: 'plain-run' });
    const response = await fetch(`http://127.0.0.1:${e2eChangesTrackerPort}/run?${query}`, {
      method: 'POST',
    });
    expect(response.ok).toBe(true);
    await page.goto('/workflows/runs/plain-run?tab=changes');
    await expect(page.getByRole('heading', { name: 'Not a Git repository' })).toBeVisible();
    await expect(gate(page)).toContainText('deliver-work finished');
    await page.getByRole('tab', { name: 'Steps' }).click();
    await expect(page.getByRole('list', { name: 'Run steps' })).toBeVisible();
  });
});

test.describe('sketch', () => {
  test.skip(!sketching, 'Set WOW_E2E_SKETCHES to write the screenshots');
  test.use(sketchUse);

  test('the Changes tab', async ({ page }) => {
    await untilReviewWaits(page, 'changes-sketch-run');
    await fileRow(page, 'Changed: src/timer.ts').click();
    await expect(page.getByRole('table', { name: 'Diff of src/timer.ts' })).toBeVisible();
    await page.screenshot({ path: sketchPath('2026-11-review-loop', 'changes-tab') });
  });
});
