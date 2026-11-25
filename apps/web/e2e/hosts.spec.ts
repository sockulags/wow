import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { e2eChangesHome, e2eChangesTrackerPort } from './env';
import { choose } from './controls';
import { sketchPath, sketching, sketchUse } from './sketch';

// U6 ground truth (review loop spec 23, 26, 28, 30, 31) against the Changes copy of the e2e
// server: project `tea-garden` is on a branch with an invented pull request, has a plan whose
// units have pull requests on the mock GitHub, and is the only project with a GitHub token.
// The tests share that server, so they run in order.
test.describe.configure({ mode: 'serial' });

const control = `http://127.0.0.1:${e2eChangesTrackerPort}`;

test.beforeEach(async ({ page }) => {
  // What the desktop preload injects: the contents of `~/.wow/server.json`.
  const info: unknown = JSON.parse(
    await readFile(path.join(e2eChangesHome, 'server.json'), 'utf8'),
  );
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

test.afterEach(async () => {
  await fetch(`${control}/github-host/failure`, { method: 'DELETE' });
});

const asked = async (): Promise<string[]> => {
  const response = await fetch(`${control}/github-host/requests`);
  return ((await response.json()) as { path: string }[]).map((request) => request.path);
};

test.describe('hosts', () => {});

const jiraAsked = async (): Promise<string[]> => {
  const response = await fetch(`${control}/jira-host/requests`);
  return ((await response.json()) as { path: string }[]).map((request) => request.path);
};

const panel = (page: Page) => page.getByRole('complementary', { name: 'Context panel' });

// A chat in the tea garden project whose answer links to the work on its hosts.
async function startLinkThread(page: Page) {
  await page.goto('/chat/new');
  await choose(page.getByRole('combobox', { name: 'Project' }), 'Tea garden');
  const composer = page.getByRole('combobox', { name: 'Message' });
  await composer.fill('link the work');
  await composer.press('Enter');
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  const conversation = page.getByRole('list', { name: 'Conversation' });
  await expect(conversation).toContainText('The work is in');
  return conversation;
}

test.describe('host links in chat', () => {
  test('opens a pull request and a Jira issue from a chat link @agent-workbench-19 @agent-workbench-20 @agent-workbench-21 @agent-workbench-22 @agent-workbench-23 @agent-workbench-24 @agent-workbench-25', async ({
    page,
  }) => {
    // Seven reads of four hosts, each with a token from the secret store: on Windows they use
    // most of the default time for one test.
    test.slow();
    const conversation = await startLinkThread(page);
    const chips = conversation.getByTestId('host-chip');
    // A pull request link, a Jira link and a bare key of the project are chips; a link to a
    // host without a token stays a link (spec 20, 23, 24).
    await expect(chips).toHaveText(['PR #14', 'DEMO-41', 'DEMO-42']);
    await expect(conversation.getByRole('link', { name: 'elsewhere' })).toHaveAttribute(
      'href',
      'https://elsewhere.example.invalid/acme/tea/pull/3',
    );

    // Enter opens the pull request in a panel tab, read once (spec 21, 22).
    const before = (await asked()).length;
    await chips.first().focus();
    await page.keyboard.press('Enter');
    const tab = panel(page).getByTestId('host-tab');
    await expect(tab.getByTestId('host-tab-title')).toHaveText('PR #14 · Draft · 2 checks failed');
    await expect(tab.getByTestId('failing-check')).toHaveText([
      'test (windows-latest)',
      'deploy/preview',
    ]);
    await expect(tab.getByTestId('review-comment')).toHaveCount(2);
    await expect(tab.getByTestId('host-fetched')).toHaveText(
      /^Last fetched .* from 127\.0\.0\.1:\d+$/,
    );
    await expect(tab.getByRole('button', { name: 'Refresh now' })).toBeVisible();
    await expect(tab.getByRole('link', { name: 'Open on host' })).toHaveAttribute(
      'href',
      `${control}/web/acme/tea-garden/pull/14`,
    );
    await expect(chips.first()).toHaveText('PR #14 · Draft · 2 checks failed');
    const once = (await asked()).length;
    expect(once).toBeGreaterThan(before);
    const fetched = await tab.getByTestId('host-fetched').textContent();

    // After a reload the chip and the tab show the stored read; the host is not asked again.
    await page.reload();
    await expect(chips.first()).toHaveText('PR #14 · Draft · 2 checks failed');
    await chips.first().click();
    await expect(tab.getByTestId('host-fetched')).toHaveText(fetched ?? '');
    expect((await asked()).length).toBe(once);
    // Refresh now asks again; a refused or failed read shows the host's reason and keeps the
    // last data (spec 23).
    await fetch(`${control}/github-host/failure?status=503`, { method: 'PUT' });
    await tab.getByRole('button', { name: 'Refresh now' }).click();
    await expect(tab.getByTestId('host-error')).toContainText('answered 503');
    await expect(tab.getByTestId('host-tab-title')).toHaveText('PR #14 · Draft · 2 checks failed');
    expect((await asked()).length).toBeGreaterThan(once);
    await fetch(`${control}/github-host/failure`, { method: 'DELETE' });

    // The Jira link opens its ticket; Shift+Enter opens the browser instead (spec 21).
    const jiraBefore = (await jiraAsked()).length;
    await chips.nth(1).focus();
    await page.keyboard.press('Enter');
    await expect(tab.getByTestId('host-tab-title')).toHaveText('DEMO-41 · In Progress');
    await expect(tab.getByTestId('ticket-description')).toContainText('The beds dry out by');
    expect((await jiraAsked()).length).toBeGreaterThan(jiraBefore);
    await expect(chips.nth(1)).toHaveText('DEMO-41 · In Progress');
    const popup = page.waitForEvent('popup');
    await chips.nth(1).focus();
    await page.keyboard.press('Shift+Enter');
    const opened = await popup;
    expect(opened.url()).toBe(`${control}/jira/browse/DEMO-41`);
    await opened.close();

    // A link pasted into the composer shows its chip with "Open in panel" (spec 25).
    const composer = page.getByRole('combobox', { name: 'Message' });
    await composer.fill(`Look at ${control}/github/acme/tea-garden/pull/12 first`);
    const pasted = page.getByTestId('pasted-link');
    await expect(pasted.getByTestId('host-chip')).toHaveText('PR #12');
    await pasted.getByRole('button', { name: 'Open in panel' }).click();
    await expect(tab.getByTestId('host-tab-title')).toHaveText('PR #12 · Merged · checks passed');
    await composer.fill('');

    // The palette takes a key (spec 25).
    await conversation.click();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await palette.getByRole('combobox').fill('Open issue, PR or ticket');
    await palette.getByRole('option', { name: /Open issue, PR or ticket/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Open issue, PR or ticket' });
    await dialog
      .getByLabel('Address or key')
      .fill('https://elsewhere.example.invalid/acme/tea/pull/3');
    await expect(dialog.getByRole('button', { name: 'Open in panel' })).toBeDisabled();
    await dialog.getByLabel('Address or key').fill('DEMO-42');
    await dialog.getByRole('button', { name: 'Open in panel' }).click();
    await expect(tab.getByTestId('host-tab-title')).toHaveText('DEMO-42 · To Do');

    // Details lists what the thread mentions (spec 19).
    await panel(page).getByRole('tab', { name: 'Details' }).click();
    await expect(panel(page).getByTestId('mentioned-link')).toHaveText([
      'PR #14 · Draft · 2 checks failed',
      'DEMO-41 · In Progress',
      'DEMO-42 · To Do',
    ]);
  });
});

test.describe('sketch', () => {
  test.skip(!sketching, 'Set WOW_E2E_SKETCHES to write the screenshots');
  test.use(sketchUse);

  test('host chip', async ({ page }) => {
    const conversation = await startLinkThread(page);
    await conversation.getByTestId('host-chip').first().click();
    const tab = panel(page).getByTestId('host-tab');
    await expect(tab.getByTestId('review-comment')).toHaveCount(2);
    await expect(conversation.getByTestId('host-chip').first()).toHaveText(
      'PR #14 · Draft · 2 checks failed',
    );
    await page.screenshot({ path: sketchPath('2026-11-agent-workbench', 'host-chip') });
  });
});
