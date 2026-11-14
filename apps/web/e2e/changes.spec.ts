import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  e2eChangesHome,
  e2eChangesProjectId,
  e2eChangesTrackerPort,
  e2eChangesWorkflowId,
  e2eMugProjectId,
} from './env';
import { choose } from './controls';
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
  await gate(page).getByRole('button', { name: 'Approve' }).click();
  await expect(gate(page)).toContainText('check-work finished');
}

test.describe('changes', () => {
  test('the Changes tab shows what a step changed @review-loop-11', async ({ page }) => {
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
    await gate(page).getByRole('button', { name: 'Approve' }).click();
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

test.describe('line comments', () => {
  test('sends back with line comments @agent-workbench-80', async ({ page }) => {
    await startRun('comments-e2e-run');
    await page.goto('/workflows/runs/comments-e2e-run?tab=changes');
    const runGate = page.getByTestId('run-gate').getByRole('region', { name: 'Gate' });
    await expect(runGate).toContainText('deliver-work finished');
    await fileRow(page, 'Changed: src/timer.ts').click();
    const diff = page.getByRole('table', { name: 'Diff of src/timer.ts' });
    const added = diff.locator('tr[data-kind="add"]');
    const first = await added.nth(0).getAttribute('data-line');
    const second = await added.nth(1).getAttribute('data-line');

    // C on a line opens a field under it; Enter adds the comment to the send-back note.
    await added.nth(0).focus();
    await page.keyboard.press('c');
    await diff.getByRole('textbox', { name: `Comment on line ${first}` }).fill('Ring twice here.');
    await page.keyboard.press('Enter');
    await expect(added.nth(0)).toBeFocused();
    // A click in the gutter does the same.
    await added.nth(1).hover();
    await added
      .nth(1)
      .getByRole('button', { name: `Comment on line ${second}` })
      .click();
    await page.keyboard.type('And here too.');
    await page.keyboard.press('Enter');

    const note = runGate.getByRole('textbox', { name: 'What should change?' });
    await expect(note).toHaveValue(
      `src/timer.ts:${first} – Ring twice here.\nsrc/timer.ts:${second} – And here too.`,
    );
    // Ctrl+Shift+Enter sends the note back to the step.
    await added.nth(1).focus();
    await page.keyboard.press('Control+Shift+Enter');
    await expect(note).toHaveCount(0);
    await page.getByRole('tab', { name: 'Steps' }).click();
    await expect(
      page.getByRole('list', { name: 'Run steps' }).getByTestId('step-attempt'),
    ).toHaveText('Attempt 2');
  });
});

// The run tests above may leave the side panel open, with fields of its own.
const main = (page: Page) => page.locator('#main-view');
const messageBox = (page: Page) => main(page).getByRole('combobox', { name: 'Message' });

test.describe("a chat thread's changes", () => {
  test("lists a thread's changes @agent-workbench-34 @agent-workbench-35", async ({ page }) => {
    await page.goto('/chat/new');
    await choose(main(page).getByLabel('Provider instance'), 'Mock Claude');
    await choose(main(page).getByRole('combobox', { name: 'Project' }), 'Tea chat');
    await expect(main(page).getByTestId('model-bar')).toBeVisible();
    await messageBox(page).fill('Edit the timer');
    await messageBox(page).press('Enter');
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
    const conversation = main(page).getByRole('list', { name: 'Conversation' });
    await conversation
      .getByRole('region', { name: 'Approval request' })
      .getByRole('button', { name: 'Allow once' })
      .click();
    await expect(conversation.getByText('The timer rings twice now.')).toBeVisible();
    // The edit row's Open file opens the file in a tab of the thread's panel (spec 17, 33).
    const edit = conversation.getByTestId('item-tool_call');
    await edit.getByTestId('tool-line').click();
    await edit.getByRole('button', { name: 'Open file' }).click();
    const panel = page.getByRole('complementary', { name: 'Context panel' });
    await expect(panel.getByRole('tab', { name: 'timer.ts' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const viewer = panel.getByRole('region', { name: 'File viewer' });
    await expect(viewer.getByTestId('viewer-path')).toHaveText('src/timer.ts');
    await expect(viewer.getByTestId('viewer-text')).toContainText('ms + 2_000');
    await messageBox(page).fill('Edit the bell');
    await messageBox(page).press('Enter');
    await expect(conversation.getByText('The bell rings softly now.')).toBeVisible();

    // The header sums both turns; the chip opens the Changes beside the thread.
    const chip = page.getByTestId('thread-changes-chip');
    await expect(chip).toHaveText('+2 −1 in 2 files');
    await chip.click();
    // Changes are a tab of their own beside Details and the file (spec 34).
    await expect(panel.getByRole('tab', { name: 'Changes' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(panel.getByRole('tab', { name: 'timer.ts' })).toBeVisible();
    const changes = page.getByTestId('thread-changes');
    const listed = changes.getByTestId('thread-changes-file');
    await expect(listed).toHaveText([/src\/bell\.ts\+1 −1/, /src\/timer\.ts\+1 −0/]);
    // "This turn only" (O) narrows to what changed since the last turn began.
    await page.keyboard.press('o');
    await expect(listed).toHaveText([/src\/bell\.ts\+1 −1/]);
    await listed.first().click();
    const bellDiff = changes.getByRole('table', { name: 'Diff of src/bell.ts' });
    await expect(bellDiff).toBeVisible();
    // A comment on a line goes into the composer as a reply (spec 80).
    const line = bellDiff.locator('tr[data-kind="add"]').first();
    const number = await line.getAttribute('data-line');
    await line.focus();
    await page.keyboard.press('c');
    await page.keyboard.type('Softer still.');
    await page.keyboard.press('Enter');
    await expect(messageBox(page)).toHaveValue(`src/bell.ts:${number} – Softer still.`);
    await listed.first().focus();
    await page.keyboard.press('o');
    await expect(listed).toHaveCount(2);

    // A thread whose folder is not in Git says why instead of listing files.
    await page.goto('/chat/new');
    await choose(main(page).getByRole('combobox', { name: 'Project' }), 'Demo');
    await messageBox(page).fill('Hello from a plain folder');
    await messageBox(page).press('Enter');
    await expect(main(page).getByRole('list', { name: 'Conversation' })).toContainText(
      'You said: Hello from a plain folder',
    );
    await expect(page.getByTestId('thread-changes-chip')).toHaveCount(0);
    await page.keyboard.press('Control+Shift+D');
    await expect(
      page.getByTestId('thread-changes').getByRole('heading', { name: 'Not a Git repository' }),
    ).toBeVisible();
  });

  test('restores files to before a message and undoes it @thread-work-20 @thread-work-22 @thread-work-24', async ({
    page,
  }) => {
    const repo = path.join(e2eChangesHome, 'tea-chat');
    const inRepo = (relative: string) => path.join(repo, ...relative.split('/'));
    const timerBefore = await readFile(inRepo('src/timer.ts'));
    await page.goto('/chat/new');
    await choose(main(page).getByLabel('Provider instance'), 'Mock Claude');
    await choose(main(page).getByRole('combobox', { name: 'Project' }), 'Tea chat');
    await expect(main(page).getByTestId('model-bar')).toBeVisible();
    await messageBox(page).fill('Add the notes');
    await messageBox(page).press('Enter');
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
    const conversation = main(page).getByRole('list', { name: 'Conversation' });
    await expect(conversation.getByText('Notes added, the old page gone.')).toBeVisible();
    const message = conversation.getByTestId('item-user').first();
    const restoreHere = message.getByRole('button', { name: 'Restore files to here' });
    const dialog = page.getByTestId('restore-confirm');

    // The confirm lists what goes back; nothing changed outside the thread yet.
    await message.hover();
    await restoreHere.click();
    await expect(dialog.getByTestId('restore-write')).toContainText(/docs[\\/]old\.md/);
    await expect(dialog.getByTestId('restore-remove')).toContainText(/docs[\\/]notes\.md/);
    await expect(dialog.getByTestId('restore-outside')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // An editor writes the timer after the turn ended (with Windows line endings).
    const edited = Buffer.from('export const minutes = 4;\r\n');
    await writeFile(inRepo('src/timer.ts'), edited);
    await message.hover();
    await restoreHere.click();
    await expect(dialog.getByTestId('restore-outside')).toContainText(/src[\\/]timer\.ts/);
    const anyway = dialog.getByRole('button', { name: 'Restore anyway' });
    await expect(anyway).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    const line = conversation.getByTestId('files-restored');
    await expect(line).toContainText(
      'Files restored to before “Add the notes” · 2 written · 1 deleted',
    );
    expect(await readFile(inRepo('docs/old.md'), 'utf8')).toBe('# Old page\n');
    await expect(readFile(inRepo('docs/notes.md'))).rejects.toThrow();
    expect((await readFile(inRepo('src/timer.ts'))).equals(timerBefore)).toBe(true);

    // Undo puts back the files as they were just before, the editor's bytes included.
    await line.getByRole('button', { name: 'Undo' }).click();
    await expect(dialog.getByTestId('restore-write')).toContainText(/src[\\/]timer\.ts/);
    await expect(dialog.getByTestId('restore-remove')).toContainText(/docs[\\/]old\.md/);
    await dialog.getByRole('button', { name: 'Undo' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(conversation.getByTestId('files-restored').nth(1)).toContainText('Restore undone');
    await expect(line.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    expect((await readFile(inRepo('src/timer.ts'))).equals(edited)).toBe(true);
    expect(await readFile(inRepo('docs/notes.md'), 'utf8')).toContain('Steep for three minutes.');
    await expect(readFile(inRepo('docs/old.md'))).rejects.toThrow();
  });
});

// Thread work U4 (spec 27 to 32): a thread of project "Tea mug" in its own working copy. The
// repository tracks a pre-commit hook (its `core.hooksPath` is `hooks`) that leaves a mark in the
// folder's git directory; its pull requests go to `acme/tea-mug` on the mock GitHub, and the
// branch is pushed to the bare origin beside it. The mock answers "Propose" with fixed text.
const mugFolder = path.join(e2eChangesHome, e2eMugProjectId);
const mugOrigin = path.join(e2eChangesHome, 'tea-mug-origin.git');
const gitIn = (folder: string, ...args: string[]) =>
  execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8' }).trim();

// The worktree a branch is checked out in, as git lists it.
function worktreeOf(branch: string): string {
  const blocks = gitIn(mugFolder, 'worktree', 'list', '--porcelain').split(/\r?\n\r?\n/);
  const block = blocks.find((entry) => entry.includes(`branch refs/heads/${branch}`)) ?? '';
  return /^worktree (.+)$/m.exec(block)?.[1] ?? '';
}

async function startMugThread(page: Page, text: string): Promise<string> {
  await page.goto('/chat/new');
  const instance = main(page).getByLabel('Provider instance');
  await choose(instance, 'Mock Claude');
  await expect(instance).toBeFocused();
  await choose(main(page).getByRole('combobox', { name: 'Project' }), 'Tea mug');
  await expect(main(page).getByRole('switch', { name: 'Own working copy' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await messageBox(page).fill(text);
  await messageBox(page).press('Enter');
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(
    main(page).getByRole('list', { name: 'Conversation' }).getByText('The bell rings softly now.'),
  ).toBeVisible();
  const chip = (await page.getByTestId('working-copy-chip').textContent()) ?? '';
  return chip.split('·')[0] ?? '';
}

test.describe('commit and pull request', () => {
  test('commits with a proposed message and opens a pull request @thread-work-27 @thread-work-28 @thread-work-29 @thread-work-31 @thread-work-32', async ({
    page,
  }) => {
    // A worktree, a commit with a hook and a push: as slow on Windows as the working copy cases.
    test.slow();
    const branch = await startMugThread(page, 'Edit the bell for a pull request');
    const folder = worktreeOf(branch);
    expect(folder).not.toBe('');
    const dialog = page.getByTestId('commit-dialog');
    // Read once, so the turn's end is kept before the user's own change.
    await page.keyboard.press('Control+Shift+K');
    await expect(dialog.getByRole('checkbox', { name: 'src/bell.ts' })).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // The user changes the readme and stages it; the thread's edit is the bell.
    await writeFile(path.join(folder, 'README.md'), "# Tea mug\n\nMine, not the thread's.\n");
    gitIn(folder, 'add', 'README.md');
    await page.getByRole('button', { name: /^Commit…/ }).click();
    await expect(dialog.getByRole('checkbox', { name: 'src/bell.ts' })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'README.md' })).not.toBeChecked();
    await expect(dialog.getByTestId('commit-hooks')).toHaveText(
      "Runs the repository's commit hooks: pre-commit",
    );
    await expect(dialog.getByTestId('commit-branch')).toContainText(`On ${branch}`);

    // Propose fills the field from the thread's model; the conversation stays as it was.
    const conversation = main(page).getByRole('list', { name: 'Conversation' });
    const rows = await conversation.getByRole('listitem').count();
    await dialog.getByRole('button', { name: 'Propose' }).click();
    const message = dialog.getByRole('textbox', { name: 'Message' });
    await expect(message).toHaveValue('Ring the bell twice');
    await expect(conversation.getByRole('listitem')).toHaveCount(rows);

    // Ctrl+Enter commits the ticked file only, with the hook; the staged readme stays staged.
    await message.focus();
    await page.keyboard.press('Control+Enter');
    await expect(dialog).toHaveCount(0);
    await expect(conversation.getByTestId('committed-line')).toHaveText(
      /^Committed 1 file · [0-9a-f]{7} Ring the bell twice$/,
    );
    expect(gitIn(folder, 'show', '--name-only', '--format=', 'HEAD')).toBe('src/bell.ts');
    expect(gitIn(folder, 'log', '-1', '--format=%s')).toBe('Ring the bell twice');
    expect(gitIn(folder, 'diff', '--cached', '--name-only')).toBe('README.md');
    const mark = path.resolve(folder, gitIn(folder, 'rev-parse', '--git-path', 'wow-hook-mark'));
    expect(existsSync(mark)).toBe(true);

    // Open pull request… names where it goes and what it holds (spec 31).
    await page.getByRole('button', { name: /^Open pull request…/ }).click();
    const request = page.getByTestId('pull-request-dialog');
    const statement = request.getByTestId('pull-request-statement');
    await expect(statement).toContainText(
      `Pushes ${branch} to origin and opens a pull request on 127.0.0.1:`,
    );
    await expect(statement).toContainText(' in acme/tea-mug');
    await expect(request.getByRole('combobox')).toHaveText('main');
    await expect(request.getByRole('list', { name: 'Commits' })).toContainText(
      'Ring the bell twice',
    );
    await expect(request.getByRole('textbox', { name: 'Title' })).toHaveValue(
      'Ring the bell twice',
    );
    await request.getByRole('button', { name: /^Open pull request/ }).click();
    await expect(request).toHaveCount(0);

    // Pushed to the bare origin with the upstream set, one pull request opened (spec 32).
    const line = conversation.getByTestId('change-request-line');
    await expect(line).toContainText(/Opened pull request #\d+ · Ring the bell twice/);
    expect(gitIn(mugOrigin, 'rev-parse', `refs/heads/${branch}`)).toBe(
      gitIn(folder, 'rev-parse', 'HEAD'),
    );
    expect(gitIn(folder, 'config', `branch.${branch}.remote`)).toBe('origin');
    const opened = (await (
      await fetch(`http://127.0.0.1:${e2eChangesTrackerPort}/github-mug/opened`)
    ).json()) as { head: string; base: string; title: string }[];
    expect(opened.filter((entry) => entry.head === branch)).toEqual([
      expect.objectContaining({ base: 'main', title: 'Ring the bell twice' }),
    ]);

    // The chip opens the pull request in a tab of the thread's panel.
    await line.getByTestId('host-chip').click();
    await expect(
      page.getByRole('complementary', { name: 'Context panel' }).getByTestId('host-tab-title'),
    ).toHaveText(/^PR #\d+ · Open$/);
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

  test('the commit dialog', async ({ page }) => {
    await startMugThread(page, 'Edit the bell for the commit sketch');
    await page.keyboard.press('Control+Shift+K');
    const dialog = page.getByTestId('commit-dialog');
    await dialog.getByRole('button', { name: 'Propose' }).click();
    await expect(dialog.getByRole('textbox', { name: 'Message' })).toHaveValue(
      'Ring the bell twice',
    );
    await page.screenshot({ path: sketchPath('2026-11-thread-work', 'commit-dialog') });
    await page.keyboard.press('Escape');
  });

  test('the restore confirm', async ({ page }) => {
    const repo = path.join(e2eChangesHome, 'tea-chat');
    // As the seed left it, whatever the cases before did.
    await writeFile(path.join(repo, 'docs', 'old.md'), '# Old page\n');
    await rm(path.join(repo, 'docs', 'notes.md'), { force: true });
    await page.goto('/chat/new');
    await choose(main(page).getByLabel('Provider instance'), 'Mock Claude');
    await choose(main(page).getByRole('combobox', { name: 'Project' }), 'Tea chat');
    await expect(main(page).getByTestId('model-bar')).toBeVisible();
    await messageBox(page).fill('Add the notes');
    await messageBox(page).press('Enter');
    const conversation = main(page).getByRole('list', { name: 'Conversation' });
    await expect(conversation.getByText('Notes added, the old page gone.')).toBeVisible();
    const message = conversation.getByTestId('item-user').first();
    const dialog = page.getByTestId('restore-confirm');
    // Read once, so the turn's end is kept before the editor writes.
    await message.hover();
    await message.getByRole('button', { name: 'Restore files to here' }).click();
    await expect(dialog.getByTestId('restore-write')).toBeVisible();
    await page.keyboard.press('Escape');
    await writeFile(path.join(repo, 'src', 'timer.ts'), 'export const minutes = 4;\n');
    await message.hover();
    await message.getByRole('button', { name: 'Restore files to here' }).click();
    await expect(dialog.getByTestId('restore-outside')).toBeVisible();
    await page.screenshot({ path: sketchPath('2026-11-thread-work', 'restore') });
    await page.keyboard.press('Escape');
  });
});
