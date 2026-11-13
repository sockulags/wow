import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { choose } from './controls';
import {
  e2eChangesHome,
  e2eChangesTrackerPort,
  e2eCopyProjectId,
  e2eCopyWorkflowId,
  e2eMugProjectId,
} from './env';
import { sketchPath, sketching, sketchUse } from './sketch';

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
    // A git worktree is made, used by two steps and removed: on Windows that alone used 25 of
    // the default 30 seconds before the chat panel's tabs and links were added.
    test.slow();
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

// Thread work U2 (spec 10 to 16): a chat thread in project "Tea mug", whose project setting turns
// "Own working copy" on for new threads. The mock agent's "Edit the bell" writes src/bell.ts in
// whatever folder its turn starts in, here only when that is a working copy of this server's.

const mugFolder = path.join(e2eChangesHome, e2eMugProjectId);
const main = (page: Page) => page.locator('#main-view');
const messageBox = (page: Page) => main(page).getByRole('combobox', { name: 'Message' });
const details = (page: Page) => page.getByTestId('working-copy-details');
const mugGit = (...args: string[]) =>
  execFileSync('git', ['-C', mugFolder, ...args], { encoding: 'utf8' }).trim();

async function startMugThread(page: Page, text: string): Promise<void> {
  await page.goto('/chat/new');
  // The instance list hands the keyboard back to its button a moment after it closes; the
  // project's list opened before that would lose it and close again (as in chat.spec).
  const instance = main(page).getByLabel('Provider instance');
  await choose(instance, 'Mock Claude');
  await expect(instance).toBeFocused();
  await choose(main(page).getByRole('combobox', { name: 'Project' }), 'Tea mug');
  await expect(main(page).getByRole('switch', { name: 'Own working copy' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await messageBox(page).fill(text);
}

// The panel's open state is a setting, so an earlier case can have left it open; the key would
// then close it.
async function showPanel(page: Page) {
  if (!(await page.getByRole('complementary', { name: 'Context panel' }).isVisible())) {
    await page.keyboard.press('Control+j');
  }
}

test.describe('a thread in its own working copy', () => {
  test('a thread works in its own working copy @thread-work-10 @thread-work-11', async ({
    page,
  }) => {
    test.slow();
    const before = { head: mugGit('rev-parse', 'HEAD'), status: mugGit('status', '--porcelain') };
    await startMugThread(page, 'Edit the bell');
    const line = main(page).getByTestId('draft-working-copy-line');
    await expect(line).toHaveText(
      new RegExp(
        `^New branch wow/edit-the-bell-[0-9a-f]{6} from main \\(${before.head.slice(0, 7)}\\)\\. Uncommitted changes in the project folder stay there\\.$`,
      ),
    );
    const branch = /New branch (\S+) from/.exec((await line.textContent()) ?? '')?.[1] ?? '';
    await messageBox(page).press('Enter');
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
    const conversation = main(page).getByRole('list', { name: 'Conversation' });
    await expect(conversation.getByText('The bell rings softly now.')).toBeVisible();

    // The chip and Details name the branch and the folder (spec 13).
    const chip = page.getByTestId('working-copy-chip');
    await expect(chip).toHaveText(`${branch}·own working copy`);
    await showPanel(page);
    await expect(details(page).getByTestId('fact-Branch')).toHaveText(branch);
    await expect(details(page).getByTestId('fact-Started from')).toHaveText(
      `main (${before.head.slice(0, 7)})`,
    );
    await expect(details(page).getByRole('button', { name: 'Copy path' })).toBeVisible();
    const folder = (await details(page).getByTestId('path-text').textContent()) ?? '';
    expect(path.dirname(folder)).toBe(path.join(e2eChangesHome, 'workspaces'));
    expect(path.basename(folder)).toMatch(/^tea-mug-t[0-9a-f]{8}$/);

    // The edit is in the working copy, on its branch; the project folder is as it was (spec 11).
    expect(await readFile(path.join(folder, 'src', 'bell.ts'), 'utf8')).toContain('softly');
    expect(
      execFileSync('git', ['-C', folder, 'symbolic-ref', '--short', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe(branch);
    expect(mugGit('status', '--porcelain')).toBe(before.status);
    expect(mugGit('rev-parse', 'HEAD')).toBe(before.head);
    expect(mugGit('symbolic-ref', '--short', 'HEAD')).toBe('main');

    // Done with an uncommitted file: the copy is kept and says so (spec 14).
    await main(page).getByRole('button', { name: 'Mark thread done' }).click();
    await expect(chip).toHaveText(`${branch}·1 uncommitted file`);
    expect(existsSync(folder)).toBe(true);

    // Remove names what is lost and removes on "Remove and lose them"; the branch stays (15).
    await details(page).getByRole('button', { name: 'Remove working copy' }).click();
    const question = page.getByRole('alertdialog');
    await expect(question.getByTestId('working-copy-loses')).toHaveText(
      `It holds 1 uncommitted file. They are lost with the folder. Commits stay on ${branch}.`,
    );
    await question.getByRole('button', { name: 'Remove and lose them' }).click();
    await expect(chip).toHaveText(`${branch}·working copy removed`);
    expect(existsSync(folder)).toBe(false);
    expect(mugGit('branch', '--list', branch)).toContain(branch);

    // The next message makes it again on its branch (spec 16).
    await messageBox(page).fill('Edit the bell again');
    await messageBox(page).press('Enter');
    await expect(conversation.getByText('The bell rings softly now.')).toHaveCount(2);
    await expect(chip).toHaveText(`${branch}·own working copy`);
    expect(existsSync(path.join(folder, 'src', 'bell.ts'))).toBe(true);
  });
});

test.describe('sketch', () => {
  test.skip(!sketching, 'Set WOW_E2E_SKETCHES to write the screenshots');
  test.use(sketchUse);

  test('a thread in its own working copy', async ({ page }) => {
    await startMugThread(page, 'Edit the bell for the sketch');
    await messageBox(page).press('Enter');
    await expect(
      main(page)
        .getByRole('list', { name: 'Conversation' })
        .getByText('The bell rings softly now.'),
    ).toBeVisible();
    await showPanel(page);
    await expect(details(page).getByTestId('fact-Branch')).toBeVisible();
    await page.screenshot({ path: sketchPath('2026-11-thread-work', 'thread-copy') });
  });
});
