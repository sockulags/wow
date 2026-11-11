import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { choose } from './controls';
import { e2eAssistantHome, e2eHome } from './env';
import { sketchPath, sketching, sketchUse } from './sketch';

// Questions-and-models U1 ground truth: the question card in a chat thread against the scripted
// mock provider (e2e/server.ts), and in the Assistant view against the mock agent that calls
// wow's tools (e2e/assistant-agent.ts). The Assistant view has one conversation per install, so
// this file shares a worker with e2e/assistant.spec.ts (playwright.config.ts) and its cases run
// in order.
test.describe.configure({ mode: 'serial' });

if (sketching) test.use(sketchUse);

const intent = '2026-11-questions-and-models';
// Invented, in the form of a GitLab token, so the check before send holds it.
const lookalike = 'glpat-InventedE2eQuestion0123456789';

async function serverInfo(page: Page, home: string) {
  // What the desktop preload injects: the contents of `~/.wow/server.json`.
  const info: unknown = JSON.parse(await readFile(path.join(home, 'server.json'), 'utf8'));
  await page.addInitScript((value) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = value;
  }, info);
}

const conversation = (page: Page) => page.getByRole('list', { name: 'Conversation' });
const composer = (page: Page) => page.getByRole('combobox', { name: 'Message' });

async function startThread(page: Page, message: string) {
  await page.goto('/chat');
  await expect(page.getByRole('navigation', { name: 'Threads' })).toBeVisible();
  await page.keyboard.press('Control+Alt+N');
  await expect(page).toHaveURL(/\/chat\/new$/);
  await expect(composer(page)).toBeFocused();
  await choose(page.getByLabel('Project'), 'Demo');
  await expect(page.getByLabel('Model')).toContainText('Mock model');
  await composer(page).fill(message);
  await composer(page).press('Enter');
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
}

test.describe('the question card in a chat thread', () => {
  test.beforeEach(({ page }) => serverInfo(page, e2eHome));

  test('answer a question with a choice and with text in a chat thread @questions-1 @questions-2 @questions-3 @questions-4 @questions-6 @questions-7', async ({
    page,
  }) => {
    await startThread(page, 'Ask me two questions');
    const card = conversation(page).getByRole('region', { name: 'Questions' });
    await expect(card.getByTestId('question-header')).toHaveText(['Kettle', 'Teas']);
    const kettle = card.getByRole('radiogroup', {
      name: 'Which kettle should the tea timer start?',
    });
    const teas = card.getByRole('group', { name: 'Which teas go on the timer list?' });
    // The recommended choice first and marked, "Other" last with its field.
    await expect(kettle.getByRole('radio').first()).toContainText('Steel kettleRecommended');
    await expect(kettle.getByRole('textbox', { name: 'Other' })).toBeVisible();
    await expect(teas.getByRole('checkbox')).toHaveCount(3);
    // The thread waits for the user, and an empty answer cannot be sent.
    await expect(page.getByTestId('thread-state')).toHaveText('Needs you');
    const send = card.getByRole('button', { name: 'Send answers' });
    await expect(send).toBeDisabled();

    // From the keyboard: the card's key puts the keyboard on the first choice, a digit picks.
    await page.keyboard.press('Alt+q');
    await expect(kettle.getByRole('radio').first()).toBeFocused();
    await page.keyboard.press('2');
    await expect(kettle.getByRole('radio', { name: /Glass kettle/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Several picks where several are asked, and typed text beside them.
    await teas.getByRole('checkbox', { name: /Green/ }).click();
    await teas.getByRole('checkbox', { name: /Oolong/ }).click();
    await teas.getByRole('checkbox', { name: /Oolong/ }).press('ArrowDown');
    await page.keyboard.type('rooibos');
    await expect(teas.getByRole('textbox', { name: 'Other' })).toHaveValue('rooibos');
    await expect(send).toBeEnabled();
    if (sketching) await card.screenshot({ path: sketchPath(intent, 'question') });
    await page.keyboard.press('Enter');

    // Both went together; the provider got each answer as it expects.
    await expect(
      conversation(page).getByText('You chose Glass kettle and Green, Oolong, rooibos.'),
    ).toBeVisible();
    await expect(card.getByTestId('question-answer')).toHaveText([
      'Answered: Glass kettle',
      'Answered: Green, Oolong, rooibos',
    ]);
    await expect(card.getByRole('radio')).toHaveCount(0);
    await expect(page.getByTestId('thread-state')).toHaveText('Idle');
  });

  test('a question whose turn was stopped says it was not answered and takes no answer @questions-5', async ({
    page,
  }) => {
    await startThread(page, 'Ask me a question');
    const card = conversation(page).getByRole('region', { name: 'Question' });
    await expect(card.getByTestId('question-header')).toHaveText('Color');
    await card.getByRole('radio', { name: /Red/ }).click();
    await page.keyboard.press('Control+.');
    await expect(card.getByTestId('question-closed')).toHaveText(
      'Not answered: the turn ended before an answer was sent.',
    );
    await expect(card.getByRole('radio')).toHaveCount(0);
    await expect(card.getByRole('textbox')).toHaveCount(0);
    await expect(card.getByRole('button')).toHaveCount(0);
    await page.reload();
    await expect(
      conversation(page).getByRole('region', { name: 'Question' }).getByTestId('question-closed'),
    ).toBeVisible();
  });
});

// Sends a message and waits for the turn's answer, the last row after the message.
async function say(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
  await expect(conversation(page).getByTestId('item-user').filter({ hasText: text })).toBeVisible();
  await expect(conversation(page).locator(':scope > li').last()).toHaveAttribute(
    'data-testid',
    'item-assistant_text',
  );
}

test.describe('the question card in the Assistant view', () => {
  test.beforeEach(({ page }) => serverInfo(page, e2eAssistantHome));

  test('answer a question with a choice and with text in the Assistant view @questions-9', async ({
    page,
  }) => {
    await page.goto('/assistant');
    await expect(composer(page)).toBeFocused();
    await say(page, 'Set up my morning brief');
    const card = conversation(page).getByRole('region', { name: 'Questions' }).last();
    await expect(card.getByTestId('question-header')).toHaveText(['Time', 'Projects']);
    // The assistant's turn ended at the card.
    await expect(conversation(page).getByText('Two things first')).toBeVisible();
    await card.getByRole('radio', { name: /08:30/ }).click();
    await card.getByRole('checkbox', { name: /Demo/ }).click();
    await card
      .getByRole('group', { name: 'Which projects should it read?' })
      .getByRole('textbox', { name: 'Other' })
      .fill('and the garden plan');
    await card.getByRole('button', { name: 'Send answers' }).click();

    // The answer is the next message, marked as the answer.
    const reply = conversation(page).getByTestId('item-assistant_text').last();
    await expect(reply).toContainText('Thanks. You answered:');
    await expect(reply).toContainText('When should the morning brief run? (Time): picked 08:30');
    await expect(reply).toContainText(
      'Which projects should it read? (Projects): picked Demo; typed "and the garden plan"',
    );
    await expect(card.getByTestId('question-answer')).toHaveText([
      'Answered: 08:30',
      'Answered: Demo, and the garden plan',
    ]);
    await expect(conversation(page).getByTestId('answered-note').last()).toHaveText(
      'Answered the questions above.',
    );
  });

  test('a typed answer that looks like a secret is held, and a message instead closes the card @questions-10 @questions-5', async ({
    page,
  }) => {
    await page.goto('/assistant');
    await say(page, 'Plan my morning brief again');
    const card = conversation(page).getByRole('region', { name: 'Questions' }).last();
    const other = card
      .getByRole('radiogroup', { name: 'When should the morning brief run?' })
      .getByRole('textbox', { name: 'Other' });
    await other.fill(`use ${lookalike}`);
    await card.getByRole('checkbox', { name: /Tea timer/ }).click();
    await other.press('Enter');
    const held = card.getByTestId('held-message');
    await expect(held).toContainText('Send anyway');
    await held.getByRole('button', { name: 'Keep editing' }).click();
    await expect(held).toHaveCount(0);
    await expect(conversation(page).getByText(lookalike)).toHaveCount(0);

    await say(page, 'Never mind the brief');
    await expect(card.getByTestId('question-closed')).toHaveText([
      'Not answered: a message was sent before an answer.',
      'Not answered: a message was sent before an answer.',
    ]);
    await expect(card.getByRole('textbox')).toHaveCount(0);
  });

  test('a question that asks for a token is refused, pointing to the secret field @questions-11', async ({
    page,
  }) => {
    await page.goto('/assistant');
    await say(page, 'Ask me for the token, please');
    await expect(conversation(page).getByTestId('item-assistant_text').last()).toContainText(
      'wow refused that question: A question never asks for a secret',
    );
    await expect(conversation(page).getByTestId('item-assistant_text').last()).toContainText(
      'show its field with show_secret_field',
    );
  });
});
