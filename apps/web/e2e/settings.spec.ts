import { settingsRegistry } from '@wow/contracts';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { e2eBinary, e2eClaudeConfigDir, e2eCodexHome, e2eSettingsHome as home } from './env';
import { choose } from './controls';

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

// An instance with stored secrets asks first, since they cannot be restored; one without is
// removed at once and offers Undo (owner decision F-9).
async function remove(row: Locator, { secrets = false } = {}) {
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  if (secrets) {
    await row.page().getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  }
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
    await expect(editor.getByLabel('Config folder')).toHaveValue(e2eClaudeConfigDir(home));
    await editor.getByRole('button', { name: 'Add variable' }).click();
    await editor.getByLabel('Variable 1 name').fill('ANTHROPIC_API_KEY');
    await editor.getByLabel('Variable 1 value').fill('sk-e2e-secret');
    await editor.getByRole('checkbox', { name: 'Variable 1 secret' }).check();
    await editor.getByLabel('Launch arguments').fill('--verbose');
    await expect(editor.getByLabel('Default model')).toHaveText("Claude's default");
    await choose(editor.getByLabel('Default permissions'), 'Accept edits');
    await editor.getByRole('button', { name: 'Add instance' }).click();
    await expect(editor).toBeHidden();

    // Saving tests the instance at once (audit E-03).
    const row = instances(page).getByRole('listitem', { name: 'Claude e2e' });
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
    // The editor lists the models the tested instance reports.
    await choose(edit.getByLabel('Default model'), /mock/i);
    await edit.getByLabel('Config folder').fill(`${e2eClaudeConfigDir(home)}-2`);
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(edit).toBeHidden();
    // A new config folder is a different setup: its old result is cleared and it is tested again.
    await expect(row.getByTestId('provider-status')).toHaveText('Ready');
    await expect(row.getByTestId('path-text').last()).toHaveText(`${e2eClaudeConfigDir(home)}-2`);

    await page.reload();
    await expect(
      instances(page).getByRole('listitem', { name: 'Claude e2e' }).getByTestId('provider-status'),
    ).toHaveText('Ready');
    await remove(instances(page).getByRole('listitem', { name: 'Claude e2e' }), { secrets: true });
  });

  test('adds and tests a Codex instance with CODEX_HOME', async ({ page }) => {
    await page.goto('/settings/providers');
    await instances(page).getByRole('button', { name: 'Add Codex' }).click();
    const editor = page.getByRole('dialog', { name: 'Add Codex instance' });
    await editor.getByLabel('Name').fill('Codex e2e');
    await editor.getByRole('button', { name: 'Detect' }).click();
    await expect(editor.getByLabel('Binary path')).toHaveValue(e2eBinary(home, 'codex'));
    await expect(editor.getByLabel('Config folder')).toHaveValue(e2eCodexHome(home));
    await choose(editor.getByLabel('Default permissions'), 'Read only');
    await editor.getByRole('button', { name: 'Add instance' }).click();

    const row = instances(page).getByRole('listitem', { name: 'Codex e2e' });
    await row.getByRole('button', { name: 'Test' }).click();
    await expect(row.getByTestId('provider-status')).toHaveText('Ready');
    await expect(row.getByTestId('path-text').last()).toHaveText(e2eCodexHome(home));
    await remove(row);
    // Removed at once, with Undo in a toast.
    await page.getByRole('button', { name: 'Undo' }).click();
    const back = instances(page).getByRole('listitem', { name: 'Codex e2e' });
    await expect(back).toBeVisible();
    await remove(back);
  });

  test('a different Codex version: compatible is Ready with a notice, incompatible offers the update', async ({
    page,
  }) => {
    await page.goto('/settings/providers');
    const add = async (name: string) => {
      await instances(page).getByRole('button', { name: 'Add Codex' }).click();
      const editor = page.getByRole('dialog', { name: 'Add Codex instance' });
      await editor.getByLabel('Name').fill(name);
      await editor.getByRole('button', { name: 'Add instance' }).click();
      await expect(editor).toBeHidden();
      return instances(page).getByRole('listitem', { name });
    };

    const differs = await add('Codex differs');
    await expect(differs.getByTestId('provider-status')).toHaveText('Ready');
    await expect(differs.getByTestId('provider-version')).toHaveText('0.164.0');
    await expect(differs.getByTestId('provider-notice')).toHaveText(
      'codex 0.164.0 differs from the tested 0.166.0; compatible.',
    );
    await expect(differs.getByRole('button', { name: /Update Codex/ })).toHaveCount(0);

    const old = await add('Codex incompatible');
    await expect(old.getByTestId('provider-status')).toHaveText('Error');
    await expect(old).toContainText('model/list result.data[].hidden is missing');
    await old.getByRole('button', { name: 'Update Codex to 0.166.0' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Update Codex to 0.166.0?' });
    await expect(confirm.getByTestId('provider-update-command')).toHaveText(
      'npm install -g @openai/codex@0.166.0',
    );
    // Cancel first: nothing runs.
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(old.getByTestId('provider-update-run')).toHaveCount(0);

    await old.getByRole('button', { name: 'Update Codex to 0.166.0' }).click();
    await confirm.getByRole('button', { name: 'Update' }).click();
    await expect(old.getByTestId('provider-update-run')).toHaveText(
      'Codex 0.166.0 installed. wow tested it again.',
    );
    await expect(old).toContainText('added 1 package in 1s (invented)');
    await expect(old.getByTestId('provider-status')).toHaveText('Ready');
    await expect(old.getByRole('button', { name: /Update Codex/ })).toHaveCount(0);

    await remove(differs);
    await remove(old);
  });

  test('the wizard creates the detected CLIs from the palette', async ({ page }) => {
    await page.goto('/calendar');
    await expect(page.getByRole('region', { name: 'Calendar' })).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').getByRole('combobox').fill('Detect installed providers');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/settings\/providers$/);

    const wizard = page.getByRole('dialog');
    await expect(wizard.getByRole('heading', { name: 'Set up providers' })).toBeVisible();
    const detected = wizard.getByRole('list', { name: 'Detected providers' });
    await expect(detected.getByTestId('path-text').first()).toHaveText(e2eBinary(home, 'claude'));
    await expect(detected).toContainText('Codex');
    // The primary action has focus, not "Not now" (audit A-11).
    await expect(wizard.getByRole('button', { name: 'Set up 2 providers' })).toBeFocused();
    await page.keyboard.press('Enter');

    const created = wizard.getByRole('list', { name: 'Created instances' });
    await expect(created.getByTestId('provider-status')).toHaveText(['Ready', 'Ready']);
    await wizard.getByRole('button', { name: 'Continue' }).click();
    // Then projects, imported from the folders the new instances worked in (owner decision F-10).
    await expect(wizard.getByRole('heading', { name: 'Add your projects' })).toBeVisible();
    await wizard
      .getByRole('button', { name: /^(Skip|Continue)$/ })
      .first()
      .click();
    await wizard.getByRole('button', { name: 'Close' }).click();

    for (const name of ['Claude', 'Codex']) {
      const row = instances(page).getByRole('listitem', { name, exact: true });
      await expect(row.getByTestId('provider-status')).toHaveText('Ready');
      await remove(row);
    }
  });

  test('renders every registry setting with its description and default', async ({ page }) => {
    test.slow();
    // Keys and raw defaults show only with "Show setting keys" (owner decision F-11).
    await page.goto('/settings/advanced');
    await page.getByLabel('Show setting keys').click();
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
    await page.goto('/settings/advanced');
    await page.getByLabel('Show setting keys').click();
  });

  test('a setting change applies at once and is stored on the server', async ({ page }) => {
    await page.goto('/settings/appearance');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-density', 'comfortable');
    await choose(page.getByLabel('Density'), 'Compact');
    await expect(html).toHaveAttribute('data-density', 'compact');

    await page.reload();
    await expect(html).toHaveAttribute('data-density', 'compact');
    await expect(page.getByLabel('Density')).toHaveText('Compact');

    await page.getByTestId('setting-appearance.density').getByText('Reset to default').click();
    await expect(html).toHaveAttribute('data-density', 'comfortable');
  });
});
