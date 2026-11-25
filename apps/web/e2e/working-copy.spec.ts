import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { choose } from './controls';
import { e2eChangesHome, e2eMugProjectId } from './env';
import { sketchPath, sketching, sketchUse } from './sketch';

// Against the Changes copy of the e2e server, whose home holds invented tea repositories.

test.beforeEach(async ({ page }) => {
  // What the desktop preload injects: the contents of `~/.wow/server.json`.
  const info: unknown = JSON.parse(
    await readFile(path.join(e2eChangesHome, 'server.json'), 'utf8'),
  );
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
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
