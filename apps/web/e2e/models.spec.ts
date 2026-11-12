import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { choose } from './controls';
import { e2eAssistantHome, e2eOldWorkflowId } from './env';

// Questions-and-models U2 ground truth: a workflow the assistant makes names each step's model
// and effort (spec 15), and the builder lists an instance's models with its default marked and
// shows the refusal for a Codex step without a model (spec 17 to 19). The assistant's server
// copy has one conversation, so this file shares a worker with the other assistant files.
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  const info: unknown = JSON.parse(
    await readFile(path.join(e2eAssistantHome, 'server.json'), 'utf8'),
  );
  await page.addInitScript((value) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = value;
  }, info);
});

const conversation = (page: Page) => page.getByRole('list', { name: 'Conversation' });
const composer = (page: Page) => page.getByRole('combobox', { name: 'Message' });

test("a workflow made by the assistant shows each step's model @questions-15", async ({ page }) => {
  await page.goto('/assistant');
  await expect(composer(page)).toBeFocused();
  const text = 'Make a review workflow for the tea project';
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(conversation(page).getByTestId('item-user').filter({ hasText: text })).toBeVisible();
  const reply = conversation(page).getByTestId('item-assistant_text').last();
  await expect(reply).toContainText(
    'because the guidance says planning needs the most capable model',
  );

  const row = conversation(page).getByTestId('assistant-change').last();
  await expect(row).toContainText('Workflow "Tea review"');
  await expect(row).toContainText('plan-work (Mock Claude, Mock model, large, high)');
  await expect(row).toContainText('check-work (Mock Claude, Mock model, low)');

  await page.goto('/workflows');
  await page
    .getByRole('link', { name: /Tea review/ })
    .first()
    .click();
  const builder = page.getByRole('form', { name: 'Workflow builder' });
  await builder.getByRole('button', { name: 'Expand step 1' }).click();
  const first = builder.getByRole('listitem', { name: 'Step 1' });
  await expect(first.getByLabel('Model')).toContainText('Mock model, large');
  await expect(first.getByLabel('Effort')).toContainText('High');
});

test("the builder lists a step's models with the default marked and shows the refusal @questions-17 @questions-18 @questions-19", async ({
  page,
}) => {
  await page.goto(`/workflows/${e2eOldWorkflowId}`);
  const builder = page.getByRole('form', { name: 'Workflow builder' });
  const bare = builder.getByRole('listitem', { name: 'Step 1' });
  const withDefault = builder.getByRole('listitem', { name: 'Step 2' });
  // Stored before the rule: the step without a default says what the server refuses, the one
  // with a default is marked and takes it.
  const refusal =
    'Step check-work runs on Codex (Codex bare), which needs a model on every step, and Codex bare has no default model: choose a model for the step.';
  await expect(bare.getByText(refusal)).toBeVisible();
  await expect(
    withDefault.getByText(
      'Step 2 was saved without a model, which Codex needs; Save stores mock-model-large.',
    ),
  ).toBeVisible();

  await builder.getByRole('button', { name: 'Expand step 2' }).click();
  await withDefault.getByLabel('Model').click();
  await expect(page.getByRole('option')).toHaveText(['Mock model', 'Mock model, large (default)']);
  await page.keyboard.press('Escape');
  await withDefault.getByLabel('Effort').click();
  await expect(page.getByRole('option', { name: 'Medium (default)' })).toBeVisible();
  await page.keyboard.press('Escape');

  await builder.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(bare.getByText(refusal)).toBeVisible();
  // Save refused in place opens the step it is about.
  await expect(builder.getByRole('button', { name: 'Collapse step 1' })).toBeVisible();
  await choose(bare.getByLabel('Model'), 'Mock model');
  await expect(bare.getByText(refusal)).toHaveCount(0);
  await builder.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(builder.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.reload();
  await builder.getByRole('button', { name: 'Expand step 1' }).click();
  await expect(builder.getByRole('listitem', { name: 'Step 1' }).getByLabel('Model')).toContainText(
    'Mock model',
  );
  await expect(
    builder.getByText(
      'Step 2 was saved without a model, which Codex needs; Save stores mock-model-large.',
    ),
  ).toHaveCount(0);
});
