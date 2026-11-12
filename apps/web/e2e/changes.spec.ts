import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  e2eChangesHome,
  e2eChangesProjectId,
  e2eChangesTrackerPort,
  e2eChangesWorkflowId,
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
