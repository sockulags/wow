import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { e2eHome } from './env';

// Behavior 22 against the chat server (e2e/server.ts): one palette searches cards, backlog items,
// workflows and settings pages, and the keyboard picks the result (threads and actions are in
// chat.spec.ts). Other tests share this server, so every query names something only this test has.

test.beforeEach(async ({ page }) => {
  // What the desktop preload injects: the contents of `~/.wow/server.json`.
  const info: unknown = JSON.parse(await readFile(path.join(e2eHome, 'server.json'), 'utf8'));
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

const pad = (value: number) => String(value).padStart(2, '0');

function localDay(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Opens the palette, types, checks what the keyboard would pick, and picks it with Enter.
async function pick(page: Page, query: string, expected: string) {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox').fill(query);
  await expect(palette.getByRole('option').first()).toContainText(expected);
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
}

test.describe('palette', () => {
  test('finds cards, backlog items, workflows and settings pages', async ({ page }) => {
    // A backlog item planned on the calendar a month ahead gives one item and one card.
    await page.goto('/backlog');
    await page.getByRole('navigation', { name: 'Backlog' }).getByText('New item').click();
    const form = page.getByRole('form', { name: 'New backlog item' });
    await form.getByLabel('Title').fill('Quarterly cleanup');
    await form.getByLabel('Body (markdown)').fill('Remove the dead flags.');
    await form.getByRole('button', { name: 'Add item' }).click();
    await expect(page).toHaveURL(/\/backlog\/[0-9a-f-]{36}$/);
    const itemUrl = page.url();
    await page.getByRole('toolbar', { name: 'Item actions' }).getByText('Plan on calendar').click();
    const plan = page.getByRole('dialog', { name: 'Plan on calendar' });
    await plan.getByLabel('Workflow').selectOption({ label: 'Backlog e2e' });
    await plan.getByLabel('Project').selectOption({ label: 'Demo' });
    await plan.getByLabel('Date').fill(localDay(30));
    await plan.getByLabel('Start').fill('10:00');
    await plan.getByRole('button', { name: 'Plan' }).click();
    await expect(plan).toBeHidden();

    await page.goto('/chat');
    await pick(page, 'edit card quarterly', 'Edit card: Quarterly cleanup');
    await expect(page).toHaveURL(new RegExp(`/calendar.*date=${localDay(30)}`));
    const card = page.getByRole('dialog', { name: 'Edit card' });
    await expect(card.getByLabel('Title')).toHaveValue('Quarterly cleanup');
    await card.getByRole('button', { name: 'Cancel' }).click();

    await pick(page, 'backlog quarterly', 'Backlog: Quarterly cleanup');
    await expect(page).toHaveURL(itemUrl);

    // Its id keeps the runs of this workflow, which other tests start, out of the way.
    await pick(page, 'workflow backlog-e2e', 'Workflow: Backlog e2e');
    await expect(page).toHaveURL(/\/workflows\/backlog-e2e$/);

    await pick(page, 'settings calendar', 'Settings: Calendar');
    await expect(page).toHaveURL(/\/settings\/calendar$/);
  });
});
