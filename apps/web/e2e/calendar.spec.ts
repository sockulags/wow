import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { choose } from './controls';
import { e2eHome, e2eOutlookControlPort } from './env';
import { sketchPath, sketching, sketchUse } from './sketch';

// U9 ground truth against the mock Outlook (WOW_OUTLOOK=mock, e2e/server.ts): Outlook items
// render, the banner shows on a mock failure, and a card created, moved and resized by mouse
// is still there after a reload. The fixtures sit relative to today in the machine's zone, which
// the browser and the server share.

// These tests switch the shared mock Outlook off and on.
test.describe.configure({ mode: 'serial' });

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

// The first day from today on, today included, that is Monday to Friday. The recurring fixtures
// sit on weekdays, so a case that needs one must not depend on the day it runs.
function weekday(): string {
  for (let days = 0; ; days += 1) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    if (date.getDay() !== 0 && date.getDay() !== 6) return localDay(days);
  }
}

const calendar = (page: Page) => page.getByRole('region', { name: 'Calendar' });

async function runPaletteCommand(page: Page, title: string) {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog');
  await palette.getByRole('combobox').fill(title);
  // Enter runs the highlighted command, so wait until the filter has put this one first.
  // The palette shows a command without its group prefix ("Calendar: ").
  const shown = title.replace(/^\w+: /, '');
  await expect(palette.getByRole('option').first()).toHaveText(new RegExp(`^${shown}`, 'i'));
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
}

// A point in a day column at a wall-clock time, a few pixels below the line. The column is one
// whole day tall, so the hour height comes from the rendered page, not the setting's default.
async function pointAt(column: Locator, minute: number, nudge = 2) {
  const box = await column.boundingBox();
  if (!box) throw new Error('day column is not on screen');
  return { x: box.x + box.width / 2, y: box.y + (minute / (24 * 60)) * box.height + nudge };
}

// Scrolls the grid so `minute` is at the top. Where the grid opens depends on the time of day the
// test runs (it shows now when today is in view), so tests that point at times scroll first.
async function reveal(page: Page, minute: number) {
  await page.getByTestId('calendar-scroll').evaluate((element, at) => {
    const grid = element.firstElementChild;
    if (grid) element.scrollTop = (at / (24 * 60)) * grid.getBoundingClientRect().height;
  }, minute);
}

// Keeps the Ctrl key presses and Ctrl+wheel events the page receives from now on. Whether the
// app kept one from the browser (which would zoom the page) is read once dispatch has finished,
// so it does not depend on the order of listeners on the window.
async function watchZoomEvents(page: Page) {
  await page.evaluate(() => {
    type Seen = { type: string; ctrlKey: boolean; code?: string; defaultPrevented: boolean };
    const seen: Seen[] = [];
    (globalThis as { zoomEvents?: Seen[] }).zoomEvents = seen;
    const target = globalThis as unknown as {
      addEventListener(
        type: 'keydown' | 'wheel',
        listener: (event: Seen) => void,
        options?: { capture: boolean; passive: boolean },
      ): void;
    };
    const keep = (event: Seen) => {
      if (event.ctrlKey && !event.code?.startsWith('Control')) seen.push(event);
    };
    target.addEventListener('keydown', keep, { capture: true, passive: true });
    target.addEventListener('wheel', keep, { capture: true, passive: true });
  });
}

const zoomEvents = (page: Page) =>
  page.evaluate(() =>
    (
      (
        globalThis as {
          zoomEvents?: { type: string; code?: string; defaultPrevented: boolean }[];
        }
      ).zoomEvents ?? []
    ).map((event) =>
      event.type === 'wheel'
        ? `wheel ${event.defaultPrevented}`
        : `key ${event.code} ${event.defaultPrevented}`,
    ),
  );

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

test.describe('calendar', () => {
  test('shows Outlook items read-only with the Teams link', async ({ page }) => {
    await page.goto(`/calendar?view=day&date=${localDay()}`);
    const view = calendar(page);
    const lunch = view.getByRole('button', { name: 'Lunch with Eli, 12:00–13:00, read-only' });
    await expect(lunch).toBeVisible();

    // A meeting opens its read-only details: place, organizer, Join and Open in Outlook.
    await lunch.click();
    const details = page.getByTestId('outlook-details');
    await expect(details).toContainText('Corner bistro');
    await details.getByRole('button', { name: 'Open in Outlook' }).click();
    await expect(page.getByText('Opened in Outlook').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(details).toBeHidden();
    await expect(lunch).toBeFocused();

    await page.goto('/calendar');
    const standups = view.getByRole('button', { name: 'Team standup, 09:15–09:30, read-only' });
    // One per weekday occurrence of the recurring meeting.
    await expect(standups).toHaveCount(5);
    await expect(standups.first().getByLabel('Read-only')).toBeVisible();
    await expect(
      standups.first().getByRole('link', { name: 'Join Teams meeting' }),
    ).toHaveAttribute('href', /^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//);
    await expect(standups.first().getByRole('button')).toHaveCount(0);
    // A Teams link reads as "Teams meeting", never as the raw URL.
    await standups.first().click();
    await expect(page.getByTestId('outlook-details')).toContainText('Teams meeting');
    await expect(page.getByTestId('outlook-details')).not.toContainText('https://');
    await expect(page.getByTestId('outlook-details')).toContainText('Ada Lindqvist');
    await page.keyboard.press('Escape');

    await page.goto(`/calendar?view=day&date=${localDay(2)}`);
    await expect(
      view.getByRole('button', {
        name: 'Canceled: Architecture sync, 13:00–13:45, cancelled, read-only',
      }),
    ).toBeVisible();
    await page.goto(`/calendar?view=day&date=${localDay(3)}`);
    await expect(view.getByLabel(`All day ${localDay(3)}`)).toContainText('Planning offsite');
  });

  test('shows a banner while Outlook is unavailable and keeps the cached items', async ({
    page,
  }) => {
    await page.goto(`/calendar?view=day&date=${localDay()}`);
    const lunch = calendar(page).getByRole('button', { name: /^Lunch with Eli/ });
    await expect(lunch).toBeVisible();
    const banner = page.getByTestId('outlook-banner');
    await expect(banner).toBeHidden();

    await control('/unavailable?message=Outlook%20is%20not%20running', 'PUT');
    await runPaletteCommand(page, 'Refresh Outlook');
    await expect(banner).toContainText(/Outlook unavailable since \d\d:\d\d/);
    await expect(banner).toContainText('Outlook is not running');
    await expect(lunch).toBeVisible();

    await control('/unavailable', 'DELETE');
    await banner.getByRole('button', { name: 'Try again' }).click();
    await expect(banner).toBeHidden();
  });

  // Spec 4 (plan U18): Outlook is read for meetings only, and nothing else of Outlook is shown or
  // offered.
  test('shows no mail rail, count or command, and the grid spans the width', async ({ page }) => {
    const anyMention = /mail|unread/i;
    for (const view of ['day', 'week']) {
      await page.goto(`/calendar?view=${view}&date=${weekday()}`);
      const grid = calendar(page);
      await expect(grid.getByRole('button', { name: /^Team standup/ }).first()).toBeVisible();
      await expect(page.getByRole('complementary')).toHaveCount(0);
      await expect(page.getByText(anyMention)).toHaveCount(0);
      await expect(page.getByRole('button', { name: anyMention })).toHaveCount(0);
      // The calendar takes all the room its row has.
      const row = await grid.locator('..').boundingBox();
      const own = await grid.boundingBox();
      expect(own && row && Math.abs(own.width - row.width)).toBeLessThanOrEqual(1);

      await page.keyboard.press('Control+k');
      const palette = page.getByRole('dialog');
      await palette.getByRole('combobox').fill('mail');
      await expect(palette.getByRole('option', { name: anyMention })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(palette).toBeHidden();
    }
    // The server asked the mock Outlook for the calendar and its profile, never anything else.
    const asked = (await control('/asked', 'GET')) as string[];
    expect(asked.filter((op) => !['calendar', 'open', 'ping', 'profile'].includes(op))).toEqual([]);
    expect(asked).toContain('calendar');
  });

  test('creates, moves and resizes a card, and it stays after a reload', async ({ page }) => {
    const today = localDay();
    await page.goto(`/calendar?view=day&date=${today}`);
    const column = page.getByTestId(`day-${today}`);
    await reveal(page, 14 * 60);

    // Drag 16:00 → 17:00 to create.
    await drag(page, await pointAt(column, 16 * 60), await pointAt(column, 17 * 60));
    const dialog = page.getByRole('dialog', { name: 'New card' });
    await expect(dialog.getByLabel('Start')).toHaveValue('16:00');
    await expect(dialog.getByLabel('End')).toHaveValue('17:00');
    await dialog.getByLabel('Title').fill('Focus block');
    await dialog.getByLabel('Title').press('Enter');
    await expect(dialog).toBeHidden();
    const card = calendar(page).getByRole('button', { name: /^Focus block, / });
    await expect(card).toHaveAccessibleName('Focus block, 16:00–17:00');
    // Only triggers (a workflow in a project) carry a state.
    await expect(card.getByTestId('card-state')).toHaveCount(0);

    // Move it one hour later by its middle.
    await drag(page, await pointAt(column, 16 * 60 + 30), await pointAt(column, 17 * 60 + 30));
    await expect(card).toHaveAccessibleName('Focus block, 17:00–18:00');

    // Stretch its lower edge by half an hour.
    await drag(page, await pointAt(column, 18 * 60, -2), await pointAt(column, 18 * 60 + 30, -2));
    await expect(card).toHaveAccessibleName('Focus block, 17:00–18:30');

    await page.reload();
    await expect(card).toHaveAccessibleName('Focus block, 17:00–18:30');
    // The reload opened the grid at now again.
    await reveal(page, 14 * 60);

    // A click makes a card of the configured length; the dialog deletes it again.
    const slot = await pointAt(column, 15 * 60);
    await page.mouse.click(slot.x, slot.y);
    const created = page.getByRole('dialog', { name: 'New card' });
    await expect(created.getByLabel('End')).toHaveValue('15:30');
    await created.getByLabel('Title').fill('Quick note');
    await created.getByRole('button', { name: 'Create card' }).click();
    const quick = calendar(page).getByRole('button', { name: /^Quick note, / });
    await expect(quick).toHaveAccessibleName('Quick note, 15:00–15:30');
    await quick.focus();
    await page.keyboard.press('Enter');
    await page
      .getByRole('dialog', { name: 'Edit card' })
      .getByRole('button', { name: 'Delete card' })
      .click();
    await expect(quick).toHaveCount(0);
    // Deleting happens at once and offers Undo.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(quick).toHaveAccessibleName('Quick note, 15:00–15:30');
    await quick.focus();
    await page.keyboard.press('Enter');
    await page
      .getByRole('dialog', { name: 'Edit card' })
      .getByRole('button', { name: 'Delete card' })
      .click();
    await expect(quick).toHaveCount(0);
    await page.reload();
    await expect(quick).toHaveCount(0);
    await expect(card).toBeVisible();
  });

  test('moves by day and week with the keys and the palette', async ({ page }) => {
    await page.goto('/calendar?view=day&date=2026-10-24');
    const range = page.getByTestId('calendar-range');
    // The toolbar keeps a long and a short form and shows the one that fits.
    const shown = { useInnerText: true };
    await expect(range).toHaveText('Saturday 24 October 2026', shown);
    await page.keyboard.press('n');
    await expect(page).toHaveURL(/date=2026-10-25/);
    await expect(range).toHaveText('Sunday 25 October 2026', shown);
    await page.keyboard.press('w');
    await expect(page).toHaveURL(/view=week/);
    // The week of the October DST change, starting on Monday as the mock Outlook says.
    await expect(range).toHaveText('19–25 Oct 2026', shown);
    await expect(page.getByTestId('calendar-week')).toHaveText('Week 43');
    await expect(page.getByTestId(/^day-/)).toHaveCount(7);
    await page.keyboard.press('n');
    await expect(range).toHaveText('26 Oct – 1 Nov 2026', shown);
    await runPaletteCommand(page, 'Calendar: previous week');
    await expect(range).toHaveText('19–25 Oct 2026', shown);
    // The palette hides and shows the weekend (calendar.showWeekends).
    await runPaletteCommand(page, 'Calendar: hide weekends');
    await expect(page.getByTestId(/^day-/)).toHaveCount(5);
    await expect(range).toHaveText('19–23 Oct 2026', shown);
    await runPaletteCommand(page, 'Calendar: show weekends');
    await expect(page.getByTestId(/^day-/)).toHaveCount(7);
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.keyboard.press('t');
    await expect(page).not.toHaveURL(/date=/);
    await expect(page.locator('[aria-current="date"]')).toHaveCount(1);
  });

  test('zooms with the keys, the toolbar and Ctrl+wheel, and keeps the zoom after a reload', async ({
    page,
  }) => {
    const day = localDay(4);
    await page.goto(`/calendar?view=day&date=${day}`);
    const column = page.getByTestId(`day-${day}`);
    const level = page.getByTestId('calendar-zoom');
    const dayHeight = async () => (await column.boundingBox())?.height ?? 0;
    await expect(level).toHaveText('100%');
    expect(await dayHeight()).toBe(24 * 48);
    await reveal(page, 9 * 60);

    await watchZoomEvents(page);
    await page.keyboard.press('Control+Equal');
    await expect(level).toHaveText('120%');
    expect(await dayHeight()).toBe(24 * 58);
    await page.keyboard.press('Control+Minus');
    await expect(level).toHaveText('100%');
    // The app claims the keys, so the browser does not zoom the page as well.
    expect(await zoomEvents(page)).toEqual(['key Equal true', 'key Minus true']);
    await page.getByRole('button', { name: 'Zoom in calendar' }).click();
    await page.getByRole('button', { name: 'Zoom in calendar' }).click();
    await expect(level).toHaveText('140%');
    expect(await dayHeight()).toBe(24 * 67);

    await page.reload();
    await expect(level).toHaveText('140%');
    expect(await dayHeight()).toBe(24 * 67);

    // The level opens a menu of steps.
    await level.click();
    await page.getByRole('menuitemradio', { name: '200%' }).click();
    await expect(level).toHaveText('200%');
    expect(await dayHeight()).toBe(24 * 96);

    await runPaletteCommand(page, 'Reset calendar zoom');
    await expect(level).toHaveText('100%');
    await runPaletteCommand(page, 'Zoom out calendar');
    await expect(level).toHaveText('80%');
    await page.keyboard.press('Control+0');
    await expect(level).toHaveText('100%');

    // Ctrl+wheel zooms around the pointer: the time under it stays where it is.
    await reveal(page, 9 * 60);
    await watchZoomEvents(page);
    const before = await column.boundingBox();
    if (!before) throw new Error('day column is not on screen');
    const pointer = { x: before.x + before.width / 2, y: before.y + (10.5 / 24) * before.height };
    await page.mouse.move(pointer.x, pointer.y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await expect(level).toHaveText('120%');
    const after = await column.boundingBox();
    if (!after) throw new Error('day column is not on screen');
    expect(after.height).toBe(24 * 58);
    const minuteUnder = ((pointer.y - after.y) / after.height) * 24 * 60;
    expect(Math.abs(minuteUnder - 10.5 * 60)).toBeLessThan(2);

    await page.keyboard.press('Control+0');
    await expect(level).toHaveText('100%');
    expect(await zoomEvents(page)).toEqual(['wheel true', 'key Digit0 true']);
  });

  test('puts overlapping meetings and cards side by side', async ({ page }) => {
    const day = localDay(4);
    await page.goto(`/calendar?view=day&date=${day}`);
    const view = calendar(page);
    const column = page.getByTestId(`day-${day}`);
    await reveal(page, 9 * 60);

    // A local card in the middle of the invented overlapping meetings.
    await page.getByRole('button', { name: 'New card', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New card' });
    await dialog.getByLabel('Title').fill('Write the release notes for lantern-web');
    await dialog.getByLabel('Start').fill('10:45');
    await dialog.getByLabel('End').fill('11:45');
    await dialog.getByRole('button', { name: 'Create card' }).click();
    await expect(dialog).toBeHidden();
    const card = view.getByRole('button', { name: /^Write the release notes for lantern-web, / });
    await expect(card).toHaveAccessibleName('Write the release notes for lantern-web, 10:45–11:45');

    // The invented meetings from 10:00 to 12:00 and the card. The weekday meetings (the standup,
    // and the 1:1 on Thursdays) sit apart and are there or not depending on the day.
    const blocks = view.locator('[data-item]').filter({
      hasNotText: /Team standup|1:1 with Bo/,
    });
    await expect(blocks).toHaveCount(6);
    const columnBox = await column.boundingBox();
    if (!columnBox) throw new Error('day column is not on screen');
    const boxes = await blocks.evaluateAll((elements) =>
      elements.map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { name: element.getAttribute('aria-label') ?? '', x, y, width, height };
      }),
    );
    for (const [index, a] of boxes.entries()) {
      // Every block is narrower than the day but still wide enough to show something.
      expect(a.width, a.name).toBeLessThan(columnBox.width / 2);
      expect(a.width, a.name).toBeGreaterThan(40);
      for (const b of boxes.slice(index + 1)) {
        const across = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const down = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        expect(across > 0 && down > 0, `${a.name} covers ${b.name}`).toBe(false);
      }
    }

    // The full title is on hover and on focus even when the block cuts it off.
    await card.hover();
    await expect(page.getByTestId('block-tooltip').first()).toContainText(
      'Write the release notes for lantern-web10:45–11:45',
    );
    await view.getByRole('button', { name: /^Release planning for lantern-web 2\.4, / }).focus();
    await expect(page.getByTestId('block-tooltip').first()).toContainText(
      'Release planning for lantern-web 2.410:00–11:30Room Ferrite',
    );

    // A narrow card still moves by mouse; then it is gone again for the other tests.
    const box = await card.boundingBox();
    if (!box) throw new Error('card is not on screen');
    const hour = columnBox.height / 24;
    await drag(
      page,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      { x: box.x + box.width / 2, y: box.y + box.height / 2 + 2 * hour },
    );
    await expect(card).toHaveAccessibleName('Write the release notes for lantern-web, 12:45–13:45');
    await card.focus();
    await page.keyboard.press('Enter');
    await page
      .getByRole('dialog', { name: 'Edit card' })
      .getByRole('button', { name: 'Delete card' })
      .click();
    await expect(card).toHaveCount(0);
  });

  test('moves between items with the keyboard and moves a card with Alt', async ({ page }) => {
    const day = localDay(4);
    await page.goto(`/calendar?view=day&date=${day}`);
    const view = calendar(page);
    await reveal(page, 9 * 60);
    await page.getByRole('button', { name: 'New card', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New card' });
    await dialog.getByLabel('Title').fill('Keyboard card');
    await dialog.getByLabel('Start').fill('15:00');
    await dialog.getByLabel('End').fill('15:30');
    await dialog.getByRole('button', { name: 'Create card' }).click();
    const card = view.getByRole('button', { name: /^Keyboard card, / });
    await expect(card).toBeVisible();

    // The skip link lands in the grid, which is one Tab stop.
    await page.getByRole('link', { name: 'Skip to calendar' }).focus();
    await page.keyboard.press('Enter');
    const focused = page.locator('[data-stop]:focus');
    await expect(focused).toHaveCount(1);
    await expect(view.locator('[data-stop][tabindex="0"]')).toHaveCount(1);
    await page.keyboard.press('End');
    await expect(card).toBeFocused();
    await page.keyboard.press('Home');
    await expect(card).not.toBeFocused();
    await page.keyboard.press('End');

    // Alt+arrows move the card by the snap step; Alt+Shift+arrows move its end.
    await page.keyboard.press('Alt+ArrowDown');
    await expect(card).toHaveAccessibleName('Keyboard card, 15:15–15:45');
    await expect(card).toBeFocused();
    await page.keyboard.press('Alt+Shift+ArrowDown');
    await expect(card).toHaveAccessibleName('Keyboard card, 15:15–16:00');
    await page.keyboard.press('Enter');
    const edit = page.getByRole('dialog', { name: 'Edit card' });
    await expect(edit.getByTestId('card-duration')).toHaveText('45 min');
    await page.keyboard.press('Escape');
    // Focus returns to the card the dialog was opened from.
    await expect(card).toBeFocused();
    await page.keyboard.press('Enter');
    await edit.getByRole('button', { name: 'Delete card' }).click();
    await expect(card).toHaveCount(0);
  });

  test('refuses an end before the start and says what a trigger will do', async ({ page }) => {
    await page.goto(`/calendar?view=day&date=${localDay(4)}`);
    await expect(page.getByTestId(`day-${localDay(4)}`)).toBeVisible();
    await page.keyboard.press('c');
    const dialog = page.getByRole('dialog', { name: 'New card' });
    await expect(dialog.getByLabel('Title')).toHaveAttribute(
      'placeholder',
      'What is this time for?',
    );
    await dialog.getByLabel('Title').fill('Backwards');
    await dialog.getByLabel('Start').fill('14:45');
    await dialog.getByLabel('End').fill('10:00');
    await expect(dialog.getByText('Ends before it starts')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create card' })).toBeDisabled();
    await dialog.getByLabel('End').fill('15:30');
    await expect(dialog.getByTestId('card-duration')).toHaveText('45 min');
    await expect(dialog.getByRole('button', { name: 'Create card' })).toBeEnabled();

    await choose(dialog.getByLabel('Workflow'), 'Backlog e2e');
    await choose(dialog.getByLabel('Project'), 'No project');
    await expect(dialog.getByTestId('trigger-summary')).toHaveText('Will not run: pick a project.');
    await choose(dialog.getByLabel('Project'), 'Demo');
    await expect(dialog.getByTestId('trigger-summary')).toContainText('Starts at 14:45 in Demo');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  test('settings follow Outlook for zone, work hours and first day until overridden', async ({
    page,
  }) => {
    await page.goto('/settings/calendar');
    const hours = page.getByTestId('setting-calendar.workHours');
    await expect(hours).toContainText('From Outlook: 08:30–17:00, Mon–Fri');
    await expect(page.getByTestId('setting-calendar.firstDayOfWeek')).toContainText(
      'From Outlook: Monday',
    );
    const zone = page.getByRole('combobox', { name: 'Time zone' });
    await expect(zone).toContainText('From Outlook');
    await zone.click();
    await expect(page.getByRole('option', { name: /^System \(/ })).toBeVisible();
    await page.getByPlaceholder(/Search zones/).fill('Tokyo');
    await expect(page.getByRole('option', { name: 'Asia/Tokyo (UTC+9)' })).toBeVisible();
    await page.keyboard.press('Escape');

    // The calendar shades Outlook's work hours.
    await page.goto(`/calendar?view=day&date=${localDay(7 - new Date().getDay() + 1)}`);
    const band = page.getByTestId('work-hours').first();
    const column = page.getByTestId(/^day-/).first();
    const [bandBox, columnBox] = [await band.boundingBox(), await column.boundingBox()];
    if (!bandBox || !columnBox) throw new Error('work hours are not on screen');
    expect(Math.round(((bandBox.y - columnBox.y) / columnBox.height) * 24 * 60)).toBe(8 * 60 + 30);
  });
});

// Recurring cards (plan U2): a weekday card drawn in two weeks, one occurrence skipped and the
// series deleted, against the mock Outlook and the e2e server's own scheduler. The cards start on
// a Monday at least a week ahead, so no occurrence is reached while a case runs.

const shortMonths = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

// Days from today to the first Monday at least seven days away.
function mondayAhead(): number {
  for (let days = 7; ; days += 1) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    if (date.getDay() === 1) return days;
  }
}

// "Mon 23 Nov", as the card form names a day.
function shortDay(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${names[date.getDay()]} ${date.getDate()} ${shortMonths[date.getMonth()]}`;
}

const occurrencesOf = (page: Page, title: string) =>
  calendar(page).getByRole('button', {
    name: new RegExp(`^${title}, \\d\\d:\\d\\d–\\d\\d:\\d\\d, repeats`),
  });

// Makes a card on `monday` at 06:00 that repeats every weekday and runs a workflow in Demo.
async function repeatOnWeekdays(page: Page, title: string, monday: number) {
  await page.goto(`/calendar?view=week&date=${localDay(monday)}`);
  await expect(page.getByTestId(`day-${localDay(monday)}`)).toBeVisible();
  await page.getByRole('button', { name: 'New card', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New card' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Date').fill(localDay(monday));
  await dialog.getByLabel('Start').fill('06:00');
  await dialog.getByLabel('End').fill('06:15');
  await choose(dialog.getByLabel('Workflow'), 'Backlog e2e');
  await choose(dialog.getByLabel('Project'), 'Demo');
  await choose(dialog.getByLabel('Repeats'), 'Weekly');
  // A weekly rule starts with the card's own weekday chosen.
  await expect(dialog.getByRole('button', { name: 'Monday' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(dialog.getByTestId('repeat-words')).toHaveText('Every week on Monday at 06:00');
  for (const day of ['Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
    await dialog.getByRole('button', { name: day }).click();
  }
  await expect(dialog.getByTestId('repeat-words')).toHaveText('Every weekday at 06:00');
  await dialog.getByRole('button', { name: 'Create card' }).click();
  await expect(dialog).toBeHidden();
  return dialog;
}

test.describe('repeating cards', () => {
  test('a card repeats on weekdays @recurring-cards-15 @recurring-cards-16 @recurring-cards-11', async ({
    page,
  }) => {
    const monday = mondayAhead();
    await repeatOnWeekdays(page, 'Brew log', monday);
    const shown = occurrencesOf(page, 'Brew log');
    await expect(shown).toHaveCount(5);
    await expect(shown.first()).toHaveAccessibleName('Brew log, 06:00–06:15, repeats, scheduled');
    await expect(shown.first().getByTestId('card-repeats')).toBeVisible();

    // The form says the rule in words and when the card fires next.
    await shown.first().focus();
    await page.keyboard.press('Enter');
    const edit = page.getByRole('dialog', { name: 'Edit card' });
    await expect(edit.getByTestId('repeat-words')).toHaveText('Every weekday at 06:00');
    await expect(edit.getByTestId('repeat-next')).toHaveText(
      `Fires next ${shortDay(monday)}, 06:00`,
    );
    await edit.getByRole('button', { name: 'Cancel' }).click();
    await expect(edit).toBeHidden();
    // The dialog's overlay fades out after it; a drag before then lands on the overlay.
    await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);

    // A drag of Wednesday's occurrence moves the series to the new time.
    await reveal(page, 5 * 60);
    const wednesday = page.getByTestId(`day-${localDay(monday + 2)}`);
    await drag(page, await pointAt(wednesday, 6 * 60 + 5), await pointAt(wednesday, 7 * 60 + 5));
    await expect(shown).toHaveCount(5);
    for (const occurrence of await shown.all()) {
      await expect(occurrence).toHaveAccessibleName('Brew log, 07:00–07:15, repeats, scheduled');
    }

    await page.goto(`/calendar?view=week&date=${localDay(monday + 7)}`);
    await expect(shown).toHaveCount(5);
    await expect(shown.last()).toHaveAccessibleName('Brew log, 07:00–07:15, repeats, scheduled');

    await shown.first().focus();
    await page.keyboard.press('Delete');
    await page
      .getByRole('alertdialog', { name: 'Delete which?' })
      .getByRole('button', { name: 'The whole series' })
      .click();
    await expect(shown).toHaveCount(0);
  });

  test('skip one occurrence @recurring-cards-12 @recurring-cards-13', async ({ page }) => {
    const monday = mondayAhead();
    await repeatOnWeekdays(page, 'Kettle check', monday);
    const shown = occurrencesOf(page, 'Kettle check');
    await expect(shown).toHaveCount(5);

    // Delete on Thursday's occurrence offers both; this occurrence leaves out that day only.
    await reveal(page, 5 * 60);
    const thursday = page.getByTestId(`day-${localDay(monday + 3)}`);
    await thursday.getByRole('button', { name: /^Kettle check, / }).focus();
    await page.keyboard.press('Delete');
    const which = page.getByRole('alertdialog', { name: 'Delete which?' });
    await expect(which).toContainText(`Delete only ${shortDay(monday + 3)}`);
    await expect(which.getByRole('button', { name: 'The whole series' })).toBeVisible();
    await which.getByRole('button', { name: 'This occurrence' }).click();
    await expect(shown).toHaveCount(4);
    await expect(thursday.getByRole('button', { name: /^Kettle check, / })).toHaveCount(0);

    // Undo brings the day back.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(shown).toHaveCount(5);
    await expect(thursday.getByRole('button', { name: /^Kettle check, / })).toHaveCount(1);

    await shown.first().focus();
    await page.keyboard.press('Delete');
    await which.getByRole('button', { name: 'The whole series' }).click();
    await expect(shown).toHaveCount(0);
  });

  test('delete the series @recurring-cards-12 @recurring-cards-13', async ({ page }) => {
    const monday = mondayAhead();
    await repeatOnWeekdays(page, 'Steep timer', monday);
    const shown = occurrencesOf(page, 'Steep timer');
    await expect(shown).toHaveCount(5);

    // From the form: Delete… asks, the whole series removes every occurrence.
    await shown.nth(1).focus();
    await page.keyboard.press('Enter');
    const edit = page.getByRole('dialog', { name: 'Edit card' });
    await edit.getByRole('button', { name: 'Delete…' }).click();
    await edit
      .getByRole('alertdialog', { name: 'Delete which?' })
      .getByRole('button', { name: 'The whole series' })
      .click();
    await expect(shown).toHaveCount(0);

    // Undo makes the card again with its rule: this week and the next show it again.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(shown).toHaveCount(5);
    await page.getByRole('button', { name: 'Next week' }).click();
    await expect(page.getByTestId(`day-${localDay(monday + 7)}`)).toBeVisible();
    await expect(shown).toHaveCount(5);

    await shown.first().focus();
    await page.keyboard.press('Delete');
    await page
      .getByRole('alertdialog', { name: 'Delete which?' })
      .getByRole('button', { name: 'The whole series' })
      .click();
    await expect(shown).toHaveCount(0);
  });
});

test.describe('sketch', () => {
  test.skip(!sketching, 'Set WOW_E2E_SKETCHES to write the screenshots');
  test.use(sketchUse);

  test('a repeating card in the week and its form', async ({ page }) => {
    const monday = mondayAhead();
    await repeatOnWeekdays(page, 'Morning brew report', monday);
    const shown = occurrencesOf(page, 'Morning brew report');
    await expect(shown).toHaveCount(5);
    await reveal(page, 5 * 60);
    await shown.nth(2).focus();
    await page.keyboard.press('Enter');
    const edit = page.getByRole('dialog', { name: 'Edit card' });
    await expect(edit.getByTestId('repeat-next')).toBeVisible();
    await page.screenshot({ path: sketchPath('2026-11-recurring-cards', 'repeat') });
    await edit.getByRole('button', { name: 'Delete…' }).click();
    await edit
      .getByRole('alertdialog', { name: 'Delete which?' })
      .getByRole('button', { name: 'The whole series' })
      .click();
    await expect(shown).toHaveCount(0);
  });
});
