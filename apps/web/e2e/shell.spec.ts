import { expect, test } from '@playwright/test';

// U3 ground truth: open every route, toggle the theme, change a setting.

test.describe('shell', () => {
  test('opens on chat and opens each page from the settings button (orchestrator threads spec 30, 33)', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/chat$/);
    const main = page.getByRole('main');
    // Without a server the views say so instead of claiming to be empty (audit A-08).
    await expect(main.getByText('Not connected to the wow server', { exact: true })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Threads' });
    const routes = [
      ['Calendar', /\/calendar$/, 'Not connected to the wow server'],
      ['Backlog', /\/backlog$/, 'Not connected to the wow server'],
      ['Workflows', /\/workflows$/, 'Not connected to the wow server'],
      ['Settings', /\/settings\/providers$/, 'Test timeout'],
    ] as const;
    for (const [name, url, text] of routes) {
      await nav.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click();
      await expect(page).toHaveURL(url);
      await expect(main.getByText(text, { exact: true }).first()).toBeVisible();
      // Escape goes back to chat.
      await page.keyboard.press('Escape');
      await expect(page).toHaveURL(/\/chat$/);
    }
  });

  test('Filter threads from the palette opens the whole list with its field focused at 1024 px (spec 30)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/calendar');
    const nav = page.getByRole('navigation', { name: 'Threads' });
    await expect(nav).toHaveAttribute('data-rail', 'true');
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').getByRole('combobox').fill('Filter threads');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(nav.getByRole('searchbox', { name: 'Filter threads' })).toBeFocused();
    await expect(nav).not.toHaveAttribute('data-rail');
    await expect(page).toHaveURL(/\/calendar$/);
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
    await row.getByRole('button', { name: /^Toggle context panel:/ }).click();
    await page.keyboard.press('Control+Shift+Y');
    await expect(row.getByRole('button', { name: /^Toggle context panel:/ })).toHaveText(
      'Ctrl+Shift+Y',
    );

    const details = page.getByRole('complementary', { name: 'Context panel' });
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
