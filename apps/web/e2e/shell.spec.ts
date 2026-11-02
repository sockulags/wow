import { expect, test } from '@playwright/test';

// U3 ground truth: open every route, toggle the theme, change a setting.

test.describe('shell', () => {
  test('opens every route from the sidebar', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/calendar$/);
    const nav = page.getByRole('navigation', { name: 'Sections' });
    const routes = [
      ['Calendar', /\/calendar$/, 'No calendar items yet'],
      ['Chat', /\/chat$/, 'No threads yet'],
      ['Workflows', /\/workflows$/, 'No workflows yet'],
      ['Backlog', /\/backlog$/, 'Backlog is empty'],
      ['Settings', /\/settings\/providers$/, 'Test timeout'],
    ] as const;
    for (const [name, url, text] of routes) {
      await nav.getByRole('link', { name }).click();
      await expect(page).toHaveURL(url);
      await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
    }
  });

  test('toggles the theme from the palette and the settings page', async ({ page }) => {
    await page.goto('/calendar');
    const html = page.locator('html');
    await expect(html).toHaveClass(/dark/);

    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await palette.getByRole('combobox').fill('toggle theme');
    await page.keyboard.press('Enter');
    await expect(html).not.toHaveClass(/dark/);

    await page.goto('/settings/appearance');
    await expect(html).toHaveClass(/dark/);
    await page.getByRole('radio', { name: 'Light' }).click();
    await expect(html).not.toHaveClass(/dark/);
  });

  test('changes a setting and its keybinding takes effect', async ({ page }) => {
    await page.goto('/settings/keybindings');
    const row = page.getByTestId('setting-keybindings.toggleRightPanel');
    await row.getByRole('button', { name: /^Toggle right panel:/ }).click();
    await page.keyboard.press('Control+Shift+Y');
    await expect(row.getByRole('button', { name: /^Toggle right panel:/ })).toHaveText(
      'Ctrl+Shift+Y',
    );

    const details = page.getByRole('complementary', { name: 'Details' });
    await page.keyboard.press('Control+j');
    await expect(details).toBeHidden();
    await page.keyboard.press('Control+Shift+Y');
    await expect(details).toBeVisible();
  });

  test('rejects an invalid value and keeps the old one', async ({ page }) => {
    await page.goto('/settings/calendar');
    const lookahead = page.getByLabel('Lookahead');
    await lookahead.fill('500');
    await expect(
      page.getByTestId('setting-calendar.lookaheadDays').getByRole('alert'),
    ).toBeVisible();
    await lookahead.fill('21');
    await expect(
      page.getByTestId('setting-calendar.lookaheadDays').getByRole('alert'),
    ).toBeHidden();
    await expect(
      page.getByTestId('setting-calendar.lookaheadDays').getByText('Reset to default'),
    ).toBeVisible();
  });
});
