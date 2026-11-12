import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  e2eChangesHome,
  e2eChangesTrackerPort,
  e2eHostBranch,
  e2eHostIntentId,
  e2eHostProjectId,
  e2eHostWorkflowId,
} from './env';
import { choose } from './controls';
import { sketchPath, sketching, sketchUse } from './sketch';

// U6 ground truth (review loop spec 23, 26, 28, 30, 31) against the Changes copy of the e2e
// server: project `tea-garden` is on a branch with an invented pull request, has a plan whose
// units have pull requests on the mock GitHub, and is the only project with a GitHub token.
// The first test follows the plan and the tests share that server, so they run in order.
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

async function startRun(runId: string): Promise<void> {
  const query = new URLSearchParams({
    workflowId: e2eHostWorkflowId,
    projectId: e2eHostProjectId,
    runId,
  });
  const response = await fetch(`${control}/run?${query}`, { method: 'POST' });
  expect(response.ok).toBe(true);
}

const asked = async (): Promise<string[]> => {
  const response = await fetch(`${control}/github-host/requests`);
  return ((await response.json()) as { path: string }[]).map((request) => request.path);
};

const unit = (page: Page, key: string) => page.getByTestId(`unit-${key}`);
const status = (page: Page, key: string) => unit(page, key).getByTestId('unit-status');
const planPath = `/plans/${e2eHostProjectId}/${e2eHostIntentId}`;

test.describe('hosts', () => {
  test('unit status from pull requests @review-loop-23 @review-loop-31', async ({ page }) => {
    await page.goto(planPath);
    await expect(
      page.getByRole('heading', { name: /A tea garden that waters itself/ }),
    ).toBeVisible();

    // Not followed: only the files are read and the host is not asked (spec 24, 29).
    await expect(status(page, 'U1')).toHaveText('Status unknown');
    await expect(status(page, 'U5')).toHaveText('Blocked');
    await expect(page.getByTestId('host-read')).toHaveCount(0);
    expect((await asked()).filter((request) => request.startsWith('/search/'))).toEqual([]);

    await page.getByRole('switch', { name: 'Follow' }).click();

    // Delivered, claimed, ready, waiting and blocked, from the pull requests' Intent-Unit lines
    // (spec 23).
    await expect(status(page, 'U1')).toHaveText('Delivered');
    await expect(status(page, 'U2')).toHaveText('Claimed');
    await expect(status(page, 'U3')).toHaveText('Ready');
    await expect(status(page, 'U4')).toHaveText('Waiting');
    await expect(status(page, 'U5')).toHaveText('Blocked');
    await expect(unit(page, 'U4').getByTestId('unit-reason')).toHaveText('Waits for U2');

    // A unit with a pull request links to it and shows its state and checks; the plan says when
    // that was fetched (spec 26).
    const merged = unit(page, 'U1').getByTestId('unit-change-request');
    await expect(merged.getByRole('link', { name: '#12 Plant the tea' })).toHaveAttribute(
      'href',
      `${control}/web/acme/tea-garden/pull/12`,
    );
    await expect(merged.getByTestId('change-request-state')).toHaveText('Merged');
    await expect(merged.getByTestId('change-request-checks')).toHaveText('1 check passed');
    const claimed = unit(page, 'U2').getByTestId('unit-change-request');
    await expect(claimed.getByRole('link', { name: /#14 Water the beds/ })).toBeVisible();
    await expect(claimed.getByTestId('change-request-state')).toHaveText('Draft');
    await expect(claimed.getByTestId('change-request-checks')).toHaveText('2 of 4 checks failed');
    await expect(unit(page, 'U3').getByTestId('unit-change-request')).toHaveCount(0);
    await expect(page.getByTestId('host-fetched')).toHaveText(
      /^Last fetched \d{1,2}[:.]\d{2}.* from 127\.0\.0\.1:\d+$/,
    );
    await expect(page.getByTestId('host-error')).toHaveCount(0);

    // One search found them; the repository was never listed (spec 29).
    const requests = await asked();
    expect(requests.filter((request) => request.startsWith('/search/'))).toHaveLength(1);
    expect(requests.some((request) => /\/pulls\?(?!head=)/.test(request))).toBe(false);

    // The host fails: the statuses and the time stay, with the error (spec 31).
    await fetch(`${control}/github-host/failure?status=500`, { method: 'PUT' });
    const fetched = await page.getByTestId('host-fetched').textContent();
    await page.getByTestId('host-read').getByRole('button', { name: 'Refresh now' }).click();
    await expect(page.getByTestId('host-error')).toContainText(
      /127\.0\.0\.1:\d+ answered 500: Invented server error/,
    );
    await expect(page.getByTestId('host-fetched')).toHaveText(fetched ?? '');
    await expect(status(page, 'U1')).toHaveText('Delivered');
    await expect(status(page, 'U3')).toHaveText('Ready');

    // It answers again: the error goes with the next Refresh now (spec 30).
    await fetch(`${control}/github-host/failure`, { method: 'DELETE' });
    await page.getByTestId('host-read').getByRole('button', { name: 'Refresh now' }).click();
    await expect(page.getByTestId('host-error')).toHaveCount(0);
  });

  test('pull request beside a run @review-loop-28 @review-loop-31', async ({ page }) => {
    await startRun('host-e2e-run');
    await page.goto('/workflows/runs/host-e2e-run?tab=pullRequest');
    const tab = page.getByRole('tabpanel', { name: 'Pull request' });
    const request = tab.getByRole('article', { name: 'Pull request #14' });

    // The pull request whose head is the branch the run's folder is on (spec 28).
    await expect(
      request.getByRole('link', { name: '#14 Water the beds every morning' }),
    ).toHaveAttribute('href', `${control}/web/acme/tea-garden/pull/14`);
    await expect(request.getByTestId('change-request-state')).toHaveText('Draft');
    await expect(request.getByTestId('change-request-checks')).toHaveText('2 of 4 checks failed');
    await expect(request).toContainText(e2eHostBranch);

    // The failing checks by name and the review comments, each with a link to the host.
    const failing = request.getByRole('region', { name: 'Failing checks' });
    await expect(failing.getByTestId('failing-check')).toHaveText([
      'test (windows-latest)',
      'deploy/preview',
    ]);
    await expect(failing.getByRole('link', { name: 'test (windows-latest)' })).toHaveAttribute(
      'href',
      `${control}/web/acme/tea-garden/pull/14/checks?check_run_id=2`,
    );
    const comments = request.getByRole('region', { name: 'Review comments' });
    await expect(comments.getByTestId('review-comment')).toHaveCount(2);
    const first = comments.getByTestId('review-comment').first();
    await expect(first).toContainText('mira');
    await expect(first).toContainText('src/water.ts');
    await expect(first).toContainText('The beds flood when it rains.');
    await expect(first.getByRole('link', { name: 'Open comment' })).toHaveAttribute(
      'href',
      `${control}/web/acme/tea-garden/pull/14#discussion_r9001`,
    );

    await expect(tab.getByTestId('host-fetched')).toHaveText(
      /^Last fetched .* from 127\.0\.0\.1:\d+$/,
    );
    await expect(tab.getByRole('link', { name: 'Open on host' })).toHaveAttribute(
      'href',
      `${control}/web/acme/tea-garden/pull/14`,
    );

    // A host that fails leaves the pull request on screen with the error (spec 31).
    await fetch(`${control}/github-host/failure?status=503`, { method: 'PUT' });
    await tab.getByRole('button', { name: 'Refresh now' }).click();
    await expect(tab.getByTestId('host-error')).toContainText('answered 503');
    await expect(request.getByTestId('review-comment')).toHaveCount(2);
  });
});

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

  test('host tabs', async ({ page }) => {
    await startRun('host-sketch-run');
    await page.goto('/workflows/runs/host-sketch-run?tab=pullRequest');
    const tab = page.getByRole('tabpanel', { name: 'Pull request' });
    await expect(tab.getByTestId('review-comment')).toHaveCount(2);
    await expect(tab.getByTestId('host-fetched')).toContainText('Last fetched');
    await page.screenshot({ path: sketchPath('2026-11-review-loop', 'host-tabs') });
  });

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
