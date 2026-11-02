import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { e2eHome } from './env';
import { choose } from './controls';

// U8 ground truth against the scripted mock provider (e2e/server.ts): stream, approve, answer a
// question, pick a skill, stop, resume after reload.

test.beforeEach(async ({ page }) => {
  // What the desktop preload injects: the contents of `~/.wow/server.json`.
  const info: unknown = JSON.parse(await readFile(path.join(e2eHome, 'server.json'), 'utf8'));
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

async function startThread(page: Page, message: string) {
  await page.goto('/chat');
  await page.keyboard.press('Control+Alt+N');
  await expect(page).toHaveURL(/\/chat\/new$/);
  await choose(page.getByLabel('Project'), 'Demo');
  await expect(page.getByLabel('Model')).toHaveText('Mock model');
  const composer = page.getByRole('combobox', { name: 'Message' });
  await composer.fill(message);
  await composer.press('Enter');
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
}

const conversation = (page: Page) => page.getByRole('list', { name: 'Conversation' });
const threadList = (page: Page) => page.getByRole('navigation', { name: 'Threads' });

test.describe('chat', () => {
  test('streams a reply with reasoning, tool rows, tasks and usage', async ({ page }) => {
    await startThread(page, 'Hello there');
    const items = conversation(page);
    await expect(items.getByTestId('item-assistant_text')).toHaveText('You said: Hello there');
    await expect(items.getByTestId('item-user')).toHaveText('Hello there');

    const reasoning = items.getByTestId('item-reasoning');
    await expect(reasoning.getByText('The user said hello.')).toBeHidden();
    await reasoning.getByText('Reasoning').click();
    await expect(reasoning.getByText('The user said hello.')).toBeVisible();

    await expect(items.getByRole('region', { name: 'Tasks' })).toContainText('Answer it');
    await expect(items.getByLabel('Turn usage')).toHaveText(
      '1,200 in · 340 out · 800 cached · $0.01',
    );
    await expect(page.getByTestId('context-meter')).toHaveText('50,000 / 200,000 context (25%)');

    const idle = threadList(page).getByRole('region', { name: 'Idle' });
    await expect(idle.getByRole('link', { name: /Hello there/ })).toBeVisible();
    await page.getByRole('button', { name: 'Pin thread' }).click();
    await expect(
      idle.getByRole('link', { name: /Hello there/ }).getByLabel('Pinned'),
    ).toBeVisible();
    await expect(idle.getByRole('link').first()).toContainText('Hello there');
  });

  test('marks a thread done, reopens it, and a new message reopens it too', async ({ page }) => {
    await startThread(page, 'Wrap this up');
    await expect(conversation(page).getByTestId('item-assistant_text')).toHaveText(
      'You said: Wrap this up',
    );
    const done = threadList(page).getByRole('region', { name: 'Done' });
    const idle = threadList(page).getByRole('region', { name: 'Idle' });

    await page.getByRole('button', { name: 'Mark thread done' }).click();
    await expect(page.getByTestId('thread-state')).toHaveText('Done');
    await expect(done.getByRole('link', { name: /Wrap this up/ })).toBeVisible();

    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await palette.getByRole('combobox').fill('reopen thread');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('thread-state')).toHaveText('Idle');
    await expect(idle.getByRole('link', { name: /Wrap this up/ })).toBeVisible();

    await page.keyboard.press('Control+k');
    await palette.getByRole('combobox').fill('mark thread done');
    await page.keyboard.press('Enter');
    await expect(done.getByRole('link', { name: /Wrap this up/ })).toBeVisible();

    const composer = page.getByRole('combobox', { name: 'Message' });
    await composer.fill('One more thing');
    await composer.press('Enter');
    await expect(conversation(page).getByText('You said: One more thing')).toBeVisible();
    await expect(page.getByTestId('thread-state')).toHaveText('Idle');
    await expect(idle.getByRole('link', { name: /Wrap this up/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark thread done' })).toBeEnabled();
  });

  test('approves a command and the turn goes on', async ({ page }) => {
    await startThread(page, 'Please approve running the tests');
    const approval = conversation(page).getByRole('region', { name: 'Approval request' });
    await expect(approval).toContainText('pnpm test');
    await expect(
      threadList(page)
        .getByRole('region', { name: 'Needs you' })
        .getByRole('link', { name: /Please approve/ }),
    ).toBeVisible();
    await expect(page.getByTestId('thread-state')).toHaveText('Needs you');

    await approval.getByRole('button', { name: 'Allow once' }).click();
    await expect(approval).toContainText('Allowed once');
    await expect(conversation(page).getByText('The command ran.')).toBeVisible();
    await expect(page.getByTestId('thread-state')).toHaveText('Idle');

    const tool = conversation(page).getByTestId('item-tool_call');
    await expect(tool).toContainText('Bash');
    await expect(tool).toContainText('done');
    await tool.getByText('Bash').click();
    await expect(tool.getByRole('region', { name: 'Tool output' })).toContainText(
      'All 12 tests passed',
    );
  });

  test('denies a command and the provider hears it', async ({ page }) => {
    await startThread(page, 'Approve deleting the cache');
    const approval = conversation(page).getByRole('region', { name: 'Approval request' });
    await expect(approval.getByRole('button')).toHaveText([
      'Allow once',
      'Allow for this session',
      'Deny',
    ]);
    await approval.getByRole('button', { name: 'Deny' }).click();
    await expect(approval).toContainText('Denied');
    await expect(conversation(page).getByText('The command was denied.')).toBeVisible();
    await expect(conversation(page).getByTestId('item-tool_call')).toContainText('error');
  });

  test('allows a command for the session', async ({ page }) => {
    await startThread(page, 'Approve the build');
    const approval = conversation(page).getByRole('region', { name: 'Approval request' });
    await approval.getByRole('button', { name: 'Allow for this session' }).click();
    await expect(approval).toContainText('Allowed for this session');
    await expect(conversation(page).getByText('The command ran.')).toBeVisible();
  });

  test('answers a question with free text', async ({ page }) => {
    await startThread(page, 'Ask me another question');
    const question = conversation(page).getByRole('region', { name: 'Question' });
    await expect(question.getByRole('button', { name: 'Red' })).toBeVisible();
    await question.getByLabel('Your answer').fill('Green, please');
    await question.getByLabel('Your answer').press('Enter');
    await expect(question).toContainText('Answered: Green, please');
    await expect(conversation(page).getByText('You chose Green, please.')).toBeVisible();
  });

  test('answers a question with an option', async ({ page }) => {
    await startThread(page, 'Ask me a question');
    const question = conversation(page).getByRole('region', { name: 'Question' });
    await expect(question).toContainText('Which color should the button be?');
    await question.getByRole('button', { name: 'Blue' }).click();
    await expect(question).toContainText('Answered: Blue');
    await expect(conversation(page).getByText('You chose Blue.')).toBeVisible();
  });

  test('picks a skill with $ and sends its invocation', async ({ page }) => {
    await page.goto('/chat/new');
    await page.getByLabel('Working directory').fill(e2eHome);
    const composer = page.getByRole('combobox', { name: 'Message' });
    await composer.pressSequentially('$deli');
    const skills = page.getByRole('listbox', { name: 'Skills' });
    // A name match ranks above a description match ("Review delivered work").
    await expect(skills.getByRole('option')).toHaveText([
      /^deliver-work\/deliver-workDeliver one unit/,
      /^check-work/,
    ]);
    await composer.press('Enter');
    await expect(skills).toBeHidden();
    await expect(composer).toHaveValue('/deliver-work ');
    await composer.pressSequentially('the login fix');
    await composer.press('Enter');
    await expect(conversation(page).getByTestId('item-user')).toHaveText(
      '/deliver-work the login fix',
    );
  });

  test('inserts the Codex invocation form on a Codex instance', async ({ page }) => {
    await page.goto('/chat/new');
    await choose(page.getByLabel('Provider instance'), 'Mock Codex (codex)');
    await choose(page.getByLabel('Project'), 'Demo');
    const composer = page.getByRole('combobox', { name: 'Message' });
    await composer.pressSequentially('$check');
    const skills = page.getByRole('listbox', { name: 'Skills' });
    await expect(skills.getByRole('option').first()).toHaveText(/^check-work\$check-work/);
    await composer.press('Enter');
    await expect(composer).toHaveValue('$check-work ');
    await composer.pressSequentially('the release');
    await composer.press('Enter');
    await expect(conversation(page).getByTestId('item-user')).toHaveText('$check-work the release');
  });

  test('stops a running turn, keeps its output and resumes after a reload', async ({ page }) => {
    await startThread(page, 'Wait for me');
    await expect(conversation(page).getByText('Working on it')).toBeVisible();
    await expect(page.getByTestId('thread-state')).toHaveText('Working');
    await expect(
      threadList(page)
        .getByRole('region', { name: 'Working' })
        .getByRole('link', { name: /Wait for me/ }),
    ).toBeVisible();
    await page.keyboard.press('Control+.');
    await expect(page.getByTestId('thread-state')).toHaveText('Idle');
    await expect(conversation(page).getByText('Working on it')).toBeVisible();

    await page.reload();
    await expect(conversation(page).getByText('Working on it')).toBeVisible();
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(
      conversation(page).getByText(/^Resumed mock-session-[0-9a-f]{8}\. You said: Continue/),
    ).toBeVisible();
  });

  test('finds threads and actions in the palette', async ({ page }) => {
    await startThread(page, 'Palette target');
    await page.goto('/chat');
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await palette.getByRole('combobox').fill('palette target');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Palette target' })).toBeVisible();

    await page.keyboard.press('Control+k');
    await palette.getByRole('combobox').fill('new thread');
    await expect(palette.getByRole('option', { name: /New thread/ })).toBeVisible();
  });
});
