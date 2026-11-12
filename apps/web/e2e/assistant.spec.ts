import { expect, test, type Page } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  e2eAssistantGateWorkflowId,
  e2eAssistantHome as home,
  e2eAssistantTrackerPort,
  e2eGitLabToken,
} from './env';
import { sketchPath, sketching, sketchUse } from './sketch';

// App assistant U3 ground truth against the assistant's copy of the e2e server, whose mock agent
// calls wow's tools (e2e/assistant-agent.ts): the Assistant section, change rows with Undo,
// proposals with Yes and No, the secret field, a held message and the offer to take project
// work to the chat view. There is one assistant conversation per install, so the cases run in
// order and each reads the rows it added.
test.describe.configure({ mode: 'serial' });

if (sketching) test.use(sketchUse);

const intent = '2026-11-app-assistant';
// Invented, in the form of a GitLab token, so the check before send holds it.
const lookalike = 'glpat-InventedE2eValue0123456789ab';

test.beforeEach(async ({ page }) => {
  // What the desktop preload injects: the contents of `~/.wow/server.json`.
  const info: unknown = JSON.parse(await readFile(path.join(home, 'server.json'), 'utf8'));
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

const conversation = (page: Page) => page.getByRole('list', { name: 'Conversation' });
const composer = (page: Page) => page.getByRole('combobox', { name: 'Message' });

// Sends a message and waits for the turn's answer, the last row after the message. Every
// message of the file is different, so it is found by its text; another file of this project
// may have sent a longer message that holds the same words, so the newest match is the one.
async function say(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(
    conversation(page).getByTestId('item-user').filter({ hasText: text }).last(),
  ).toBeVisible();
  await expect(conversation(page).locator(':scope > li').last()).toHaveAttribute(
    'data-testid',
    'item-assistant_text',
  );
}

// Every file of the server's home but the secret store itself, as text.
async function homeFiles(folder = home): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) found.push(...(await homeFiles(full)));
    else if (entry.name !== 'secrets.json') found.push((await readFile(full)).toString('latin1'));
  }
  return found;
}

test.describe('assistant', () => {
  test('the assistant changes a setting and it can be undone @app-assistant-7 @app-assistant-8', async ({
    page,
  }) => {
    await page.goto('/calendar');
    await expect(page.getByRole('region', { name: 'Calendar' })).toBeVisible();
    // The section opens with its key (spec 1) and shows the one conversation with a composer.
    await page.keyboard.press('Control+6');
    await expect(page).toHaveURL(/\/assistant$/);
    await expect(page.getByTestId('assistant-provider')).toContainText('Mock Claude');
    // The model by its label, not its id (agent workbench spec 86).
    await expect(page.getByTestId('assistant-provider').getByTestId('model-name')).toHaveAttribute(
      'data-model-id',
      /.+/,
    );
    await expect(page.getByTestId('assistant-provider').getByTestId('model-name')).not.toHaveText(
      /^mock-/,
    );
    await expect(composer(page)).toBeFocused();

    await say(page, 'Make my work hours end at four');
    const row = page.getByRole('region', { name: 'Change: Work hours' }).last();
    await expect(row).toContainText(/Work hours: .+ → 08:00–16:00/);
    await expect(row.getByRole('link', { name: 'Settings → Calendar' })).toBeVisible();
    if (sketching) await row.screenshot({ path: sketchPath(intent, 'change-row') });

    await row.getByRole('button', { name: 'Undo' }).click();
    await expect(row.getByText('Undone')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    await expect(row).toHaveAttribute('data-state', 'undone');

    // The place is a link the user can follow (spec 20).
    await row.getByRole('link', { name: 'Settings → Calendar' }).click();
    await expect(page).toHaveURL(/\/settings\/calendar$/);

    // And the palette opens the section again.
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').getByRole('combobox').fill('go to assistant');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/assistant$/);
    // The next turn hears about the Undo.
    await say(page, 'Thanks');
    await expect(conversation(page).getByTestId('item-assistant_text').last()).toContainText(
      'Undid "Work hours"',
    );
  });

  test('a proposal waits for yes @app-assistant-9 @app-assistant-10', async ({ page }) => {
    await page.goto('/assistant');
    await say(page, 'Let HTML files run their scripts');
    const first = page.getByTestId('assistant-proposal').last();
    await expect(first).toHaveAttribute('data-state', 'pending');
    await expect(first.getByRole('list', { name: 'What would change' })).toContainText(
      'Run scripts in HTML files',
    );
    await expect(page.getByTestId('needs-you-assistant')).toHaveText('1');

    // No takes a reason, and nothing changes.
    await first.getByRole('button', { name: 'No' }).click();
    await first.getByRole('textbox', { name: 'Reason for no (optional)' }).fill('Not on Fridays');
    await first.getByRole('button', { name: 'Say no' }).click();
    await expect(first.getByTestId('assistant-proposal-answer')).toHaveText(
      'No: nothing changed (Not on Fridays)',
    );

    await say(page, 'Then let HTML files run scripts after all');
    await expect(conversation(page).getByTestId('item-assistant_text').last()).toContainText(
      'Their reason: Not on Fridays',
    );
    const second = page.getByTestId('assistant-proposal').last();
    await expect(second).toHaveAttribute('data-state', 'pending');
    if (sketching) await second.screenshot({ path: sketchPath(intent, 'proposal') });
    await second.getByRole('button', { name: 'Yes' }).click();
    await expect(second.getByTestId('assistant-proposal-answer')).toHaveText('Yes: applied');
    await expect(page.getByTestId('needs-you-assistant')).toHaveCount(0);

    await say(page, 'What now?');
    await expect(conversation(page).getByTestId('item-assistant_text').last()).toContainText(
      'Yes to "Change Run scripts in HTML files": it is applied.',
    );
    await page.goto('/settings/viewer');
    await expect(page.getByRole('switch', { name: 'Run scripts in HTML files' })).toBeChecked();
  });

  test('a secret goes to its field @app-assistant-14', async ({ page }) => {
    await page.goto('/assistant');
    await say(page, 'Connect our GitLab');
    await expect(page.getByRole('region', { name: 'Change: GitLab URL' })).toBeVisible();
    const card = page.getByRole('region', { name: 'Secret field: GitLab token' });
    await expect(card.getByTestId('assistant-secret-target')).toContainText(
      'Settings → Trackers, for every project',
    );
    await expect(card.getByTestId('assistant-secret-state')).toHaveText('Not set');
    // The guide wow ships for GitLab, built from the address just set (U4, spec 15).
    const guide = card.getByRole('group', { name: 'Token guide for GitLab' });
    await expect(guide).toContainText('written for GitLab 16.9 and later');
    await expect(guide).toContainText('read_api');
    await expect(guide.getByRole('link').first()).toHaveAttribute(
      'href',
      /\/gitlab\/-\/user_settings\/personal_access_tokens\?name=wow&scopes=read_api$/,
    );

    const field = card.getByLabel('GitLab token');
    await expect(field).toHaveAttribute('type', 'password');
    await field.fill(e2eGitLabToken);
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByTestId('assistant-secret-state')).toHaveText('Set');
    await expect(field).toHaveValue('');
    await card.getByRole('button', { name: 'Test connection' }).click();
    await expect(card.getByTestId('tracker-gitlab-status')).toContainText('mira');
    if (sketching) await card.screenshot({ path: sketchPath(intent, 'secret-field') });

    // The agent learns only that it is set (spec 14).
    await say(page, 'Is GitLab set up now?');
    if (sketching) {
      await page
        .getByTestId('conversation')
        .evaluate((element) => element.scrollTo(0, element.scrollHeight));
      await page.screenshot({ path: sketchPath(intent, 'assistant') });
    }

    // The value is in no message, tool result or stored row: not on the page and nowhere in the
    // server's home but its secret store.
    await expect(conversation(page)).not.toContainText(e2eGitLabToken);
    for (const group of await conversation(page).getByTestId('item-tool_group').all()) {
      await group.locator(':scope > details > summary').click();
    }
    for (const tool of await conversation(page).getByTestId('item-tool_call').all()) {
      await tool.locator('summary').click();
      await expect(tool).not.toContainText(e2eGitLabToken);
    }
    for (const text of await homeFiles()) expect(text).not.toContain(e2eGitLabToken);
  });

  test('a message that looks like a secret is held @app-assistant-17', async ({ page }) => {
    await page.goto('/assistant');
    // The conversation so far is there: it ends with the last answer.
    await expect(conversation(page).locator(':scope > li').last()).toHaveAttribute(
      'data-testid',
      'item-assistant_text',
    );
    const users = conversation(page).getByTestId('item-user');
    const sent = await users.count();
    await composer(page).fill(`Here is the token: ${lookalike}`);
    await composer(page).press('Enter');
    const held = page.getByTestId('held-message');
    await expect(held).toContainText('Not sent: this looks like a GitLab token.');
    await expect(held.getByRole('button', { name: 'Put it in GitLab token' })).toBeVisible();
    await expect(held.getByRole('button', { name: 'Send anyway' })).toBeVisible();
    await expect(composer(page)).toHaveValue(`Here is the token: ${lookalike}`);
    if (sketching) {
      await page
        .getByTestId('held-message')
        .locator('..')
        .screenshot({ path: sketchPath(intent, 'held-message') });
    }
    // A held message is not stored.
    await expect(users).toHaveCount(sent);
    for (const text of await homeFiles()) expect(text).not.toContain(lookalike);

    // Put it in its field: the value goes to the store and out of the message. The field holds
    // the token saved before, and the line says it would be replaced.
    await expect(held.getByTestId('held-replaces')).toHaveText(
      'GitLab token already holds a value; putting this one there replaces it.',
    );
    await held.getByRole('button', { name: 'Put it in GitLab token' }).click();
    await expect(page.getByTestId('held-saved')).toHaveText(
      'Saved in GitLab token in place of the value it held. It was taken out of your message.',
    );
    await expect(composer(page)).toHaveValue('Here is the token:');
    await expect(users).toHaveCount(sent);
    for (const text of await homeFiles()) expect(text).not.toContain(lookalike);

    // Send anyway sends what the box holds, edits made after the hold included.
    await composer(page).fill(`Send this: ${lookalike}`);
    await composer(page).press('Enter');
    await expect(held).toBeVisible();
    await composer(page).fill(`Send this now: ${lookalike}`);
    await held.getByRole('button', { name: 'Send anyway' }).click();
    await expect(users).toHaveCount(sent + 1);
    await expect(users.last()).toContainText('Send this now:');
    await expect(composer(page)).toHaveValue('');
  });

  test('the assistant says why it does not work @app-assistant-19 @app-assistant-20', async ({
    page,
  }) => {
    await page.goto('/assistant');
    await say(page, 'Why does this not work?');
    const tool = conversation(page).getByTestId('item-tool_call').last();
    await expect(tool).toContainText('Checked what does not work');
    const reply = conversation(page).getByTestId('item-assistant_text').last();
    await expect(reply).toContainText(/\d+ things? (is|are) failing\./);
    // The seeded workflow names a skill that is not installed; the reply says so and where.
    await expect(reply).toContainText(
      'Workflow Brew report, step report: It runs the skill brew-report, which is not installed on this machine.',
    );
    await expect(reply).toContainText('Fix it in Workflows → Brew report.');
  });

  test('the assistant offers to take project work to the chat view @app-assistant-3', async ({
    page,
  }) => {
    await page.goto('/assistant');
    await say(page, 'Fix the failing kettle test in Demo');
    const card = page.getByTestId('assistant-project-work').last();
    await expect(card).toContainText('Fix the failing kettle test in Demo');
    await card.getByRole('button', { name: 'Open in Chat' }).click();
    await expect(page).toHaveURL(/\/chat\/new$/);
    await expect(composer(page)).toHaveValue('Fix the failing kettle test in Demo');
  });

  test('the assistant does not answer a gate @app-assistant-11', async ({ page }) => {
    const runId = `assistant-gate-${test.info().retry}`;
    const query = new URLSearchParams({ workflowId: e2eAssistantGateWorkflowId, runId });
    const started = await fetch(`http://127.0.0.1:${e2eAssistantTrackerPort}/run?${query}`, {
      method: 'POST',
    });
    expect(started.ok).toBe(true);
    await page.goto('/assistant');
    await say(page, `Approve the run ${runId}`);
    // The real command, sent as the assistant's, is refused with who answers and where.
    const tool = conversation(page).getByTestId('item-tool_call').last();
    await tool.locator('summary').click();
    await expect(tool).toContainText('workflowRun.continue');
    await expect(tool).toContainText(
      `Only the user approves, sends back or stops a run. The run is at /workflows/runs/${runId}.`,
    );
    await expect(conversation(page).locator(':scope > li').last()).toContainText(
      'Only you approve a run at its gate',
    );
    // The run still waits at its gate for the user.
    await page.goto(`/workflows/runs/${runId}`);
    const gate = page.getByTestId('run-gate').getByRole('region', { name: 'Gate' });
    await expect(gate).toHaveCount(1);
    await expect(gate.getByRole('button', { name: 'Approve' })).toBeVisible();
  });

  test('the tool calls of a turn are one row that says what was done', async ({ page }) => {
    await page.goto('/assistant');
    await say(page, 'Look over my setup');
    const group = conversation(page).getByTestId('item-tool_group').last();
    const row = group.locator(':scope > details > summary');
    // Closed once the turn ended (agent workbench spec 91).
    await expect(group.getByTestId('tool-group-summary')).toHaveText('Used 3 tools');
    await expect(group.getByTestId('item-tool_call')).toHaveCount(0);
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(group.getByTestId('item-tool_call')).toHaveText([
      /Read your projects/,
      /Read your workflows/,
      /Read your skills/,
    ]);
  });
});
