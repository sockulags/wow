import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { e2eChangesHome, e2eChangesTrackerPort, e2eCopyProjectId, e2eCopyWorkflowId } from './env';

// U7 ground truth (review loop spec 36, 37) against the Changes copy of the e2e server, whose
// home holds an invented tea timer repository as project "Tea cup". The mock agent edits
// whatever folder its turn starts in, so the test can tell where the run worked.

const projectFolder = path.join(e2eChangesHome, e2eCopyProjectId);

test.beforeEach(async ({ page }) => {
  // What the desktop preload injects: the contents of `~/.wow/server.json`.
  const info: unknown = JSON.parse(
    await readFile(path.join(e2eChangesHome, 'server.json'), 'utf8'),
  );
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

const gate = (page: Page) => page.getByRole('region', { name: 'Gate' }).first();
const copyLine = (page: Page) => page.getByRole('group', { name: 'Working copy' });
const files = (page: Page) =>
  page.getByRole('navigation', { name: 'Changed files' }).getByTestId('changed-file');

const projectStatus = () =>
  execFileSync('git', ['-C', projectFolder, 'status', '--porcelain'], { encoding: 'utf8' });

test.describe('working copies', () => {
  test('a run in its own working copy @review-loop-36', async ({ page }) => {
    // The switch is in the builder and is stored with Save.
    await page.goto(`/workflows/${e2eCopyWorkflowId}`);
    const own = page.getByRole('switch', { name: 'Own working copy' });
    await expect(own).toHaveAttribute('aria-checked', 'false');
    await own.click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await page.reload();
    await expect(own).toHaveAttribute('aria-checked', 'true');

    const query = new URLSearchParams({
      workflowId: e2eCopyWorkflowId,
      projectId: e2eCopyProjectId,
      runId: 'copy-e2e-run',
    });
    const started = await fetch(`http://127.0.0.1:${e2eChangesTrackerPort}/run?${query}`, {
      method: 'POST',
    });
    expect(started.ok).toBe(true);
    await page.goto('/workflows/runs/copy-e2e-run');
    await expect(gate(page)).toContainText('deliver-work finished');

    // The run works in a folder of its own under the server's working copies folder.
    await expect(copyLine(page).getByTestId('working-copy-status')).toHaveText(
      'Works in its own working copy',
    );
    const folder = (await copyLine(page).getByTestId('path-text').textContent()) ?? '';
    expect(path.dirname(folder)).toBe(path.join(e2eChangesHome, 'workspaces'));
    expect(path.basename(folder)).toMatch(/^tea-cup-[0-9a-f]{8}$/);
    expect(existsSync(path.join(folder, 'src', 'chime.ts'))).toBe(true);
    // This invented repository has no remote, and the run says where it started instead.
    await expect(copyLine(page).getByTestId('working-copy-note')).toHaveText(
      'The project has no remote, so the working copy starts at the commit the project folder is on.',
    );

    // What the agent did is in the working copy; the project folder is as it was.
    expect(projectStatus()).toBe('');
    expect(await readFile(path.join(projectFolder, 'README.md'), 'utf8')).toContain(
      'Rings when the tea is ready.',
    );
    expect(existsSync(path.join(projectFolder, 'src', 'chime.ts'))).toBe(false);

    // The Changes tab and the viewer read the working copy.
    await page.getByRole('tab', { name: 'Changes' }).click();
    await expect(files(page)).toHaveCount(7);
    await page
      .getByRole('navigation', { name: 'Changed files' })
      .getByRole('button', { name: 'Changed: src/bell.ts' })
      .click();
    await page
      .getByRole('region', { name: 'Changes in src/bell.ts' })
      .getByRole('button', { name: 'Open file' })
      .click();
    const viewer = page
      .getByRole('complementary', { name: 'Context panel' })
      .getByRole('region', { name: 'File viewer' });
    await expect(viewer.getByTestId('viewer-text')).toContainText('export const ringTwice');
    await viewer.getByRole('button', { name: 'Back to conversation' }).click();

    // The run ends with work that is neither committed nor pushed, so the copy is kept and says
    // what it holds, the build log git ignores included.
    await gate(page).getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByTestId('run-state')).toHaveText('Done');
    await expect(copyLine(page).getByTestId('working-copy-status')).toHaveText(
      'Working copy kept: 7 files not committed, 1 ignored file, 1 commit not pushed (on no branch)',
    );
    await expect(copyLine(page)).toContainText('Newest commit not pushed: Say that it rings twice');
    expect(existsSync(folder)).toBe(true);
    await expect(
      page.getByRole('navigation', { name: 'Workflows' }).getByText('working copy kept'),
    ).toBeVisible();

    // Remove working copy asks first; Cancel keeps it.
    await copyLine(page).getByRole('button', { name: 'Remove working copy' }).click();
    const question = page.getByRole('alertdialog');
    await expect(question).toContainText('Remove this working copy?');
    await expect(question).toContainText(folder);
    await question.getByRole('button', { name: 'Cancel' }).click();
    expect(existsSync(folder)).toBe(true);

    await copyLine(page).getByRole('button', { name: 'Remove working copy' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(copyLine(page).getByTestId('working-copy-status')).toHaveText(
      'Working copy removed',
    );
    expect(existsSync(folder)).toBe(false);
    expect(projectStatus()).toBe('');
  });
});
