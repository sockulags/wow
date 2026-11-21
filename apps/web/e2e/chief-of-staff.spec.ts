import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { choose } from './controls';
import { e2eAssistantHome as home } from './env';

// Chief of staff U7 ground truth against the assistant's copy of the e2e server, whose mock agent
// calls wow's tools (e2e/assistant-agent.ts): memory, a permission added in Settings and used to
// start a thread, the decision queue answered by its key, a briefing, and a focus card. The
// conversation is shared, so the cases run in order.
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  const info: unknown = JSON.parse(await readFile(path.join(home, 'server.json'), 'utf8'));
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

const conversation = (page: Page) => page.getByRole('list', { name: 'Conversation' });
const composer = (page: Page) => page.getByRole('combobox', { name: 'Message' });

// The window hidden or shown, as the browser tells the page (a script run in the page).
const visibility = (hidden: boolean) =>
  `Object.defineProperty(document, 'hidden', { configurable: true, get: () => ${hidden} });
   document.dispatchEvent(new Event('visibilitychange'));`;

async function say(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(
    conversation(page).getByTestId('item-user').filter({ hasText: text }).last(),
  ).toBeVisible();
  await expect(conversation(page).locator(':scope > li').last()).toHaveAttribute(
    'data-testid',
    'item-assistant_text',
  );
}

test('the assistant keeps a note you can edit in Settings @chief-of-staff-29 @chief-of-staff-30', async ({
  page,
}) => {
  await page.goto('/assistant');
  await say(page, 'remember: Never plan anything before nine.');
  await expect(
    page.getByTestId('assistant-change').filter({ hasText: 'Memory' }).last(),
  ).toContainText('Never plan anything before nine.');
  await page.goto('/settings/assistant');
  const memory = page.getByRole('region', { name: 'Memory' });
  const note = memory.getByTestId('assistant-note');
  await expect(note).toHaveCount(1);
  await expect(note).toContainText('Kept by the assistant');
  await note.getByRole('button', { name: 'Remove the note' }).click();
  await expect(memory.getByTestId('assistant-note')).toHaveCount(0);
});

test('a permission added in Settings lets the assistant start a thread @chief-of-staff-4 @chief-of-staff-9 @chief-of-staff-10', async ({
  page,
}) => {
  await page.goto('/settings/assistant');
  await page.getByRole('switch', { name: 'Let the assistant act under its permissions' }).click();
  await expect(
    page.getByRole('switch', { name: 'Let the assistant act under its permissions' }),
  ).toBeChecked();
  const add = page.getByRole('region', { name: 'Add a permission' });
  await choose(add.getByLabel('Kind'), 'Start threads');
  await add.getByRole('checkbox', { name: 'Demo' }).click();
  await add.getByRole('button', { name: 'Add permission' }).click();
  await expect(page.getByTestId('assistant-permission')).toContainText('Start threads');

  await page.goto('/assistant');
  await say(page, 'Please fix the kettle fixture in Demo.');
  await expect(page.getByTestId('assistant-permission-use').last()).toContainText(
    'Started "Fix the kettle fixture" in Demo',
  );
  await page.getByTestId('assistant-permission-use').last().getByRole('link').click();
  await expect(page.getByTestId('thread-started-by-assistant')).toBeVisible();
});

test('the queue lists what waits and answers it with the gate key @chief-of-staff-16 @chief-of-staff-17 @chief-of-staff-19', async ({
  page,
}) => {
  await page.goto('/assistant');
  const queue = page.getByRole('region', { name: 'Needs you' });
  // Another file may have left a gate of the same workflow waiting; this case adds one more.
  const gates = queue.locator('[data-testid="decision"][data-kind="gate"]');
  const before = await gates.count();
  await say(page, 'Start the kettle check in Demo.');
  const proposal = queue
    .locator('[data-testid="decision"][data-kind="proposal"]')
    .filter({ hasText: 'Kettle check' })
    .last();
  await expect(proposal).toBeVisible();
  await proposal.focus();
  await page.keyboard.press('Control+Enter');
  // The run waits before its only step: one more gate in the queue, ahead of any proposal.
  await expect(gates).toHaveCount(before + 1);
  await expect(queue.getByTestId('decision').first()).not.toHaveAttribute('data-kind', 'proposal');
});

test('a briefing when you come back after a while away @chief-of-staff-20 @chief-of-staff-21', async ({
  page,
}) => {
  await page.goto('/settings/assistant');
  const briefings = page.getByRole('switch', { name: 'Briefings', exact: true });
  if (!(await briefings.isChecked())) await briefings.click();
  await expect(briefings).toBeChecked();
  // The window was hidden two hours ago by the page's clock and is shown again now.
  await page.clock.install({ time: new Date(Date.now() - 2 * 60 * 60 * 1000) });
  await page.goto('/assistant');
  await page.evaluate(visibility(true));
  await page.clock.setSystemTime(new Date());
  await page.evaluate(visibility(false));
  const briefing = page.getByTestId('briefing');
  await expect(briefing).toContainText('Welcome back');
  await expect(briefing).toContainText('wait');
});

test('a focus card is time kept free @chief-of-staff-28', async ({ page }) => {
  await page.goto('/calendar?view=day');
  await expect(page.getByRole('region', { name: 'Calendar' })).toBeVisible();
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'New card' });
  await dialog.getByLabel('Title').fill('Deep work');
  await dialog.getByLabel('Start').fill('23:00');
  await dialog.getByLabel('End').fill('23:30');
  await dialog.getByRole('checkbox', { name: 'Focus' }).click();
  await dialog.getByRole('button', { name: 'Create card' }).click();
  await expect(page.locator('[data-focus]').filter({ hasText: 'Deep work' })).toBeVisible();
});
