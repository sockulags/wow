import { settingsRegistry } from '@wow/contracts';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { e2eBinary, e2eClaudeConfigDir, e2eCodexHome, e2eSettingsHome as home } from './env';

// U13 ground truth against the e2e server (mock providers, stand-in CLIs on its PATH): provider
// instances are added, tested, edited and removed (spec 31, 32), the first-run wizard creates the
// detected CLIs, and every registry setting renders and applies without a restart (spec 33).

test.beforeEach(async ({ page }) => {
  // What the desktop preload injects: the contents of `~/.wow/server.json`.
  const info: unknown = JSON.parse(await readFile(path.join(home, 'server.json'), 'utf8'));
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

const instances = (page: Page) => page.getByRole('region', { name: 'Provider instances' });

async function remove(row: Locator, name: string) {
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  await row.getByRole('button', { name: `Remove ${name}` }).click();
  await expect(row).toBeHidden();
}

test.describe('settings', () => {
  test('adds, tests, edits and removes a Claude instance', async ({ page }) => {
    await page.goto('/settings/providers');
    await instances(page).getByRole('button', { name: 'Add Claude' }).click();
    const editor = page.getByRole('dialog', { name: 'Add Claude instance' });
    await editor.getByLabel('Name').fill('Claude e2e');
    await editor.getByRole('button', { name: 'Detect' }).click();
    await expect(editor.getByLabel('Binary path')).toHaveValue(e2eBinary(home, 'claude'));
    await expect(editor.getByLabel('Config directory (CLAUDE_CONFIG_DIR)')).toHaveValue(
      e2eClaudeConfigDir(home),
    );
    await editor.getByRole('button', { name: 'Add variable' }).click();
    await editor.getByLabel('Variable 1 name').fill('ANTHROPIC_API_KEY');
    await editor.getByLabel('Variable 1 value').fill('sk-e2e-secret');
    await editor.getByRole('checkbox', { name: 'Variable 1 secret' }).check();
    await editor.getByLabel('Launch arguments').fill('--verbose');
    await editor.getByLabel('Default model').fill('mock-model');
    await editor.getByLabel('Default effort').fill('high');
    await editor.getByLabel('Default permission mode').selectOption('acceptEdits');
    await editor.getByRole('button', { name: 'Add instance' }).click();
    await expect(editor).toBeHidden();

    const row = instances(page).getByRole('listitem', { name: 'Claude e2e' });
    await expect(row.getByTestId('provider-status')).toHaveText('Not tested');
    await row.getByRole('button', { name: 'Test' }).click();
    await expect(row.getByTestId('provider-status')).toHaveText('Ready');
    await expect(row.getByTestId('provider-account')).toHaveText('mock');
    await expect(row.getByTestId('provider-version')).toHaveText('mock');

    // The secret is in the secret store, and only its reference is on the instance.
    const secrets = await readFile(path.join(home, 'secrets.json'), 'utf8');
    expect(secrets).toMatch(/provider:claude-[0-9a-f]{8}:env:ANTHROPIC_API_KEY/);

    await row.getByRole('button', { name: 'Edit' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit Claude e2e' });
    await expect(edit.getByLabel('Variable 1 value')).toHaveValue('');
    await expect(edit.getByLabel('Variable 1 value')).toHaveAttribute(
      'placeholder',
      'Stored. Type to replace.',
    );
    await expect(edit.getByLabel('Launch arguments')).toHaveValue('--verbose');
    await edit
      .getByLabel('Config directory (CLAUDE_CONFIG_DIR)')
      .fill(`${e2eClaudeConfigDir(home)}-2`);
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(edit).toBeHidden();
    // A new config directory is a different setup; its last test no longer applies.
    await expect(row.getByTestId('provider-status')).toHaveText('Not tested');
    await expect(row).toContainText(`${e2eClaudeConfigDir(home)}-2`);

    await page.reload();
    await expect(
      instances(page).getByRole('listitem', { name: 'Claude e2e' }).getByTestId('provider-status'),
    ).toHaveText('Not tested');
    await remove(instances(page).getByRole('listitem', { name: 'Claude e2e' }), 'Claude e2e');
  });

  test('adds and tests a Codex instance with CODEX_HOME', async ({ page }) => {
    await page.goto('/settings/providers');
    await instances(page).getByRole('button', { name: 'Add Codex' }).click();
    const editor = page.getByRole('dialog', { name: 'Add Codex instance' });
    await editor.getByLabel('Name').fill('Codex e2e');
    await editor.getByRole('button', { name: 'Detect' }).click();
    await expect(editor.getByLabel('Binary path')).toHaveValue(e2eBinary(home, 'codex'));
    await expect(editor.getByLabel('Config directory (CODEX_HOME)')).toHaveValue(
      e2eCodexHome(home),
    );
    await editor.getByLabel('Default permission mode').selectOption('read-only');
    await editor.getByRole('button', { name: 'Add instance' }).click();

    const row = instances(page).getByRole('listitem', { name: 'Codex e2e' });
    await row.getByRole('button', { name: 'Test' }).click();
    await expect(row.getByTestId('provider-status')).toHaveText('Ready');
    await expect(row).toContainText(e2eCodexHome(home));
    await remove(row, 'Codex e2e');
  });

  test('the wizard creates the detected CLIs from the palette', async ({ page }) => {
    await page.goto('/calendar');
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').getByRole('combobox').fill('Detect installed providers');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/settings\/providers$/);

    const wizard = page.getByRole('dialog', { name: 'Set up providers' });
    const detected = wizard.getByRole('list', { name: 'Detected providers' });
    await expect(detected).toContainText(e2eBinary(home, 'claude'));
    await expect(detected).toContainText(e2eBinary(home, 'codex'));
    await wizard.getByRole('button', { name: 'Create and test' }).click();

    const created = wizard.getByRole('list', { name: 'Created instances' });
    await expect(created.getByTestId('provider-status')).toHaveText(['Ready', 'Ready']);
    await wizard.getByRole('button', { name: 'Done' }).click();

    for (const name of ['Claude', 'Codex']) {
      const row = instances(page).getByRole('listitem', { name, exact: true });
      await expect(row.getByTestId('provider-status')).toHaveText('Ready');
      await remove(row, name);
    }
  });

  test('renders every registry setting with its description and default', async ({ page }) => {
    const groups = new Set(Object.values(settingsRegistry).map((entry) => entry.group));
    for (const group of groups) {
      await page.goto(`/settings/${group}`);
      for (const [key, definition] of Object.entries(settingsRegistry)) {
        if (definition.group !== group) continue;
        const row = page.getByTestId(`setting-${key}`);
        await expect(row).toContainText(definition.label);
        await expect(row).toContainText(definition.description);
        await expect(row).toContainText(`${key} · default`);
      }
    }
  });

  test('a setting change applies at once and is stored on the server', async ({ page }) => {
    await page.goto('/settings/appearance');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-density', 'comfortable');
    await page.getByLabel('Density').selectOption('compact');
    await expect(html).toHaveAttribute('data-density', 'compact');

    await page.reload();
    await expect(html).toHaveAttribute('data-density', 'compact');
    await expect(page.getByLabel('Density')).toHaveValue('compact');

    await page.getByTestId('setting-appearance.density').getByText('Reset to default').click();
    await expect(html).toHaveAttribute('data-density', 'comfortable');
  });
});
