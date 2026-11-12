import { expect, test, type Page } from '@playwright/test';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { choose } from './controls';
import { e2ePanelCardId, e2ePanelHome, e2ePanelTrackerPort, e2eViewerWorkflowId } from './env';
import { sketchPath, sketching, sketchUse } from './sketch';

// The context panel (owner decisions F-1, F-2) against its own copy of the e2e server, whose home
// seeds a card tomorrow at 10:00 that runs a one-step workflow with a gate after the step. The
// panel's open state and width are global settings, so these tests run in order on that server.
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  // What the desktop preload injects: the contents of `~/.wow/server.json`.
  const info: unknown = JSON.parse(await readFile(path.join(e2ePanelHome, 'server.json'), 'utf8'));
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

const pad = (value: number) => String(value).padStart(2, '0');

// YYYY-MM-DD of today plus `days` in this machine's zone, which the server shares.
function localDay(days = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Context panel' });
const calendar = (page: Page) => page.getByRole('region', { name: 'Calendar' });

// Starts the card's run the way the scheduler does at the card's time.
async function fire(cardId: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${e2ePanelTrackerPort}/fire?cardId=${cardId}`, {
    method: 'POST',
  });
  expect(response.ok).toBe(true);
}

test.describe('context panel', () => {
  test('a selected card shows its step thread, and its gate continues from the panel', async ({
    page,
  }) => {
    await page.goto(`/calendar?view=day&date=${localDay(1)}`);
    await expect(panel(page)).toBeHidden();
    await page.getByRole('button', { name: 'Toggle context panel' }).click();
    await expect(panel(page).getByTestId('empty-state')).toContainText('Nothing selected');

    await fire(e2ePanelCardId);
    const card = calendar(page).getByRole('button', { name: /^Review the search panel, 10:00/ });
    await card.click();
    // With the panel open a click selects the card instead of opening its dialog.
    await expect(page).toHaveURL(new RegExp(`item=${e2ePanelCardId}`));
    await expect(page.getByRole('dialog', { name: 'Edit card' })).toBeHidden();
    await expect(card).toHaveAttribute('aria-current', 'true');

    const details = panel(page).getByTestId('panel-card');
    await expect(details.getByTestId('panel-title')).toHaveText('Review the search panel');
    await expect(details.getByTestId('fact-Project')).toHaveText('Demo');
    await expect(details.getByTestId('fact-Workflow')).toHaveText('Panel e2e');
    await expect(details).toContainText('Invented notes for the panel tests.');

    // The step's thread streams in live, with the gate and the step's composer under it.
    const thread = panel(page).getByTestId('panel-step-thread');
    await expect(thread).toContainText('Step 1 of 1');
    await expect(thread.getByTestId('conversation')).toContainText('You said:');
    await expect(details.getByTestId('fact-State')).toHaveText('Needs you');
    await expect(thread.getByRole('combobox', { name: 'Message' })).toBeVisible();
    const gate = thread.getByRole('region', { name: 'Gate' });
    await expect(gate).toContainText('check-work finished. Approve ends the run.');
    await gate.getByRole('button', { name: 'Approve' }).click();
    await expect(gate).toBeHidden();
    await expect(details.getByTestId('fact-State')).toHaveText('Done');
    await expect(card).toHaveAccessibleName(/, done$/);

    // The chat view's panel shows the thread's setup instead of the conversation again.
    await thread.getByRole('link', { name: 'Open thread' }).click();
    await expect(page).toHaveURL(/\/chat\/[^/]+$/);
    const threadDetails = panel(page).getByTestId('panel-thread');
    await expect(threadDetails.getByTestId('fact-Model')).toHaveText('Mock model');
    await expect(threadDetails.getByTestId('fact-Provider')).toHaveText('Mock Claude');
    await expect(threadDetails.getByTestId('fact-Run')).toContainText('Panel e2e · check-work');
    await expect(threadDetails.getByTestId('fact-Card')).toContainText('Review the search panel');
    await expect(threadDetails.getByTestId('fact-Turns')).toHaveText('1');
  });

  test('a selected meeting shows its details with Join and Open in Outlook', async ({ page }) => {
    await page.goto(`/calendar?view=day&date=${localDay()}`);
    // The panel stayed open from the last test: it is a setting on the server.
    await expect(panel(page)).toBeVisible();
    await calendar(page)
      .getByRole('button', { name: 'Lunch with Eli, 12:00–13:00, read-only' })
      .click();
    const meeting = panel(page).getByTestId('panel-meeting');
    await expect(meeting).toContainText('Lunch with Eli');
    await expect(meeting).toContainText('Corner bistro');
    await expect(meeting.getByRole('button', { name: 'Open in Outlook' })).toBeEnabled();
    // Only the panel shows it; the block's popover stays closed.
    await expect(page.getByTestId('outlook-details')).toHaveCount(1);

    // The arrow keys move the selection with the focus while the panel is open.
    await calendar(page)
      .getByRole('button', { name: 'Lunch with Eli, 12:00–13:00, read-only' })
      .press('ArrowUp');
    await expect(meeting).toContainText('Team standup');
    await expect(meeting).toContainText('Ada Lindqvist');
    await expect(meeting.getByRole('link', { name: 'Join' })).toHaveAttribute(
      'href',
      /^https:\/\/teams\.microsoft\.com\//,
    );
  });

  test('keeps its width after a reload, and its key moves the focus in and back', async ({
    page,
  }) => {
    await page.goto(`/calendar?view=day&date=${localDay(1)}&item=${e2ePanelCardId}`);
    const aside = panel(page);
    await expect(aside.getByTestId('panel-card')).toBeVisible();
    const before = await aside.boundingBox();
    const handle = aside.getByTestId('context-panel-resize');
    const grip = await handle.boundingBox();
    if (!before || !grip) throw new Error('the panel is not on screen');
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 - 100, grip.y + grip.height / 2);
    await page.mouse.up();
    const widened = Math.round(before.width) + 100;
    await expect(handle).toHaveAttribute('aria-valuenow', String(widened));

    await page.reload();
    await expect(aside.getByTestId('panel-card')).toBeVisible();
    await expect(handle).toHaveAttribute('aria-valuenow', String(widened));
    expect(Math.round((await aside.boundingBox())?.width ?? 0)).toBe(widened);
    // The arrow keys on the edge resize it too.
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', String(widened - 16));

    // F6 moves the focus into the panel and back to where it was.
    const today = page.getByRole('button', { name: 'Today' });
    await today.focus();
    await page.keyboard.press('F6');
    await expect(aside).toBeFocused();
    await page.keyboard.press('F6');
    await expect(today).toBeFocused();

    // "Show in panel" from the palette focuses it as well; Ctrl+J closes it.
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await palette.getByRole('combobox').fill('show in panel');
    await expect(palette.getByRole('option').first()).toHaveText(/^Show in panel/);
    await page.keyboard.press('Enter');
    await expect(aside).toBeFocused();
    await page.keyboard.press('Control+j');
    await expect(aside).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Edit card' })).toBeHidden();
  });

  test('folds away below the breakpoint and opens over the view there', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto(`/calendar?view=day&date=${localDay(1)}&item=${e2ePanelCardId}`);
    const toggle = page.getByRole('button', { name: 'Toggle context panel' });
    await toggle.click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).not.toHaveAttribute('data-overlay');

    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(panel(page)).toBeHidden();
    await toggle.click();
    await expect(panel(page)).toHaveAttribute('data-overlay', '');
    await panel(page).getByRole('button', { name: 'Close context panel' }).click();
    await expect(panel(page)).toBeHidden();

    // Opening and closing it over the view left the setting alone: wide again, it is docked.
    await page.setViewportSize({ width: 1400, height: 800 });
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).not.toHaveAttribute('data-overlay');
    await toggle.click();
    await expect(panel(page)).toBeHidden();
  });
});

// Starts a run of the viewer workflow: its step leaves the invented files in `review/` as found
// artifacts and waits at its gate.
async function startViewerRun(runId: string): Promise<void> {
  const response = await fetch(
    `http://127.0.0.1:${e2ePanelTrackerPort}/run?workflowId=${e2eViewerWorkflowId}&runId=${runId}`,
    { method: 'POST' },
  );
  expect(response.ok).toBe(true);
}

// What the mock tracker port received; a request from the viewer's HTML page shows up as /leak….
async function leaks(): Promise<string[]> {
  const response = await fetch(`http://127.0.0.1:${e2ePanelTrackerPort}/requests`);
  const received = (await response.json()) as { path: string }[];
  return received.map((entry) => entry.path).filter((entry) => entry.startsWith('/leak'));
}

test.describe('file viewer', () => {
  test('an artifact opens in the side panel @review-loop-6 @review-loop-7 @agent-workbench-14', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // Every answer the page or a frame in it got from anywhere.
    const answered: string[] = [];
    page.on('response', (response) => answered.push(response.url()));
    await startViewerRun('viewer-e2e-run');
    await page.goto('/workflows/runs/viewer-e2e-run');

    const step = page.getByRole('list', { name: 'Run steps' }).getByTestId('run-step').first();
    const artifacts = step.getByRole('list', { name: 'Artifacts of check-work' });
    await expect(artifacts.getByRole('button', { name: /^Open review\// })).toHaveCount(5);
    // Spec 9: nothing on the page points at the disk any more.
    await expect(page.locator('a[href^="file:"]')).toHaveCount(0);
    // The run waits at its gate, so the panel shows the step's conversation (spec 14).
    await expect(panel(page).getByTestId('panel-step-thread')).toContainText('Step 1 of 1');

    // Markdown is rendered, next to the run view, which stays where it was.
    await artifacts.getByRole('button', { name: 'Open review/notes.md' }).click();
    const viewer = panel(page).getByRole('region', { name: 'File viewer' });
    await expect(viewer.getByTestId('viewer-path')).toHaveText('review/notes.md');
    await expect(viewer.getByRole('heading', { name: 'Review notes' })).toBeVisible();
    await expect(viewer.getByRole('table')).toContainText('Keeps the query after a reload');
    await expect(viewer).toContainText('Markdown');
    await expect(step).toBeVisible();
    // The step's conversation is a tab of its own, and the file opened beside it
    // (agent workbench spec 14).
    await expect(tabNames(page)).toHaveText(['Conversation', 'notes.md']);
    await tabNames(page).first().click();
    await expect(panel(page).getByTestId('panel-step-thread')).toContainText('Step 1 of 1');
    await tabNames(page).nth(1).click();
    await expect(viewer.getByRole('heading', { name: 'Review notes' })).toBeVisible();
    await viewer.getByRole('button', { name: 'Copy path' }).click();
    // The server answers with the resolved path, which differs from the temp folder as written
    // where that is a link or, on Windows, a short name.
    expect(await page.evaluate('navigator.clipboard.readText()')).toBe(
      await realpath(path.join(e2ePanelHome, 'review', 'notes.md')),
    );

    // Back to conversation: the step's thread with its gate is there again.
    await viewer.getByRole('button', { name: 'Back to conversation' }).click();
    await expect(viewer).toBeHidden();
    await expect(panel(page).getByTestId('panel-step-thread')).toContainText('Step 1 of 1');
    await expect(panel(page).getByRole('region', { name: 'Gate' })).toBeVisible();

    // A picture is fitted to the panel, with a switch to its own size.
    await artifacts.getByRole('button', { name: 'Open review/screen.png' }).click();
    const picture = viewer.getByRole('img', { name: 'review/screen.png' });
    await expect(picture).toBeVisible();
    const shownWidth = () => picture.evaluate((element) => element.getBoundingClientRect().width);
    expect(await shownWidth()).toBeLessThan(640);
    await viewer.getByRole('button', { name: 'Full size' }).click();
    await expect(viewer.getByRole('button', { name: 'Fit to panel' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await shownWidth()).toBe(640);

    // Other text shows as code.
    await artifacts.getByRole('button', { name: 'Open review/checks.json' }).click();
    await expect(viewer.getByTestId('viewer-text')).toContainText('"suite": "search-panel"');

    // A binary file that is no picture is not read, and the panel says why.
    await artifacts.getByRole('button', { name: 'Open review/archive.bin' }).click();
    await expect(viewer.getByTestId('viewer-refusal')).toContainText(
      'review/archive.bin is a binary file',
    );

    // HTML shows as a page in a frame that runs nothing while viewer.htmlScripts is off.
    await artifacts.getByRole('button', { name: 'Open review/report.html' }).click();
    const frame = viewer.getByTestId('viewer-html');
    const report = frame.contentFrame();
    await expect(frame).toHaveAttribute('sandbox', '');
    await expect(report.getByRole('heading', { name: 'Search panel report' })).toBeVisible();
    await expect(report.locator('#scripts')).toHaveText('Scripts: off');

    // With the setting on its scripts run, and still reach neither the app nor the network.
    await page.goto('/settings/viewer');
    const scripts = page.getByRole('switch', { name: 'Run scripts in HTML files' });
    await scripts.click();
    await expect(scripts).toBeChecked();
    await page.goto('/workflows/runs/viewer-e2e-run');
    // The palette opens an artifact too.
    await expect(artifacts.getByRole('button', { name: /^Open review\// })).toHaveCount(5);
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').getByRole('combobox').fill('open artifact report');
    await expect(page.getByRole('dialog').getByRole('option').first()).toContainText(
      'Open artifact: review/report.html',
    );
    await page.keyboard.press('Enter');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(report.locator('#scripts')).toHaveText('Scripts: on');
    await expect(report.locator('#app')).toHaveText('App: blocked, storage: blocked');
    await expect(report.locator('#network')).toHaveText('Network: blocked');
    // WebRTC is not there for the page's script, a script in an attribute does not run, and a
    // frame inside the page neither runs its own script nor lends its window.
    await expect(report.locator('#webrtc')).toHaveText('WebRTC: blocked, from a frame: blocked');
    await report.getByRole('button', { name: 'Handler: off' }).click();
    await expect(report.getByRole('button', { name: 'Handler: off' })).toBeVisible();
    // The page's picture, link, fetch and STUN address all name the mock tracker port: the
    // browser got no answer from it and nothing arrived there, not a datagram either.
    await report.getByRole('link', { name: 'A link out' }).click();
    await expect(report.getByRole('heading', { name: 'Search panel report' })).toBeHidden();
    expect(answered.filter((url) => url.includes('/leak'))).toEqual([]);
    expect(await leaks()).toEqual([]);

    // The palette goes back to the conversation. The click took the focus into the frame, which
    // keeps its keys to itself, so the focus has to come back to the app first.
    await viewer.getByTestId('viewer-path').click();
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').getByRole('combobox').fill('back to conversation');
    await page.keyboard.press('Enter');
    await expect(viewer).toBeHidden();
    await expect(panel(page).getByTestId('panel-step-thread')).toBeVisible();

    // Leave the server as the other panel tests expect it: scripts off. The panel was shown for
    // the gate without its setting being turned on, so it is closed away from the run.
    await page.goto('/settings/viewer');
    await scripts.click();
    await expect(scripts).not.toBeChecked();
    await expect(panel(page)).toBeHidden();
  });
});

// A chat thread in the panel copy's project whose answer names files (e2e/server.ts, "show the
// file"): `src/timer.ts` and `docs/spec.md` are invented files of that project.
async function startFileThread(page: Page) {
  await page.goto('/chat/new');
  await choose(page.getByLabel('Project'), 'Demo');
  const composer = page.getByRole('combobox', { name: 'Message' });
  await composer.fill('show the file');
  await composer.press('Enter');
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  const conversation = page.getByRole('list', { name: 'Conversation' });
  await expect(conversation).toContainText('The timer is in');
  return conversation;
}

const tabNames = (page: Page) =>
  panel(page).getByRole('tablist', { name: 'Panel tabs' }).getByRole('tab');

test.describe('files in chat', () => {
  test('opens a file from a chat message in a panel tab @agent-workbench-11 @agent-workbench-12 @agent-workbench-15 @agent-workbench-16 @agent-workbench-18 @agent-workbench-87', async ({
    page,
  }) => {
    const conversation = await startFileThread(page);
    const links = conversation.getByTestId('file-link');
    await expect(links).toHaveText(['src/timer.ts', 'spec', '../outside.txt']);

    // Inline code opens the file in a tab next to the conversation, which stays where it was.
    await links.filter({ hasText: 'src/timer.ts' }).click();
    const viewer = panel(page).getByRole('region', { name: 'File viewer' });
    await expect(viewer.getByTestId('viewer-text')).toContainText('export const ringTwice');
    await expect(conversation).toBeVisible();
    // A relative markdown link is kept and opens the file rendered.
    await links.filter({ hasText: 'spec' }).click();
    await expect(viewer.getByRole('heading', { name: 'Tea timer' })).toBeVisible();
    await expect(tabNames(page)).toHaveText(['Details', 'timer.ts', 'spec.md']);
    // Opening an open file selects its tab.
    await links.filter({ hasText: 'src/timer.ts' }).click();
    await expect(tabNames(page)).toHaveText(['Details', 'timer.ts', 'spec.md']);
    await expect(tabNames(page).nth(1)).toHaveAttribute('aria-selected', 'true');

    // The tab keys, with the focus in the panel.
    await tabNames(page).nth(1).focus();
    await page.keyboard.press('Control+Tab');
    await expect(tabNames(page).nth(2)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Control+Shift+Tab');
    await expect(tabNames(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(tabNames(page).nth(2)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Alt+w');
    await expect(tabNames(page)).toHaveText(['Details', 'timer.ts']);

    // A path that leads outside the thread's folders is refused in words.
    await links.filter({ hasText: '../outside.txt' }).click();
    await expect(viewer.getByTestId('viewer-refusal')).toHaveText(
      "../outside.txt is outside the thread's folder and the project folder, so it was not read.",
    );
    // The focus stayed on the link in the main view: Escape closes the tab from there.
    await expect(links.filter({ hasText: '../outside.txt' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(tabNames(page)).toHaveText(['Details', 'timer.ts']);

    // Open file… from the palette's key lists the project's files, filtered as typed.
    await page.getByRole('list', { name: 'Conversation' }).click();
    await page.keyboard.press('Control+p');
    const dialog = page.getByRole('dialog', { name: 'Open file' });
    await expect(dialog.getByRole('option').first()).toBeVisible();
    await page.keyboard.type('docspec');
    await expect(dialog.getByRole('option').first()).toHaveText('spec.mddocs');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(tabNames(page)).toHaveText(['Details', 'timer.ts', 'spec.md']);
    await expect(viewer.getByRole('heading', { name: 'Tea timer' })).toBeVisible();

    // Another view of the chat and back, inside the app: the tabs are as they were.
    await page.keyboard.press('Control+Alt+n');
    await expect(page).toHaveURL(/\/chat\/new$/);
    await expect(panel(page).getByRole('tablist', { name: 'Panel tabs' })).toBeHidden();
    await page.goBack();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
    await expect(tabNames(page)).toHaveText(['Details', 'timer.ts', 'spec.md']);
    await expect(viewer.getByRole('heading', { name: 'Tea timer' })).toBeVisible();

    // Leave the panel closed for the tests after this one.
    await page.keyboard.press('Control+j');
    await expect(panel(page)).toBeHidden();
  });

  test('mentions a file with @ @agent-workbench-56', async ({ page }) => {
    const conversation = await startFileThread(page);
    const composer = page.getByRole('combobox', { name: 'Message' });
    await composer.click();
    await page.keyboard.type('@tim');
    const files = page.getByRole('listbox', { name: 'Files' });
    await expect(files.getByRole('option').first()).toHaveText('timer.tssrc');
    await page.keyboard.press('Enter');
    await expect(files).toBeHidden();
    await expect(page.getByTestId('composer-file-chip')).toHaveText('@timer.ts');
    await page.keyboard.type('what does it ring?');
    await page.keyboard.press('Enter');
    // The agent got the path in the message's text; the thread shows the chip.
    await expect(conversation).toContainText(/You said: @src\/timer\.ts\s*what does it ring\?/);
    const chip = conversation.getByTestId('sent-file-chip');
    await expect(chip).toHaveText('@timer.ts');
    await chip.click();
    await expect(
      panel(page).getByRole('region', { name: 'File viewer' }).getByTestId('viewer-text'),
    ).toContainText('export const ringTwice');

    await page.keyboard.press('Control+j');
    await expect(panel(page)).toBeHidden();
  });
});

test.describe('sketch', () => {
  test.skip(!sketching, 'Set WOW_E2E_SKETCHES to write the screenshots');
  test.use(sketchUse);

  test('panel tabs beside a chat', async ({ page }) => {
    const conversation = await startFileThread(page);
    const links = conversation.getByTestId('file-link');
    await links.filter({ hasText: 'spec' }).click();
    await links.filter({ hasText: 'src/timer.ts' }).click();
    const viewer = panel(page).getByRole('region', { name: 'File viewer' });
    await expect(viewer.locator('.shiki')).toBeVisible();
    await expect(tabNames(page)).toHaveText(['Details', 'spec.md', 'timer.ts']);
    await page.screenshot({ path: sketchPath('2026-11-agent-workbench', 'panel-tabs') });
    await page.keyboard.press('Control+j');
    await expect(panel(page)).toBeHidden();
  });

  test('the file viewer in the side panel', async ({ page }) => {
    await startViewerRun('viewer-sketch-run');
    await page.goto('/workflows/runs/viewer-sketch-run');
    const step = page.getByRole('list', { name: 'Run steps' }).getByTestId('run-step').first();
    await step.getByRole('button', { name: 'Open review/notes.md' }).click();
    const viewer = panel(page).getByRole('region', { name: 'File viewer' });
    await expect(viewer.getByRole('table')).toBeVisible();
    await expect(viewer.locator('.shiki')).toBeVisible();
    await page.screenshot({ path: sketchPath('2026-11-review-loop', 'file-viewer') });
    await page.keyboard.press('Control+j');
    await expect(panel(page)).toBeHidden();
  });
});
