import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { e2eProjectsHome as home } from './env';
import { sketchPath, sketching, sketchUse } from './sketch';

// The setup file (app assistant plan U5, spec 21 to 23) against the projects copy of the e2e
// server: its seeded Jira email and tokens must stay out of a saved file, and what a colleague's
// file adds is taken back with Undo, so the copy ends as it started.

const intent = '2026-11-app-assistant';

test.describe.configure({ mode: 'serial' });

if (sketching) test.use(sketchUse);

test.beforeEach(async ({ page }) => {
  const info: unknown = JSON.parse(await readFile(path.join(home, 'server.json'), 'utf8'));
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

// An invented colleague's file, written on Windows.
const colleague = [
  '# From a colleague (invented)',
  'version: 1',
  'wow: 0.1.2',
  'settings:',
  '  hosts.pollSeconds: 900',
  '  diff.maxFiles: 500',
  '  trackers.jira.projectKey: TEA',
  'toFillIn:',
  '  - trackers.gitlab.token',
  'workflows:',
  '  - id: kettle-check',
  '    name: Kettle check',
  '    steps:',
  '      - id: check',
  '        skillName: kettle-check',
  '        provider: claude',
  '        gateBefore: false',
  '        gateAfter: true',
  '        expectedArtifacts: []',
  '',
].join('\r\n');

const upload = (page: Page, name: string, text: string) =>
  page
    .getByLabel('Setup file to start from')
    .setInputFiles({ name, mimeType: 'application/yaml', buffer: Buffer.from(text) });

test.describe('setup file', () => {
  test('save a setup and start from it @app-assistant-21 @app-assistant-22', async ({ page }) => {
    await page.goto('/settings/advanced');
    const section = page.getByRole('region', { name: 'Setup file' });

    const saving = page.waitForEvent('download');
    await section.getByRole('button', { name: 'Save setup to a file' }).click();
    const download = await saving;
    expect(download.suggestedFilename()).toMatch(/^wow-setup-\d{4}-\d{2}-\d{2}\.yaml$/);
    const saved = await readFile(await download.path(), 'utf8');
    expect(saved).toContain('version: 1');
    expect(saved).toMatch(/toFillIn:\n(?: {2}- .+\n)*? {2}- trackers\.jira\.token\n/);
    // No secret value, account name or project folder of this install is in it.
    for (const kept of ['jira-e2e-token', 'confluence-e2e-token', 'me@example.invalid', home]) {
      expect(saved).not.toContain(kept);
    }

    // Read back where it was saved, it changes nothing.
    await upload(page, download.suggestedFilename(), saved);
    const same = page.getByRole('dialog', { name: `Start from ${download.suggestedFilename()}` });
    await expect(same).toContainText('Nothing would change');
    await expect(same.getByRole('button', { name: 'Apply' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(same).toBeHidden();

    await upload(page, 'colleague.yaml', colleague);
    const dialog = page.getByRole('dialog', { name: 'Start from colleague.yaml' });
    const added = dialog.getByRole('region', { name: 'Added' });
    await expect(added.getByTestId('setup-line')).toHaveText([
      'Interval (Hosts): 60 (default) → 900',
      'Most files listed (Changes): 2000 (default) → 500',
      'Workflow "Kettle check": new: 1 step: kettle-check',
    ]);
    await expect(
      dialog.getByRole('region', { name: 'Replaced' }).getByTestId('setup-line'),
    ).toHaveText(['Jira project key (Trackers): DEMO → TEA']);
    await expect(dialog.getByTestId('setup-mark')).toHaveText(
      'Workflow "Kettle check": skill not installed: kettle-check',
    );
    await expect(dialog.getByTestId('setup-fill-in')).toContainText('GitLab token');
    if (sketching) await page.screenshot({ path: sketchPath(intent, 'setup-preview') });

    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog).toBeHidden();
    const row = section.getByTestId('setup-application').first();
    await expect(row).toContainText('colleague.yaml · 3 added, 1 replaced');
    await page.goto('/settings/hosts');
    await expect(page.getByLabel('Interval', { exact: true })).toHaveValue('900');
    await page.goto('/workflows');
    await expect(page.getByText('Kettle check')).toBeVisible();

    // One Undo takes the whole file back.
    await page.goto('/settings/advanced');
    await row.getByRole('button', { name: 'Undo' }).click();
    await expect(row).toHaveAttribute('data-state', 'undone');
    await expect(row).toContainText('Undone');
    await page.goto('/settings/hosts');
    await expect(page.getByLabel('Interval', { exact: true })).toHaveValue('60');
    await page.goto('/workflows');
    await expect(page.getByText('Kettle check')).toHaveCount(0);
  });

  test('a setup file that is wrong is refused with the line and the reason @app-assistant-23', async ({
    page,
  }) => {
    await page.goto('/settings/advanced');
    await upload(
      page,
      'wrong.yaml',
      ['version: 1', 'settings:', '  scheduler.speed: 3', '  hosts.pollSeconds: soon', ''].join(
        '\n',
      ),
    );
    const dialog = page.getByRole('dialog', { name: 'Start from wrong.yaml' });
    await expect(dialog.getByTestId('setup-problem')).toHaveText([
      'Line 3: Unknown setting scheduler.speed',
      'Line 4: Setting hosts.pollSeconds: Invalid input: expected number, received string',
    ]);
    await expect(dialog.getByRole('button', { name: 'Apply' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await upload(page, 'newer.yaml', 'version: 2\nwow: 0.9.0\n');
    await expect(page.getByRole('dialog', { name: 'Start from newer.yaml' })).toContainText(
      'Line 1: This setup file is version 2 and needs wow 0.9.0 or newer',
    );
  });
});
