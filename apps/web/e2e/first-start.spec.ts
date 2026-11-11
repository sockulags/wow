import { expect, test, type Page } from '@playwright/test';
import { settingsRegistry } from '@wow/contracts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  e2eBinary,
  e2eFirstStartCodexError,
  e2eFirstStartHome as home,
  e2eFirstStartTrackerPort,
  e2eGitLabToken,
} from './env';
import { sketchPath, sketching, sketchUse } from './sketch';

// App assistant U6 against the first-start copy of the e2e server, which starts with no
// provider, project, workflow or tracker: the step "Connect an agent" in front of the app, the
// assistant's greeting once an agent passes its test, the step again in Assistant when the
// provider is removed, and a colleague's setup file walked through one thing at a time. The
// cases share the one server and its one assistant conversation, so they run in order.
test.describe.configure({ mode: 'serial' });

if (sketching) test.use(sketchUse);

const intent = '2026-11-app-assistant';
const greeting = settingsRegistry['assistant.greeting'].default;
const gitLabUrl = `http://127.0.0.1:${e2eFirstStartTrackerPort}/gitlab`;

test.beforeEach(async ({ page }) => {
  const info: unknown = JSON.parse(await readFile(path.join(home, 'server.json'), 'utf8'));
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

const step = (page: Page) => page.getByTestId('first-start');
const conversation = (page: Page) => page.getByRole('list', { name: 'Conversation' });
const composer = (page: Page) => page.getByRole('combobox', { name: 'Message' });
const lastAnswer = (page: Page) =>
  conversation(page).locator(':scope > li').last().and(page.getByTestId('item-assistant_text'));

async function say(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(conversation(page).getByTestId('item-user').filter({ hasText: text })).toBeVisible();
  await expect(lastAnswer(page)).toBeVisible();
}

// Settings → Providers: the instance of this kind, removed (none of them holds a secret).
async function removeInstance(page: Page, name: string): Promise<void> {
  await page.goto('/settings/providers');
  const row = page
    .getByRole('region', { name: 'Provider instances' })
    .getByRole('listitem', { name, exact: true });
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(row).toBeHidden();
}

// An invented colleague's file: a GitLab address, its token left to fill in.
const colleague = [
  '# From a colleague (invented)',
  'version: 1',
  'settings:',
  `  trackers.gitlab.baseUrl: ${gitLabUrl}`,
  'toFillIn:',
  '  - trackers.gitlab.token',
  '',
].join('\n');

test.describe('first start', () => {
  test('first start connects an agent and opens the assistant @app-assistant-25 @app-assistant-26', async ({
    page,
  }) => {
    await page.goto('/calendar');
    // Only the step: no sidebar, no view behind it.
    await expect(step(page).getByRole('heading', { name: 'Connect an agent' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Calendar' })).toHaveCount(0);
    const claude = step(page).getByRole('region', { name: 'Claude Code' });
    const codex = step(page).getByRole('region', { name: 'Codex' });
    await expect(claude.getByTestId('path-text')).toHaveText(e2eBinary(home, 'claude'));
    await expect(codex.getByTestId('path-text')).toHaveText(e2eBinary(home, 'codex'));
    await expect(step(page).getByRole('button', { name: 'Start from a setup file' })).toBeVisible();
    if (sketching) await page.screenshot({ path: sketchPath(intent, 'first-start') });

    // A test that fails says why in words, and the step stays.
    await codex.getByRole('button', { name: 'Test' }).click();
    await expect(codex.getByRole('alert')).toHaveText(e2eFirstStartCodexError);
    await expect(codex.getByTestId('provider-status')).toHaveText('Error');
    // The gate stays up in this window; after a reload an install with an instance is not gated
    // (an existing install is never locked out), and Assistant shows the same step.
    await expect(step(page).getByRole('heading', { name: 'Connect an agent' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(0);

    // One that passes opens the assistant, which greets with what is set up and what is missing.
    await claude.getByRole('button', { name: 'Test' }).click();
    await expect(page).toHaveURL(/\/assistant$/);
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
    await expect(conversation(page).getByTestId('item-user').first()).toContainText(greeting);
    const answer = lastAnswer(page);
    await expect(answer).toContainText('Providers: Claude (Claude)');
    await expect(answer).toContainText('Projects: none');
    await expect(answer).toContainText('A project: the folder a run works in');
    await expect(answer).toContainText('A workflow: start one from a template');
    // No setup file was applied, so there is nothing to walk through.
    await expect(answer).not.toContainText('fill in');
  });

  test('the assistant shows the step again when its provider is removed @app-assistant-27', async ({
    page,
  }) => {
    await removeInstance(page, 'Claude');
    await page.goto('/assistant');
    await expect(page.getByTestId('assistant-problem')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Connect an agent' })).toBeVisible();
    // The rest of the app stays usable.
    await page.goto('/calendar');
    await expect(page.getByRole('region', { name: 'Calendar' })).toBeVisible();
    await expect(step(page)).toHaveCount(0);
  });

  test('a colleague starts from a setup file @app-assistant-22 @app-assistant-24', async ({
    page,
  }) => {
    // As on a new machine: with the setting back on and no provider instance at all (the Codex
    // one the first case made goes too), the step is all there is again, at once and after a
    // reload.
    await removeInstance(page, 'Codex');
    await page.getByRole('switch', { name: 'Offer setup at start' }).click();
    await expect(step(page).getByRole('heading', { name: 'Connect an agent' })).toBeVisible();
    await page.reload();
    await expect(step(page).getByRole('heading', { name: 'Connect an agent' })).toBeVisible();

    await step(page)
      .getByLabel('Setup file to start from')
      .setInputFiles({
        name: 'colleague.yaml',
        mimeType: 'application/yaml',
        buffer: Buffer.from(colleague),
      });
    const preview = page.getByRole('dialog', { name: 'Start from colleague.yaml' });
    await expect(preview.getByRole('region', { name: 'Added' })).toContainText('GitLab URL');
    await expect(preview.getByRole('region', { name: 'To fill in' })).toContainText('GitLab token');
    await preview.getByRole('button', { name: 'Apply' }).click();
    await expect(preview).toBeHidden();
    await expect(step(page).getByTestId('connect-applied')).toContainText('colleague.yaml');

    await step(page)
      .getByRole('region', { name: 'Claude Code' })
      .getByRole('button', { name: 'Test' })
      .click();
    await expect(page).toHaveURL(/\/assistant$/);
    const answer = lastAnswer(page);
    await expect(answer).toContainText(`Trackers: GitLab URL ${gitLabUrl}, token not set`);
    // One thing at a time: first the token, through its field.
    await expect(answer).toContainText('Next: GitLab token.');
    await expect(answer).not.toContainText('work hours');
    const card = page.getByRole('region', { name: 'Secret field: GitLab token' });
    await expect(card).toBeVisible();
    await card.getByLabel('GitLab token').fill(e2eGitLabToken);
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByTestId('assistant-secret-state')).toHaveText('Set');
    await card.getByRole('button', { name: 'Test connection' }).click();
    await expect(card.getByTestId('tracker-gitlab-status')).toContainText('mira');

    // Then what only this person can say: work hours, then project folders.
    await say(page, 'Done');
    await expect(lastAnswer(page)).toContainText('Next: your work hours.');
    await say(page, 'My work hours are 08:00 to 16:00');
    await expect(page.getByRole('region', { name: 'Change: Work hours' })).toBeVisible();
    await expect(lastAnswer(page)).toContainText('Next: Project folders.');
    await say(page, 'Skip that for now');
    await expect(lastAnswer(page)).toContainText(
      'That is everything the setup file left to fill in.',
    );
    await expect(conversation(page)).not.toContainText(e2eGitLabToken);
  });
});
