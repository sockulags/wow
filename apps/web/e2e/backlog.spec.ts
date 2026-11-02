import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { e2eHome, e2eTrackerPort } from './env';
import { choose } from './controls';

// U12 ground truth against the mock trackers and the scripted mock provider (e2e/server.ts):
// items stay local (behavior 28), "Plan on calendar" plans an item and the item follows its run
// (29), and publishing shows the issue first, stores key and URL, and offers the existing issue on
// a second press (30).

const trackers = `http://127.0.0.1:${e2eTrackerPort}`;

interface Received {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

async function received(): Promise<Received[]> {
  const response = await fetch(`${trackers}/requests`);
  return (await response.json()) as Received[];
}

// Starts the run of the item's card, as the scheduler does at the card's time.
async function fire(itemId: string): Promise<void> {
  const response = await fetch(`${trackers}/fire?backlogItemId=${itemId}`, { method: 'POST' });
  expect(response.ok).toBe(true);
}

test.beforeEach(async ({ page }) => {
  // What the desktop preload injects: the contents of `~/.wow/server.json`.
  const info: unknown = JSON.parse(await readFile(path.join(e2eHome, 'server.json'), 'utf8'));
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

async function addItem(
  page: Page,
  title: string,
  body: string,
  tags: readonly string[] = [],
): Promise<string> {
  await page.goto('/backlog');
  await page.getByRole('navigation', { name: 'Backlog' }).getByText('New item').click();
  const form = page.getByRole('form', { name: 'New backlog item' });
  // The form opens with the cursor in Title (audit A-11).
  await expect(form.getByLabel('Title')).toBeFocused();
  await form.getByLabel('Title').fill(title);
  await form.getByLabel('Body (markdown)').fill(body);
  for (const tag of tags) {
    await form.getByLabel('Add a tag').fill(tag);
    await form.getByLabel('Add a tag').press('Enter');
  }
  await form.getByRole('button', { name: 'Add item' }).click();
  await expect(page).toHaveURL(/\/backlog\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole('form', { name: 'Backlog item' }).getByLabel('Title', { exact: true }),
  ).toHaveValue(title);
  return new URL(page.url()).pathname.split('/').at(-1) ?? '';
}

async function plan(page: Page, date: string): Promise<void> {
  await page.getByRole('toolbar', { name: 'Item actions' }).getByText('Plan on calendar').click();
  const dialog = page.getByRole('dialog', { name: 'Plan on calendar' });
  await choose(dialog.getByLabel('Workflow'), 'Backlog e2e');
  await choose(dialog.getByLabel('Project'), 'Demo');
  await dialog.getByLabel('Date').fill(date);
  await dialog.getByLabel('Start').fill('09:00');
  await dialog.getByLabel('End').fill('09:30');
  await dialog.getByRole('button', { name: 'Plan' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('backlog-state')).toHaveText('Planned');
}

test.describe('backlog', () => {
  test('adds and filters items, plans one on the calendar and follows its run', async ({
    page,
  }) => {
    const sentBefore = (await received()).length;
    const itemId = await addItem(page, 'Fix the login e2e', 'The **login** fails on Mondays.', [
      'auth',
      'bug',
      'auth',
    ]);
    await expect(page.getByTestId('backlog-state')).toHaveText('Idea');
    const editorTags = page.getByRole('form', { name: 'Backlog item' }).getByTestId('tag-chip');
    await expect(editorTags).toHaveText(['auth', 'bug']);

    const list = page.getByRole('list', { name: 'Backlog items' });
    const entry = list.getByRole('link', { name: /Fix the login e2e/ });
    await expect(entry).toContainText('auth · bug');
    await page.getByLabel('Search backlog').fill('mondays');
    await expect(entry).toBeVisible();
    await choose(page.getByLabel('Filter by state'), 'Done');
    await expect(entry).toBeHidden();
    await choose(page.getByLabel('Filter by state'), 'Open');
    await choose(page.getByLabel('Filter by tag'), 'bug');
    await expect(entry).toBeVisible();
    await page.getByLabel('Search backlog').fill('');

    // Editing keeps the item local.
    const editor = page.getByRole('form', { name: 'Backlog item' });
    await editor.getByLabel('Body (markdown)').fill('The **login** fails on Mondays.\n\n- step 1');
    // Preview renders the markdown; Ctrl+S saves.
    await editor.getByRole('tab', { name: 'Preview' }).click();
    await expect(editor.getByTestId('markdown-preview').locator('strong')).toHaveText('login');
    await editor.getByRole('tab', { name: 'Write' }).click();
    await editor.getByLabel('Body (markdown)').press('Control+s');
    await expect(editor.getByRole('button', { name: 'Save' })).toBeDisabled();
    // Only Idea and Dropped are set by hand (owner decision F-12).
    await editor.getByLabel('State').click();
    await expect(page.getByRole('option')).toHaveText(['Idea', 'Dropped']);
    await page.keyboard.press('Escape');

    await plan(page, '2027-03-02');
    const card = page.getByTestId('backlog-card');
    await expect(card).toContainText('Tue 2 Mar 2027 09:00');
    await expect(card).toContainText('with Backlog e2e');
    await expect(entry).toContainText('Planned');
    await expect(editor.getByTestId('backlog-state-readonly')).toHaveText('Planned');

    // The card is on the calendar with the item and the workflow.
    await card.getByRole('link').click();
    await expect(page).toHaveURL(/\/calendar\?view=day&date=2027-03-02$/);
    await expect(page.getByText('Fix the login e2e').first()).toBeVisible();
    await page.goBack();

    // Nothing reached a tracker while adding, editing and planning.
    expect(await received()).toHaveLength(sentBefore);

    await fire(itemId);
    await expect(page.getByTestId('backlog-state')).toHaveText('Done');
    await expect(page.getByTestId('backlog-run')).toContainText('Backlog e2e (done)');
    await expect(page.getByTestId('backlog-run-problem')).toHaveCount(0);
  });

  test('goes back to planned and shows the failure when the run fails', async ({ page }) => {
    const itemId = await addItem(page, 'Risky change e2e', 'Please break the build.');
    await plan(page, '2027-03-03');
    await fire(itemId);
    await expect(page.getByTestId('backlog-run')).toContainText('Backlog e2e (failed)');
    await expect(page.getByTestId('backlog-state')).toHaveText('Planned');
    await expect(page.getByTestId('backlog-run-problem')).toContainText('The build broke');

    // The run view marks the failed step and keeps its thread (behavior 26).
    await page.getByTestId('backlog-run').getByRole('link').click();
    await expect(page.getByTestId('run-state')).toHaveText('Failed');
    const step = page.getByRole('list', { name: 'Run steps' }).getByTestId('run-step');
    await expect(step.getByTestId('step-state')).toHaveText('Failed');
    await expect(step.getByRole('link', { name: 'Open thread' })).toBeVisible();
  });

  test('publishes to Jira after a preview and offers the existing issue next time', async ({
    page,
  }) => {
    await addItem(page, 'Publish me e2e', '## Why\n\nBody for the **tracker**.\n\n- one', [
      'needs review',
    ]);
    const before = (await received()).length;
    await page.getByRole('toolbar', { name: 'Item actions' }).getByText('Publish to Jira').click();
    const dialog = page.getByRole('dialog', { name: 'Publish to Jira' });
    await expect(dialog.getByTestId('preview-target')).toHaveText('DEMO');
    await expect(dialog.getByTestId('preview-title')).toHaveValue('Publish me e2e');
    // The markdown body is shown rendered; Jira gets it as wiki markup.
    await expect(
      dialog.getByTestId('preview-body').getByRole('heading', { name: 'Why' }),
    ).toBeVisible();
    await expect(dialog.getByTestId('preview-body').locator('strong')).toHaveText('tracker');
    // The title can change before creating, and the item's tags can go along as labels.
    await dialog.getByTestId('preview-title').fill('Publish me e2e, edited');
    await dialog.getByRole('checkbox', { name: 'needs review' }).check();
    // The preview sends nothing.
    expect(await received()).toHaveLength(before);

    await dialog.getByRole('button', { name: 'Publish issue' }).click();
    await expect(dialog.getByTestId('publish-created')).toContainText(/Created DEMO-\d+/);
    const sent = (await received()).slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      path: '/jira/rest/api/2/issue',
      authorization: `Basic ${Buffer.from('me@example.invalid:jira-e2e-token').toString('base64')}`,
      body: {
        fields: {
          project: { key: 'DEMO' },
          issuetype: { name: 'Task' },
          summary: 'Publish me e2e, edited',
          description: 'h2. Why\n\nBody for the *tracker*.\n\n* one',
          labels: ['needs-review'],
        },
      },
    });
    await dialog.getByRole('button', { name: 'Close' }).first().click();

    const remote = page.getByTestId('backlog-remote');
    await expect(remote).toContainText(/Published to Jira as DEMO-\d+/);
    await expect(remote.getByRole('link')).toHaveAttribute(
      'href',
      new RegExp(`^${trackers}/jira/browse/DEMO-\\d+$`),
    );

    // A second press, from the palette, offers the existing issue and creates nothing.
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').getByRole('combobox').fill('publish to jira');
    await page.keyboard.press('Enter');
    await expect(dialog.getByTestId('publish-existing')).toContainText(
      /Already published as DEMO-/,
    );
    await expect(dialog.getByRole('link', { name: /Open DEMO-/ })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).first().click();
    expect((await received()).slice(before)).toHaveLength(1);
  });

  test('asks for the GitHub token, then publishes to GitHub', async ({ page }) => {
    const itemId = await addItem(page, 'Ship dark mode e2e', 'Respect the system theme.');
    const toolbar = page.getByRole('toolbar', { name: 'Item actions' });
    await toolbar.getByText('Publish to GitHub').click();
    const dialog = page.getByRole('dialog', { name: 'Publish to GitHub' });
    // The missing setting is asked for right here, then the preview follows (audit D-09).
    const setUp = dialog.getByRole('form', { name: 'Set up GitHub' });
    await expect(setUp).toContainText('GitHub needs one more setting');
    await expect(setUp.getByLabel('GitHub token')).toBeFocused();
    await setUp.getByLabel('GitHub token').fill('github-e2e-token');
    await setUp.getByRole('button', { name: 'Set up GitHub' }).click();
    await expect(dialog.getByTestId('preview-target')).toHaveText('acme/demo');

    // The token is stored like the settings page stores it.
    await page.goto('/settings/trackers');
    await expect(
      page
        .getByTestId('setting-trackers.github.token')
        .getByTestId('setting-trackers.github.token-status'),
    ).toHaveText('Saved');

    await page.goto(`/backlog/${itemId}?dialog=github`);
    await expect(dialog.getByTestId('preview-target')).toHaveText('acme/demo');
    const before = (await received()).length;
    await dialog.getByRole('button', { name: 'Publish issue' }).click();
    await expect(dialog.getByTestId('publish-created')).toContainText(/Created acme\/demo#\d+/);
    const [sent] = (await received()).slice(before);
    expect(sent).toMatchObject({
      path: '/github/repos/acme/demo/issues',
      authorization: 'Bearer github-e2e-token',
      body: { title: 'Ship dark mode e2e', body: 'Respect the system theme.' },
    });
    await dialog.getByRole('button', { name: 'Close' }).first().click();
    await expect(page.getByTestId('backlog-remote')).toContainText(
      /Published to GitHub as acme\/demo#\d+/,
    );
  });

  test('deletes an item at once and Undo puts it back (owner decision F-9)', async ({ page }) => {
    const itemId = await addItem(page, 'Undo me e2e', 'Still here.', ['undo']);
    await page.getByRole('toolbar', { name: 'Item actions' }).getByText('Delete').click();
    await expect(page).toHaveURL(/\/backlog$/);
    const list = page.getByRole('list', { name: 'Backlog items' });
    await expect(list.getByRole('link', { name: /Undo me e2e/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(list.getByRole('link', { name: /Undo me e2e/ })).toBeVisible();
    await list.getByRole('link', { name: /Undo me e2e/ }).click();
    await expect(page).toHaveURL(new RegExp(`/backlog/${itemId}$`));
    await expect(
      page.getByRole('form', { name: 'Backlog item' }).getByTestId('tag-chip'),
    ).toHaveText(['undo']);
  });
});
