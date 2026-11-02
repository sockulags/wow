import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { e2eSettingsHome as home, e2eWorkflowId } from './env';

// Settings → Projects against the settings copy of the e2e server, which no other spec adds
// projects to: a project is created with a folder that exists, every picker offers it, a rename
// reaches the pickers, and removing it takes it out of them.

test.beforeEach(async ({ page }) => {
  const info: unknown = JSON.parse(await readFile(path.join(home, 'server.json'), 'utf8'));
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

const projectList = (page: Page) => page.getByRole('region', { name: 'Projects' });

async function expectInPickers(page: Page, name: string, present: boolean) {
  await page.goto('/chat/new');
  const chatPicker = page.getByLabel('Project', { exact: true });
  await expect(chatPicker.getByRole('option', { name: 'Demo' })).toHaveCount(1);
  await expect(chatPicker.getByRole('option', { name, exact: true })).toHaveCount(present ? 1 : 0);
  await page.goto(`/workflows/${e2eWorkflowId}`);
  const runPicker = page.getByLabel('Run in project');
  await expect(runPicker.getByRole('option', { name: 'Demo' })).toHaveCount(1);
  await expect(runPicker.getByRole('option', { name, exact: true })).toHaveCount(present ? 1 : 0);
}

test.describe('projects', () => {
  test('creates a project, offers it in the pickers, renames and removes it', async ({ page }) => {
    const folder = path.join(home, 'projects-e2e-site');
    await mkdir(folder, { recursive: true });

    await page.goto('/settings/projects');
    await expect(projectList(page).getByRole('listitem', { name: 'Demo' })).toBeVisible();
    await projectList(page).getByRole('button', { name: 'New project' }).click();
    const create = page.getByRole('dialog', { name: 'New project' });
    await create.getByLabel('Name').fill('Site e2e');
    await create.getByLabel('Folder').fill(path.join(home, 'projects-e2e-missing'));
    await create.getByRole('button', { name: 'Add project' }).click();
    await expect(create.getByRole('alert')).toHaveText(
      `No folder ${path.join(home, 'projects-e2e-missing')}`,
    );
    await create.getByLabel('Folder').fill(folder);
    await create.getByRole('button', { name: 'Add project' }).click();
    await expect(create).toBeHidden();
    const row = projectList(page).getByRole('listitem', { name: 'Site e2e' });
    await expect(row).toContainText(folder);

    await expectInPickers(page, 'Site e2e', true);

    // Rename from the palette.
    await page.goto('/settings/projects');
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').fill('Rename project Site e2e');
    await page.keyboard.press('Enter');
    const rename = page.getByRole('dialog', { name: 'Rename Site e2e' });
    await rename.getByLabel('Name').fill('Site renamed');
    await rename.getByRole('button', { name: 'Save' }).click();
    await expect(rename).toBeHidden();
    await expect(projectList(page).getByRole('listitem', { name: 'Site renamed' })).toBeVisible();

    await expectInPickers(page, 'Site renamed', true);

    await page.goto('/settings/projects');
    await projectList(page)
      .getByRole('listitem', { name: 'Site renamed' })
      .getByRole('button', { name: 'Remove' })
      .click();
    const remove = page.getByRole('dialog', { name: 'Remove Site renamed?' });
    await remove.getByRole('button', { name: 'Remove project' }).click();
    await expect(remove).toBeHidden();
    await expect(projectList(page).getByRole('listitem', { name: 'Site renamed' })).toBeHidden();

    await expectInPickers(page, 'Site renamed', false);
  });
});
