import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { choose } from './controls';
import { e2ePanelCardId, e2ePanelHome } from './env';
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

// The first day from today on that is Monday to Friday: the standup sits on weekdays only.
function weekday(): string {
  for (let days = 0; ; days += 1) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    if (date.getDay() !== 0 && date.getDay() !== 6) return localDay(days);
  }
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Context panel' });
const calendar = (page: Page) => page.getByRole('region', { name: 'Calendar' });

test.describe('context panel', () => {
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

    if (weekday() === localDay()) {
      // The arrow keys move the selection with the focus while the panel is open.
      await calendar(page)
        .getByRole('button', { name: 'Lunch with Eli, 12:00–13:00, read-only' })
        .press('ArrowUp');
    } else {
      // On a weekend the standup is not on the lunch's day, so there is no block to step to.
      await page.goto(`/calendar?view=day&date=${weekday()}`);
      await calendar(page)
        .getByRole('button', { name: 'Team standup, 09:15–09:30, read-only' })
        .click();
    }
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

test.describe('file viewer', () => {});

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

  test('opens the file of a Read row with Open @agent-workbench-17', async ({ page }) => {
    await page.goto('/chat/new');
    await choose(page.getByLabel('Project'), 'Demo');
    const composer = page.getByRole('combobox', { name: 'Message' });
    await composer.fill('read the timer');
    await composer.press('Enter');
    const conversation = page.getByRole('list', { name: 'Conversation' });
    await expect(conversation).toContainText('The timer rings twice.');
    // The mock reports the Read as the Claude adapter does: its full path in the tool facts.
    const row = conversation.getByTestId('item-tool_call');
    // A tool row shows the path as the provider wrote it, so with backslashes on Windows.
    await expect(row.getByTestId('tool-line')).toHaveText(/^Read src[\\/]timer\.ts$/);
    await row.getByRole('button', { name: /^Open src[\\/]timer\.ts$/ }).click();
    await expect(tabNames(page)).toHaveText(['Details', 'timer.ts']);
    await expect(tabNames(page).nth(1)).toHaveAttribute('aria-selected', 'true');
    const viewer = panel(page).getByRole('region', { name: 'File viewer' });
    await expect(viewer.getByTestId('viewer-path')).toHaveText(/^src[\\/]timer\.ts$/);
    await expect(viewer.getByTestId('viewer-text')).toContainText('export const ringTwice');

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
});
