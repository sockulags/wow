import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { e2eHome } from './env';
import { choose } from './controls';
import { sketchPath, sketching, sketchUse } from './sketch';

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
  const composer = page.getByRole('combobox', { name: 'Message' });
  // The work starts in the composer (audit A-11).
  await expect(composer).toBeFocused();
  await choose(page.getByLabel('Project'), 'Demo');
  await expect(page.getByLabel('Model')).toContainText('Mock model');
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
    // The message, then its time (shown on hover).
    await expect(items.getByTestId('item-user')).toHaveText(/^Hello there\d{2}:\d{2}$/);

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

  test('chat renders a table and a diagram @review-loop-1 @review-loop-2', async ({ page }) => {
    await startThread(page, 'Show a table and a diagram');
    const answer = conversation(page).getByTestId('item-assistant_text');
    await expect(answer.getByRole('heading', { name: 'Review of the login change' })).toBeVisible();
    await expect(
      answer.getByRole('listitem').filter({ hasText: /^unit tests pass$/ }),
    ).toBeVisible();
    await expect(answer.getByRole('columnheader')).toHaveText(['File', 'Added', 'Removed']);
    await expect(answer.getByRole('cell', { name: 'src/login.test.ts' })).toBeVisible();
    await expect(answer.locator('.wow-code .shiki')).toContainText('export const retries = 3;');

    // Only the https and mailto links are links; they open outside the app.
    await expect(answer.getByRole('link')).toHaveCount(2);
    const guide = answer.getByRole('link', { name: 'the guide' });
    await expect(guide).toHaveAttribute('href', 'https://docs.example.test/login');
    await expect(guide).toHaveAttribute('target', '_blank');
    const team = answer.getByRole('link', { name: 'the team' });
    await expect(team).toHaveAttribute('href', 'mailto:team@example.test');
    await expect(team).toHaveAttribute('target', '_blank');
    await expect(answer.getByText('here', { exact: true })).toBeVisible();

    // The valid block is drawn by the real library; the invalid one shows its source and why.
    const diagram = answer.getByRole('img', { name: 'Diagram' });
    await expect(diagram.locator('svg')).toBeVisible();
    await expect(diagram).toContainText('Review');
    await expect(answer.getByRole('note')).toHaveText(/^Diagram not drawn: \S.*$/);
    await expect(answer.getByRole('img', { name: 'Diagram' })).toHaveCount(1);

    const source = answer.getByRole('button', { name: 'Source' });
    await source.click();
    await expect(diagram).toBeHidden();
    await expect(answer.getByText('Review -->|send back| Build')).toBeVisible();
    await source.click();
    await expect(diagram.locator('svg')).toBeVisible();

    // The palette switches every diagram to its source and back.
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').getByRole('combobox').fill('toggle diagram source');
    await page.keyboard.press('Enter');
    await expect(source).toHaveAttribute('aria-pressed', 'true');
  });

  test('a diagram fetches nothing from another host @review-loop-2', async ({ page }) => {
    const asked: string[] = [];
    await page.route('https://elsewhere.example.test/**', (route) => {
      asked.push(new URL(route.request().url()).pathname);
      return route.abort();
    });
    await startThread(page, 'Draw a diagram that reaches out');
    const answer = conversation(page).getByTestId('item-assistant_text');
    const diagram = answer.getByRole('img', { name: 'Diagram' });
    await expect(diagram.locator('svg')).toBeVisible();
    await expect(diagram).toContainText('Build');
    await expect(diagram.locator('img, image')).toHaveCount(0);
    // The library fetches an image shape, and a picture named in a class of a state diagram,
    // while it draws, so those are not drawn at all, and neither is one that brings its own CSS.
    await expect(answer.getByRole('note')).toHaveText([
      'Diagram not drawn: Image shapes are not drawn',
      'Diagram not drawn: Styles that load something are not drawn',
      'Diagram not drawn: Styles that load something are not drawn',
    ]);

    // A diagram's link follows the link rule: it opens outside the app.
    const link = diagram.locator('a');
    await expect(link).toHaveAttribute('href', 'https://elsewhere.example.test/build');
    await expect(link).toHaveAttribute('target', '_blank');

    // Whatever gets past those checks is stopped by the page's content security policy.
    const picture = 'https://elsewhere.example.test/policy.png';
    const blocked = await page.evaluate((address) => {
      const { document } = globalThis as unknown as {
        document: {
          addEventListener(type: string, heard: (event: { blockedURI: string }) => void): void;
          body: { insertAdjacentHTML(where: string, html: string): void };
        };
      };
      return new Promise<string>((resolve) => {
        document.addEventListener('securitypolicyviolation', (event) => resolve(event.blockedURI));
        document.body.insertAdjacentHTML('beforeend', `<img src="${address}" alt="">`);
      });
    }, picture);
    expect(blocked).toBe(picture);

    // Requests reach the route in order, so one made now comes after any the diagrams made.
    await page.evaluate(() => fetch('https://elsewhere.example.test/last').catch(() => undefined));
    expect(asked).toEqual(['/last']);
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

    // The request says where it runs, takes the focus, and the running tool waits for it.
    await expect(approval.getByTestId('approval-context')).toContainText('Ask for permissions');
    await expect(conversation(page).getByTestId('item-tool_call')).toContainText(
      'waiting for approval',
    );
    await expect(page.getByRole('combobox', { name: 'Message' })).toHaveAttribute(
      'placeholder',
      'Answer the request above',
    );
    await expect(approval).toBeFocused();
    // A answers "Allow once" (keybindings.approvalAllowOnce).
    await page.keyboard.press('a');
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
    // A folder that is not a project: "Another folder…" asks for the path in the browser build.
    await choose(page.getByLabel('Project'), 'Another folder…');
    await page.getByLabel('Folder').fill(e2eHome);
    await page.getByLabel('Folder').press('Enter');
    await expect(page.getByTestId('new-thread-folder')).toContainText('wow-e2e-home');
    const composer = page.getByRole('combobox', { name: 'Message' });
    await expect(composer).toBeFocused();
    await composer.pressSequentially('$deli');
    const skills = page.getByRole('listbox', { name: 'Skills' });
    // A name match ranks above a description match ("Review delivered work").
    await expect(skills.getByRole('option')).toHaveText([
      /^deliver-work\/deliver-work.*Deliver one unit/,
      /^check-work/,
    ]);
    // Grouped by where the skill comes from, with the source on each row.
    await expect(skills.getByRole('group', { name: 'User' })).toBeVisible();
    await composer.press('Enter');
    await expect(skills).toBeHidden();
    await expect(composer).toHaveValue('/deliver-work ');
    await composer.pressSequentially('the login fix');
    await composer.press('Enter');
    await expect(conversation(page).getByTestId('item-user')).toHaveText(
      /^\/deliver-work the login fix\d{2}:\d{2}$/,
    );
  });

  test('inserts the Codex invocation form on a Codex instance', async ({ page }) => {
    await page.goto('/chat/new');
    await choose(page.getByLabel('Provider instance'), 'Mock Codex');
    await choose(page.getByLabel('Project'), 'Demo');
    const composer = page.getByRole('combobox', { name: 'Message' });
    await composer.pressSequentially('$check');
    const skills = page.getByRole('listbox', { name: 'Skills' });
    await expect(skills.getByRole('option').first()).toHaveText(/^check-work\$check-work/);
    await composer.press('Enter');
    await expect(composer).toHaveValue('$check-work ');
    await composer.pressSequentially('the release');
    await composer.press('Enter');
    await expect(conversation(page).getByTestId('item-user')).toHaveText(
      /^\$check-work the release\d{2}:\d{2}$/,
    );
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

  test('queues a message written during a turn and sends it with Send now', async ({ page }) => {
    await startThread(page, 'Wait for me');
    await expect(page.getByTestId('thread-state')).toHaveText('Working');
    await expect(page.getByTestId('turn-elapsed')).toBeVisible();
    const composer = page.getByRole('combobox', { name: 'Message' });
    await composer.fill('Then summarise it');
    await composer.press('Enter');
    const queued = page.getByTestId('queued-message');
    await expect(queued).toContainText('Then summarise it');
    await queued.getByRole('button', { name: 'Send now' }).click();
    await expect(queued).toBeHidden();
    await expect(conversation(page).getByText('You said: Then summarise it')).toBeVisible();
  });

  test('a new thread starts from the last one (owner decision F-5)', async ({ page }) => {
    await startThread(page, 'Remember my settings');
    await page.keyboard.press('Control+Alt+N');
    await expect(page.getByLabel('Project')).toHaveText(/Demo/);
    await expect(page.getByLabel('Model')).toContainText('Mock model');
    await expect(page.getByRole('combobox', { name: 'Message' })).toBeFocused();
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

test.describe('sketch', () => {
  test.skip(!sketching, 'Set WOW_E2E_SKETCHES to write the screenshots');
  test.use(sketchUse);

  test('chat-markdown', async ({ page }) => {
    await startThread(page, 'Show a table and a diagram');
    const answer = conversation(page).getByTestId('item-assistant_text');
    await expect(answer.getByRole('img', { name: 'Diagram' }).locator('svg')).toBeVisible();
    await expect(answer.getByRole('note')).toBeVisible();
    await expect(answer.locator('.wow-code .shiki')).toBeVisible();
    await answer.getByRole('heading').scrollIntoViewIfNeeded();
    await page.screenshot({ path: sketchPath('2026-11-review-loop', 'chat-markdown') });
  });
});
