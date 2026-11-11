import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { e2eProjectsHome as home, e2eWorkflowId, e2eWorkspace } from './env';
import { withOptions } from './controls';

// Settings → Projects against its own copy of the e2e server: a project is created with a folder
// that exists, every picker offers it, a rename reaches the pickers, and removing it takes it out
// of them. The import reads invented Claude and Codex session files seeded in the server's home
// (e2e/server.ts), and the desktop folder dialog is stood in for by the preload's bridge.

test.beforeEach(async ({ page }) => {
  const info: unknown = JSON.parse(await readFile(path.join(home, 'server.json'), 'utf8'));
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

const projectList = (page: Page) => page.getByRole('region', { name: 'Projects' });

async function expectInPickers(page: Page, name: string, present: boolean) {
  await page.goto('/chat/new');
  const check = async (options: Locator) => {
    await expect(options.filter({ hasText: /^Demo$/ })).toHaveCount(1);
    await expect(options.getByText(name, { exact: true })).toHaveCount(present ? 1 : 0);
  };
  await withOptions(page.getByLabel('Project', { exact: true }), check);
  await page.goto(`/workflows/${e2eWorkflowId}`);
  await withOptions(page.getByLabel('Run in project'), check);
}

test.describe('projects', () => {
  test('creates a project, offers it in the pickers, renames and removes it', async ({ page }) => {
    // Six page loads through the pickers; under two workers it runs close to the default limit.
    test.slow();
    const folder = path.join(home, 'projects-e2e-site');
    await mkdir(folder, { recursive: true });

    await page.goto('/settings/projects');
    await expect(projectList(page).getByRole('listitem', { name: 'Demo' })).toBeVisible();
    await projectList(page).getByRole('button', { name: 'Add project' }).click();
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

    // Rename from the palette, once the page has loaded and a key reaches the app.
    await page.goto('/settings/projects');
    await expect(projectList(page).getByRole('listitem', { name: 'Site e2e' })).toBeVisible();
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
    const remove = page.getByRole('alertdialog', { name: 'Remove Site renamed?' });
    await remove.getByRole('button', { name: 'Remove' }).click();
    await expect(remove).toBeHidden();
    await expect(projectList(page).getByRole('listitem', { name: 'Site renamed' })).toBeHidden();

    await expectInPickers(page, 'Site renamed', false);
  });
});

test.describe('choosing and importing folders', () => {
  test('the desktop folder dialog fills the folder', async ({ page }) => {
    const folder = path.join(home, 'projects-e2e-picked');
    await mkdir(folder, { recursive: true });
    // What the desktop preload exposes; the system dialog answers with the chosen folder.
    await page.addInitScript((picked) => {
      (globalThis as { wowDesktop?: unknown }).wowDesktop = {
        pickFolder: () => Promise.resolve(picked),
      };
    }, folder);
    await page.goto('/settings/projects');
    await projectList(page).getByRole('button', { name: 'Add project' }).click();
    const create = page.getByRole('dialog', { name: 'New project' });
    await create.getByLabel('Name').fill('Picked e2e');
    await expect(create.getByLabel('Folder')).toHaveAttribute('readonly', '');
    await create.getByRole('button', { name: 'Choose folder…' }).click();
    await expect(create.getByLabel('Folder')).toHaveValue(folder);
    await create.getByRole('button', { name: 'Add project' }).click();
    await expect(create).toBeHidden();
    await expect(projectList(page).getByRole('listitem', { name: 'Picked e2e' })).toContainText(
      folder,
    );
  });

  test('imports the folders Claude and Codex worked in', async ({ page }) => {
    await page.goto('/settings/projects');
    await expect(projectList(page).getByRole('listitem', { name: 'Demo' })).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').fill('Import projects from Claude and Codex');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Import from Claude and Codex' });
    const list = dialog.getByRole('list', { name: 'Folders to import' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    const alpha = list.getByRole('listitem').filter({ hasText: e2eWorkspace(home, 'alpha') });
    await expect(alpha).toContainText('Claude, Codex');
    const beta = list.getByRole('listitem').filter({ hasText: e2eWorkspace(home, 'beta') });
    await expect(beta).not.toContainText('Claude');
    await expect(list).not.toContainText(e2eWorkspace(home, 'gone'));

    await beta.getByRole('checkbox').click();
    await expect(dialog).toContainText('1 of 2 selected');
    await dialog.getByRole('button', { name: 'Import 1 project' }).click();
    await expect(dialog).toBeHidden();
    await expect(projectList(page).getByRole('listitem', { name: 'alpha' })).toContainText(
      e2eWorkspace(home, 'alpha'),
    );
    await expectInPickers(page, 'alpha', true);

    // An imported folder is a project now, so the next import offers only the rest.
    await page.goto('/settings/projects');
    await projectList(page).getByRole('button', { name: 'Import from Claude and Codex' }).click();
    await expect(
      page
        .getByRole('dialog', { name: 'Import from Claude and Codex' })
        .getByRole('list', { name: 'Folders to import' })
        .getByRole('listitem'),
    ).toHaveCount(1);
  });
});
