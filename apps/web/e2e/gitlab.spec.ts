import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { choose } from './controls';
import {
  e2eChangesHome,
  e2eChangesTrackerPort,
  e2eGitLabBranch,
  e2eGitLabIntentId,
  e2eGitLabProjectId,
  e2eGitLabProjectPath,
  e2eHostWorkflowId,
} from './env';

// U12 ground truth (review loop spec 34, with 31 and 32 for GitLab) against the Changes copy of
// the e2e server: project `tea-field` has its git remote on the mock GitLab, under a nested group,
// is on the branch of an open merge request, and has a plan whose units have merge requests
// there. The first test follows the plan and the tests share that server, so they run in order.
test.describe.configure({ mode: 'serial' });

const control = `http://127.0.0.1:${e2eChangesTrackerPort}`;
const web = `${control}/web/${e2eGitLabProjectPath}/-/merge_requests`;
const encoded = encodeURIComponent(e2eGitLabProjectPath);

test.beforeEach(async ({ page }) => {
  const info: unknown = JSON.parse(
    await readFile(path.join(e2eChangesHome, 'server.json'), 'utf8'),
  );
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

test.afterEach(async () => {
  await fetch(`${control}/gitlab-host/failure`, { method: 'DELETE' });
});

const asked = async (): Promise<string[]> => {
  const response = await fetch(`${control}/gitlab-host/requests`);
  return ((await response.json()) as { path: string }[]).map((request) => request.path);
};

const unit = (page: Page, key: string) => page.getByTestId(`unit-${key}`);
const status = (page: Page, key: string) => unit(page, key).getByTestId('unit-status');

test.describe('gitlab', () => {
  test('unit status from GitLab merge requests @review-loop-23', async ({ page }) => {
    await page.goto(`/plans/${e2eGitLabProjectId}/${e2eGitLabIntentId}`);
    await expect(
      page.getByRole('heading', { name: /A tea field that weeds itself/ }),
    ).toBeVisible();
    await expect(status(page, 'U1')).toHaveText('Status unknown');
    expect(await asked()).toEqual([]);

    await page.getByRole('switch', { name: 'Follow' }).click();

    // The same statuses as from pull requests (spec 23 via 34).
    await expect(status(page, 'U1')).toHaveText('Delivered');
    await expect(status(page, 'U2')).toHaveText('Claimed');
    await expect(status(page, 'U3')).toHaveText('Ready');
    await expect(status(page, 'U4')).toHaveText('Waiting');
    await expect(unit(page, 'U4').getByTestId('unit-reason')).toHaveText('Waits for U2');

    const merged = unit(page, 'U1').getByTestId('unit-change-request');
    await expect(merged.getByRole('link', { name: '!7 Plough the field' })).toHaveAttribute(
      'href',
      `${web}/7`,
    );
    await expect(merged.getByTestId('change-request-state')).toHaveText('Merged');
    await expect(merged.getByTestId('change-request-checks')).toHaveText('1 check passed');
    const claimed = unit(page, 'U2').getByTestId('unit-change-request');
    await expect(claimed.getByRole('link', { name: '!9 Weed the rows by hand' })).toBeVisible();
    await expect(claimed.getByTestId('change-request-checks')).toHaveText('1 of 2 checks failed');
    await expect(page.getByTestId('host-error')).toHaveCount(0);

    // One search, with the nested group path as one encoded project id (spec 29).
    const requests = await asked();
    expect(requests.filter((request) => request.includes('search='))).toHaveLength(1);
    expect(requests.every((request) => request.startsWith(`/projects/${encoded}/`))).toBe(true);
  });

  test('merge request beside a run @review-loop-28 @review-loop-31', async ({ page }) => {
    const query = new URLSearchParams({
      workflowId: e2eHostWorkflowId,
      projectId: e2eGitLabProjectId,
      runId: 'gitlab-e2e-run',
    });
    expect((await fetch(`${control}/run?${query}`, { method: 'POST' })).ok).toBe(true);
    await page.goto('/workflows/runs/gitlab-e2e-run?tab=pullRequest');
    await expect(page.getByRole('tab', { name: 'Merge request' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const tab = page.getByRole('tabpanel', { name: 'Merge request' });
    const request = tab.getByRole('article', { name: 'Merge request !9' });

    // The merge request of the branch the run's folder is on, with the failing job names and
    // the note (spec 28 via 34). GitLab's own note and the manual job are left out.
    await expect(request.getByRole('link', { name: '!9 Weed the rows by hand' })).toHaveAttribute(
      'href',
      `${web}/9`,
    );
    await expect(request).toContainText(e2eGitLabBranch);
    const failing = request.getByRole('region', { name: 'Failing checks' });
    await expect(failing.getByTestId('failing-check')).toHaveText(['test:windows']);
    const comments = request.getByRole('region', { name: 'Review comments' });
    await expect(comments.getByTestId('review-comment')).toHaveCount(1);
    await expect(comments.getByTestId('review-comment')).toContainText(
      'The weeds grow back by Friday.',
    );
    await expect(comments.getByRole('link', { name: 'Open comment' })).toHaveAttribute(
      'href',
      `${web}/9#note_702`,
    );

    // A refused token: the merge request stays, and the view says which host refused and
    // points to the setting (spec 31, 32).
    await fetch(`${control}/gitlab-host/failure?status=401`, { method: 'PUT' });
    await tab.getByRole('button', { name: 'Refresh now' }).click();
    await expect(tab.getByTestId('host-error')).toContainText(
      /127\.0\.0\.1:\d+ refused the GitLab token .*Check the GitLab token in Settings → Trackers/,
    );
    await expect(request.getByTestId('review-comment')).toHaveCount(1);
  });

  test('test connection to GitLab for the project', async ({ page }) => {
    await page.goto('/settings/projects');
    const row = page.getByRole('listitem', { name: 'Tea field' });
    await row.getByRole('button', { name: 'Trackers' }).click();
    const panel = page.getByRole('region', { name: 'Trackers for Tea field' });
    const gitlab = panel.getByRole('region', { name: 'GitLab' });
    await expect(gitlab.getByTestId(/-gitlab-project$/)).toContainText(e2eGitLabProjectPath);
    await gitlab.getByRole('button', { name: 'Test connection' }).click();
    await expect(gitlab.getByRole('status')).toHaveText(
      'Signed in as Mira Invented @mira on GitLab 17.5.2.',
    );

    // A token the host turns down: its own message.
    await fetch(`${control}/gitlab-host/failure?status=401`, { method: 'PUT' });
    await gitlab.getByRole('button', { name: 'Test connection' }).click();
    await expect(gitlab.getByRole('status')).toHaveText(
      'GitLab answered 401: Invented GitLab error',
    );
  });

  // Thread work U4 (spec 31, 32): a thread of "Tea field" in its own working copy commits the
  // bell and opens a draft merge request. The branch goes to a bare repository beside the
  // project (the remote's push address); the merge request to the mock GitLab.
  test('opens a merge request from a thread @thread-work-31 @thread-work-32', async ({ page }) => {
    // A worktree, a commit and a push: as slow on Windows as the working copy cases.
    test.slow();
    const main = page.locator('#main-view');
    const messageBox = main.getByRole('combobox', { name: 'Message' });
    await page.goto('/chat/new');
    const instance = main.getByLabel('Provider instance');
    await choose(instance, 'Mock Claude');
    await expect(instance).toBeFocused();
    await choose(main.getByRole('combobox', { name: 'Project' }), 'Tea field');
    const own = main.getByRole('switch', { name: 'Own working copy' });
    await own.click();
    await expect(own).toHaveAttribute('aria-checked', 'true');
    await messageBox.fill('Edit the bell for a merge request');
    await messageBox.press('Enter');
    const conversation = main.getByRole('list', { name: 'Conversation' });
    await expect(conversation.getByText('The bell rings softly now.')).toBeVisible();
    const branch = ((await page.getByTestId('working-copy-chip').textContent()) ?? '').split(
      '·',
    )[0];

    await page.keyboard.press('Control+Shift+K');
    const commit = page.getByTestId('commit-dialog');
    await expect(commit.getByRole('checkbox', { name: 'src/bell.ts' })).toBeChecked();
    await commit.getByRole('textbox', { name: 'Message' }).fill('Weed the rows by hand');
    await page.keyboard.press('Control+Enter');
    await expect(commit).toHaveCount(0);
    await expect(conversation.getByTestId('committed-line')).toContainText('Weed the rows by hand');

    await page.getByRole('button', { name: /^Open merge request…/ }).click();
    const request = page.getByTestId('pull-request-dialog');
    const statement = request.getByTestId('pull-request-statement');
    await expect(statement).toContainText(`Pushes ${branch} to origin and opens a merge request`);
    await expect(statement).toContainText(` in ${e2eGitLabProjectPath}`);
    await request.getByRole('switch', { name: 'Draft' }).click();
    await expect(statement).toContainText('opens a draft merge request');
    await request.getByRole('button', { name: /^Open merge request/ }).click();
    await expect(request).toHaveCount(0);
    await expect(conversation.getByTestId('change-request-line')).toContainText(
      /Opened merge request !\d+ · Weed the rows by hand/,
    );
    const opened = (await (await fetch(`${control}/gitlab-host/opened`)).json()) as {
      source_branch: string;
      target_branch: string;
      title: string;
    }[];
    expect(opened.filter((entry) => entry.source_branch === branch)).toEqual([
      expect.objectContaining({ target_branch: 'main', title: 'Draft: Weed the rows by hand' }),
    ]);
  });
});
