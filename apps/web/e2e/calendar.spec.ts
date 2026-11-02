import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { e2eHome, e2eOutlookControlPort } from './env';

// U9 ground truth against the mock Outlook (WOW_OUTLOOK=mock, e2e/server.ts): Outlook items and
// mail render, the banner shows on a mock failure, and a card created, moved and resized by mouse
// is still there after a reload. The fixtures sit relative to today in the machine's zone, which
// the browser and the server share.

// These tests switch the shared mock Outlook off and on.
test.describe.configure({ mode: 'serial' });

const HOUR_PX = 48;

test.beforeEach(async ({ page }) => {
  // What the desktop preload injects: the contents of `~/.wow/server.json`.
  const info: unknown = JSON.parse(await readFile(path.join(e2eHome, 'server.json'), 'utf8'));
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

test.afterEach(async () => {
  await control('/unavailable', 'DELETE');
});

async function control(pathname: string, method: string): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${e2eOutlookControlPort}${pathname}`, { method });
  expect(response.ok).toBe(true);
  return method === 'GET' ? response.json() : undefined;
}

const pad = (value: number) => String(value).padStart(2, '0');

// YYYY-MM-DD of today plus `days` in this machine's zone.
function localDay(days = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const calendar = (page: Page) => page.getByRole('region', { name: 'Calendar' });

async function runPaletteCommand(page: Page, title: string) {
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog').getByRole('combobox').fill(title);
  await page.keyboard.press('Enter');
}

// A point in a day column at a wall-clock time, a few pixels below the line.
async function pointAt(column: Locator, minute: number, nudge = 2) {
  const box = await column.boundingBox();
  if (!box) throw new Error('day column is not on screen');
  return { x: box.x + box.width / 2, y: box.y + (minute / 60) * HOUR_PX + nudge };
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

test.describe('calendar', () => {
  test('shows Outlook items read-only with the Teams link, and unread mail', async ({ page }) => {
    await page.goto(`/calendar?view=day&date=${localDay()}`);
    const view = calendar(page);
    await expect(
      view.getByRole('group', { name: 'Lunch with Eli, 12:00–13:00, read-only' }),
    ).toBeVisible();

    await page.goto('/calendar');
    const standups = view.getByRole('group', { name: 'Team standup, 09:15–09:30, read-only' });
    // One per weekday occurrence of the recurring meeting.
    await expect(standups).toHaveCount(5);
    await expect(standups.first().getByLabel('Read-only')).toBeVisible();
    await expect(
      standups.first().getByRole('link', { name: 'Join Teams meeting' }),
    ).toHaveAttribute('href', /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//);
    await expect(standups.first().getByRole('button')).toHaveCount(0);

    await page.goto(`/calendar?view=day&date=${localDay(2)}`);
    await expect(
      view.getByRole('group', {
        name: 'Canceled: Architecture sync, 13:00–13:45, cancelled, read-only',
      }),
    ).toBeVisible();
    await page.goto(`/calendar?view=day&date=${localDay(3)}`);
    await expect(view.getByLabel(`All day ${localDay(3)}`)).toContainText('Planning offsite');

    const rail = page.getByRole('complementary', { name: 'Unread mail' });
    await expect(rail.getByLabel('3 unread')).toBeVisible();
    await expect(rail.getByRole('button')).toHaveText([
      /Nightly build for lantern-web passed/,
      /Notes before tomorrow's design review/,
      /Offsite agenda draft/,
    ]);
    await rail.getByRole('button', { name: /Nightly build/ }).click();
    await expect(rail.getByRole('status')).toHaveText(
      'Opened in Outlook: Nightly build for lantern-web passed',
    );
    expect(await control('/opened', 'GET')).toContain('mock-mail-build');
  });

  test('shows a banner while Outlook is unavailable and keeps the cached items', async ({
    page,
  }) => {
    await page.goto(`/calendar?view=day&date=${localDay()}`);
    const lunch = calendar(page).getByRole('group', { name: /^Lunch with Eli/ });
    await expect(lunch).toBeVisible();
    const banner = page.getByRole('status').filter({ hasText: 'Outlook unavailable' });
    await expect(banner).toBeHidden();

    await control('/unavailable?message=Outlook%20is%20not%20running', 'PUT');
    await runPaletteCommand(page, 'Refresh Outlook');
    await expect(banner).toContainText(/Outlook unavailable since \d\d:\d\d/);
    await expect(banner).toContainText('Outlook is not running');
    await expect(lunch).toBeVisible();
    await expect(
      page.getByRole('complementary', { name: 'Unread mail' }).getByRole('button'),
    ).toHaveCount(3);

    await control('/unavailable', 'DELETE');
    await page.getByRole('button', { name: 'Refresh Outlook' }).click();
    await expect(banner).toBeHidden();
  });

  test('creates, moves and resizes a card, and it stays after a reload', async ({ page }) => {
    const today = localDay();
    await page.goto(`/calendar?view=day&date=${today}`);
    const column = page.getByTestId(`day-${today}`);

    // Drag 16:00 → 17:00 to create.
    await drag(page, await pointAt(column, 16 * 60), await pointAt(column, 17 * 60));
    const dialog = page.getByRole('dialog', { name: 'New card' });
    await expect(dialog.getByLabel('Start')).toHaveValue('16:00');
    await expect(dialog.getByLabel('End')).toHaveValue('17:00');
    await dialog.getByLabel('Title').fill('Focus block');
    await dialog.getByLabel('Title').press('Enter');
    await expect(dialog).toBeHidden();
    const card = calendar(page).getByRole('button', { name: /^Focus block, / });
    await expect(card).toHaveAccessibleName('Focus block, 16:00–17:00, scheduled');
    await expect(card.getByTestId('card-state')).toHaveText('scheduled');

    // Move it one hour later by its middle.
    await drag(page, await pointAt(column, 16 * 60 + 30), await pointAt(column, 17 * 60 + 30));
    await expect(card).toHaveAccessibleName('Focus block, 17:00–18:00, scheduled');

    // Stretch its lower edge by half an hour.
    await drag(page, await pointAt(column, 18 * 60, -2), await pointAt(column, 18 * 60 + 30, -2));
    await expect(card).toHaveAccessibleName('Focus block, 17:00–18:30, scheduled');

    await page.reload();
    await expect(card).toHaveAccessibleName('Focus block, 17:00–18:30, scheduled');

    // A click makes a card of the configured length; the dialog deletes it again.
    const slot = await pointAt(column, 15 * 60);
    await page.mouse.click(slot.x, slot.y);
    const created = page.getByRole('dialog', { name: 'New card' });
    await expect(created.getByLabel('End')).toHaveValue('15:30');
    await created.getByLabel('Title').fill('Quick note');
    await created.getByRole('button', { name: 'Create card' }).click();
    const quick = calendar(page).getByRole('button', { name: /^Quick note, / });
    await expect(quick).toHaveAccessibleName('Quick note, 15:00–15:30, scheduled');
    await quick.focus();
    await page.keyboard.press('Enter');
    await page
      .getByRole('dialog', { name: 'Edit card' })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(quick).toHaveCount(0);
    await page.reload();
    await expect(quick).toHaveCount(0);
    await expect(card).toBeVisible();
  });

  test('moves by day and week with the keys and the palette', async ({ page }) => {
    await page.goto('/calendar?view=day&date=2026-10-24');
    const range = page.getByTestId('calendar-range');
    await expect(range).toHaveText('Saturday 24 October 2026');
    await page.keyboard.press('n');
    await expect(page).toHaveURL(/date=2026-10-25/);
    await expect(range).toHaveText('Sunday 25 October 2026');
    await page.keyboard.press('w');
    await expect(page).toHaveURL(/view=week/);
    // The week of the October DST change, starting on the default Monday.
    await expect(range).toHaveText('19 Oct 2026 – 25 Oct 2026');
    await expect(page.getByTestId(/^day-/)).toHaveCount(7);
    await page.keyboard.press('n');
    await expect(range).toHaveText('26 Oct 2026 – 1 Nov 2026');
    await runPaletteCommand(page, 'Calendar: previous week');
    await expect(range).toHaveText('19 Oct 2026 – 25 Oct 2026');
    await page.keyboard.press('t');
    await expect(page).not.toHaveURL(/date=/);
    await expect(page.locator('[aria-current="date"]')).toHaveCount(1);
  });
});
