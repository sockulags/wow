import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  e2eChangesHome,
  e2eChangesTrackerPort,
  e2eHostProjectId,
  e2eHostWorkflowId,
  e2eTicketBacklogItemId,
  e2ePagesTicketKey,
  e2eTicketKey,
} from './env';

// U11 ground truth (review loop spec 31 to 33) against the Changes copy of the e2e server: a
// backlog item there is already published to the mock Jira, and a run of it in project
// `tea-garden` shows that issue in its Ticket tab. Jira is the global one the server seeds.
test.describe.configure({ mode: 'serial' });

const control = `http://127.0.0.1:${e2eChangesTrackerPort}`;

test.beforeEach(async ({ page }) => {
  const info: unknown = JSON.parse(
    await readFile(path.join(e2eChangesHome, 'server.json'), 'utf8'),
  );
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

test.afterEach(async () => {
  await fetch(`${control}/jira-host/failure`, { method: 'DELETE' });
});

async function startRun(runId: string, backlogItemId?: string): Promise<void> {
  const query = new URLSearchParams({
    workflowId: e2eHostWorkflowId,
    projectId: e2eHostProjectId,
    runId,
    ...(backlogItemId ? { backlogItemId } : {}),
  });
  const response = await fetch(`${control}/run?${query}`, { method: 'POST' });
  expect(response.ok).toBe(true);
}

// A read of one issue, as the mock Jira records it.
const issue = (key: string) => `GET /rest/api/2/issue/${key}`;

test.describe('tickets', () => {
  test('a Jira ticket beside a run @review-loop-31 @review-loop-33', async ({ page }) => {
    await startRun('ticket-e2e-run', e2eTicketBacklogItemId);
    await page.goto('/workflows/runs/ticket-e2e-run?tab=ticket');
    const tab = page.getByRole('tabpanel', { name: 'Ticket' });
    const ticket = tab.getByRole('article', { name: `Ticket ${e2eTicketKey}` });

    // The issue the run's backlog item was published as, with a link (spec 33).
    await expect(
      ticket.getByRole('link', { name: `${e2eTicketKey} Water the beds before the sun is up` }),
    ).toHaveAttribute('href', `${control}/jira/browse/${e2eTicketKey}`);
    await expect(ticket.getByTestId('ticket-status')).toHaveText('In Progress');
    await expect(ticket.getByTestId('ticket-type')).toHaveText('Story');
    await expect(ticket.getByTestId('ticket-assignee')).toHaveText('Mira Invented');
    await expect(ticket.getByTestId('ticket-source')).toHaveText(
      "From the backlog item's Jira issue",
    );
    await expect(tab.getByTestId('host-fetched')).toHaveText(
      /^Last fetched .* from 127\.0\.0\.1:\d+$/,
    );
    await expect(tab.getByRole('link', { name: 'Open on host' })).toHaveAttribute(
      'href',
      `${control}/jira/browse/${e2eTicketKey}`,
    );

    // The wiki markup reads as formatted text; the script in it is text and never runs.
    const description = ticket.getByTestId('ticket-description');
    await expect(description.getByRole('heading', { name: 'Why' })).toBeVisible();
    await expect(description.locator('strong')).toHaveText('noon');
    await expect(description.locator('code').first()).toHaveText('water.ts');
    await expect(description.locator('ol > li')).toHaveText([
      'Open the valve',
      'Close it after ten minutes',
    ]);
    await expect(description).toContainText('openValve(10);');
    await expect(description).toContainText('<script>window.ranTicketScript = true</script>');
    await expect(description.getByRole('link', { name: 'click' })).toHaveCount(0);
    expect(
      await page.evaluate(() => (globalThis as { ranTicketScript?: boolean }).ranTicketScript),
    ).toBeUndefined();

    // Jira refuses the token: the ticket and its time stay, the error names the setting
    // (spec 31, 32).
    const fetched = await tab.getByTestId('host-fetched').textContent();
    await fetch(`${control}/jira-host/failure?status=401`, { method: 'PUT' });
    await tab.getByRole('button', { name: 'Refresh now' }).click();
    await expect(tab.getByTestId('host-error')).toContainText(/refused the Jira token \(401/);
    await expect(
      tab.getByTestId('host-error').getByRole('link', { name: /^Open .+ in Settings$/ }),
    ).toHaveAttribute('href', '/settings/trackers');
    await expect(tab.getByTestId('host-fetched')).toHaveText(fetched ?? '');
    await expect(ticket.getByTestId('ticket-status')).toHaveText('In Progress');

    // Only GET requests for a run's own issue reached Jira: this run's, and the page tests' run
    // on the same server, which may have been read by now.
    const asked = (await (await fetch(`${control}/jira-host/requests`)).json()) as {
      method: string;
      path: string;
    }[];
    const kinds = new Set(
      asked.map((request) => `${request.method} ${request.path.split('?')[0]}`),
    );
    expect(kinds).toContain(issue(e2eTicketKey));
    expect(
      [...kinds].filter(
        (kind) => kind !== issue(e2eTicketKey) && kind !== issue(e2ePagesTicketKey),
      ),
    ).toEqual([]);
  });

  test('a run without a ticket says so', async ({ page }) => {
    await startRun('no-ticket-e2e-run');
    await page.goto('/workflows/runs/no-ticket-e2e-run?tab=ticket');
    const tab = page.getByRole('tabpanel', { name: 'Ticket' });
    await expect(tab.getByText(/No Jira ticket was found for this run/)).toBeVisible();
    await expect(tab.getByRole('article')).toHaveCount(0);
  });
});
