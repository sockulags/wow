import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
  test('unit status from GitLab merge requests', async ({ page }) => {
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

  test('merge request beside a run', async ({ page }) => {
    const query = new URLSearchParams({
      workflowId: e2eHostWorkflowId,
      projectId: e2eGitLabProjectId,
      runId: 'gitlab-e2e-run',
    });
    expect((await fetch(`${control}/run?${query}`, { method: 'POST' })).ok).toBe(true);
    await page.goto('/workflows/runs/gitlab-e2e-run?tab=pullRequest');
    const tab = page.getByRole('tabpanel', { name: 'Pull request' });
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
});
