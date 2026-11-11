import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { e2eHome, e2eOutlookControlPort } from './env';
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
  await expect(page.getByRole('navigation', { name: 'Threads' })).toBeVisible();
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

    // Each update of the task list is a marker; the latest is pinned above the composer.
    await expect(items.getByTestId('task-marker')).toHaveText('Updated tasks (1/2)');
    await expect(page.getByTestId('task-pin-line')).toHaveText('1/2 · Answer it');
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

  test('draws the tool calls of a turn as one row that opens to all of them', async ({ page }) => {
    await startThread(page, 'Look around the repo');
    await expect(conversation(page).getByText('The repo holds a kettle.')).toBeVisible();
    const group = conversation(page).getByTestId('item-tool_group');
    await expect(group).toHaveCount(1);
    const row = group.locator(':scope > details > summary');
    // Closed, the row says what was done and the failure without opening. These calls carry no
    // tool kind, as calls stored before kinds, so they count as tools.
    await expect(group.getByTestId('tool-group-summary')).toHaveText('Used 3 tools · 1 failed');
    await expect(group.getByTestId('tool-group-failed')).toHaveText('1 failed');
    await expect(conversation(page).getByTestId('item-tool_call')).toHaveCount(0);

    // The row is reached from the keyboard and opens with Enter, listing every call in order.
    await row.focus();
    await page.keyboard.press('Enter');
    const calls = group.getByTestId('item-tool_call');
    await expect(calls).toHaveCount(3);
    await expect(calls.nth(0)).toContainText('package.json');
    await expect(calls.nth(1)).toContainText('Grep');
    await expect(calls.nth(1)).toContainText('error');
    await expect(calls.nth(2)).toContainText('README.md');
    await calls.nth(1).locator('summary').click();
    await expect(calls.nth(1).getByRole('region', { name: 'Tool output' })).toContainText(
      'Grep grep-1 answered',
    );
    await row.focus();
    await page.keyboard.press('Space');
    await expect(calls).toHaveCount(0);
  });

  test('reads commands, reads and MCP calls as rows with exit code and time', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.clock.install();
    await startThread(page, 'Run the tools');
    const items = conversation(page);
    const group = items.getByTestId('item-tool_group');
    const row = group.locator(':scope > details > summary');
    // While the turn runs, the group draws its latest call with its time counting up from the
    // start the server stored (spec 30, 91).
    await expect(row.getByTestId('tool-command')).toHaveText('$ pnpm dev');
    const time = row.getByTestId('tool-time');
    const startedAt = await time.getAttribute('data-started-at');
    expect(startedAt).toMatch(/^\d{4}-/);
    await page.clock.pauseAt(Date.parse(startedAt ?? '') + 10_000);
    await expect(time).toHaveText('running · 10 s');
    await page.clock.runFor(5000);
    await expect(time).toHaveText('running · 15 s');
    await page.reload();
    await expect(row.getByTestId('tool-time')).toHaveAttribute('data-started-at', startedAt ?? '');

    // The task list is pinned above the composer and Ctrl+T opens it (spec 31).
    await expect(items.getByTestId('task-marker')).toHaveText('Updated tasks (3/7)');
    await expect(page.getByTestId('task-pin-line')).toHaveText('3/7 · Running the tests');
    await page.getByRole('combobox', { name: 'Message' }).focus();
    await page.keyboard.press('Control+t');
    await expect(page.getByRole('region', { name: 'Pinned tasks' })).toContainText(
      'Write the summary',
    );
    await page.keyboard.press('Control+t');
    await expect(page.getByRole('region', { name: 'Pinned tasks' })).toBeHidden();

    // Each call is its own row: the command with its folder, exit code and time, the read as one
    // line, the MCP call as server › tool with its arguments (spec 27 to 29).
    await row.click();
    const calls = group.getByTestId('item-tool_call');
    await expect(calls).toHaveCount(4);
    const failing = calls.nth(0);
    await expect(failing.getByTestId('tool-command')).toHaveText('$ pnpm test');
    await expect(failing.getByTestId('tool-folder')).toHaveText(/^in .*[\\/]app$/);
    await expect(failing.getByTestId('tool-time')).toHaveText('exit 1 · 4.2 s');
    await expect(calls.nth(1).getByTestId('tool-line')).toHaveText('Read README.md lines 1-80');
    await expect(calls.nth(2).getByTestId('tool-mcp')).toHaveText('tracker › find_issue');
    await expect(calls.nth(2).getByTestId('tool-arguments')).toHaveText(
      'key: DEMO-42 · fields: ["status"]',
    );

    // Opened, the command shows its last lines, all of them on request, and Copy (spec 32).
    await failing.locator('summary').click();
    await expect(failing.getByTestId('tool-output-text')).toContainText('expected 2 rings');
    await expect(failing.getByTestId('tool-output-text')).not.toContainText('kettle test 5 passed');
    await failing.getByRole('button', { name: 'Show all 25 lines' }).click();
    await expect(failing.getByTestId('tool-output-text')).toContainText('kettle test 5 passed');
    await failing.getByRole('button', { name: 'Copy output' }).click();
    expect(await page.evaluate('navigator.clipboard.readText()')).toMatch(
      /^kettle test 1 passed\n[\s\S]*expected 2 rings, got 1\n$/,
    );

    // Stopped, the group says what was done and the turn ends with its line (spec 89, 91).
    await page.getByRole('combobox', { name: 'Message' }).focus();
    await page.keyboard.press('Control+.');
    await expect(group.getByTestId('tool-group-summary')).toHaveText(
      'Ran 2 commands, read 1 file, used 1 tool · 1 failed',
    );
    await expect(items.getByTestId('turn-stopped')).toContainText('Stopped by you');
    await expect(
      items.getByTestId('turn-stopped').getByRole('button', { name: 'Resume' }),
    ).toBeVisible();
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
    await expect(question.getByRole('radio', { name: /Red/ })).toBeVisible();
    await question.getByRole('textbox', { name: 'Other' }).fill('Green, please');
    await question.getByRole('textbox', { name: 'Other' }).press('Enter');
    await expect(question).toContainText('Answered: Green, please');
    await expect(conversation(page).getByText('You chose Green, please.')).toBeVisible();
  });

  test('answers a question with an option', async ({ page }) => {
    await startThread(page, 'Ask me a question');
    const question = conversation(page).getByRole('region', { name: 'Question' });
    await expect(question).toContainText('Which color should the button be?');
    await question.getByRole('radio', { name: /Blue/ }).click();
    await question.getByRole('button', { name: 'Send answer' }).click();
    await expect(question).toContainText('Answered: Blue');
    await expect(conversation(page).getByText('You chose Blue.')).toBeVisible();
  });

  test('picks a skill with a slash, sees the chip, sends it and sees the chip in the thread', async ({
    page,
  }) => {
    await page.goto('/chat/new');
    // A folder that is not a project: "Another folder…" asks for the path in the browser build.
    await choose(page.getByLabel('Project'), 'Another folder…');
    await page.getByLabel('Folder').fill(e2eHome);
    await page.getByLabel('Folder').press('Enter');
    await expect(page.getByTestId('new-thread-folder')).toContainText('wow-e2e-home');
    const composer = page.getByRole('combobox', { name: 'Message' });
    await expect(composer).toBeFocused();
    const skills = page.getByRole('listbox', { name: 'Skills' });
    // A slash inside a path or a date is text (wow skills spec 19), and $ opens nothing now.
    await composer.pressSequentially('look at src/app from 2026/11/12 $che ');
    await expect(skills).toBeHidden();
    await composer.fill('');
    await composer.pressSequentially('/');
    await expect(skills.getByRole('group', { name: 'wow' })).toBeVisible();
    await expect(skills.getByRole('group', { name: 'User' })).toBeVisible();
    await composer.pressSequentially('deli');
    // A name match ranks above a description match ("Review delivered work").
    await expect(skills.getByRole('option')).toHaveText([
      /^deliver-work\/deliver-work.*Deliver one unit/,
      /^check-work/,
    ]);
    await composer.press('Enter');
    await expect(skills).toBeHidden();
    await composer.pressSequentially('/hand');
    await composer.press('Enter');
    const picked = page.getByRole('list', { name: 'Picked skills' });
    await expect(picked.getByRole('listitem')).toHaveText(['deliver-work', 'wow-handover']);
    await expect(composer).toHaveValue('');
    // Backspace directly after the chips takes the last one away whole.
    await composer.press('Backspace');
    await expect(picked.getByRole('listitem')).toHaveText(['deliver-work']);
    await composer.pressSequentially('/hand');
    await composer.press('Enter');
    await composer.pressSequentially('the login fix');
    await composer.press('Enter');
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
    const message = conversation(page).getByTestId('item-user');
    await expect(message.getByRole('list', { name: 'Sent with skills' })).toHaveText(
      'deliver-workwow-handover',
    );
    await expect(message).toContainText('the login fix');
    // The agent got the folder skill's invocation and the wow skill's text (wow skills U1); the
    // mock agent says back what it was sent.
    const answer = conversation(page).getByTestId('item-assistant_text');
    await expect(answer).toContainText('End your final message with a short handover');
    await expect(answer).toContainText('You said: /deliver-work');
    await expect(answer).toContainText('the login fix');
    // The text is reachable from the chip, not shown in the conversation.
    await expect(message).not.toContainText('End your final message');
    await message.getByRole('button', { name: 'wow-handover, wow skill' }).click();
    await expect(page.getByRole('dialog', { name: 'Skill wow-handover' })).toContainText(
      'End your final message with a short handover',
    );
  });

  test('sends the Codex invocation of a chip on a Codex instance', async ({ page }) => {
    await page.goto('/chat/new');
    await choose(page.getByLabel('Provider instance'), 'Mock Codex');
    await choose(page.getByLabel('Project'), 'Demo');
    const composer = page.getByRole('combobox', { name: 'Message' });
    await composer.pressSequentially('/check');
    const skills = page.getByRole('listbox', { name: 'Skills' });
    await expect(skills.getByRole('option').first()).toHaveText(/^check-work\$check-work/);
    await composer.press('Enter');
    await expect(page.getByRole('list', { name: 'Picked skills' })).toHaveText('check-work');
    await composer.pressSequentially('the release');
    await composer.press('Enter');
    const message = conversation(page).getByTestId('item-user');
    await expect(message.getByRole('button', { name: 'check-work, User skill' })).toBeVisible();
    await expect(conversation(page).getByTestId('item-assistant_text')).toContainText(
      'You said: $check-work the release',
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
    await expect(conversation(page).getByTestId('turn-stopped')).toContainText(
      /^Stopped by you · \d{2}:\d{2}/,
    );

    await page.reload();
    await expect(conversation(page).getByText('Working on it')).toBeVisible();
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(
      conversation(page).getByText(/^Resumed mock-session-[0-9a-f]{8}\. You said: Continue/),
    ).toBeVisible();
  });

  // Owner report (findings Q): Claude Code goes on by itself when its background agent ends, and
  // the reply shows without the user writing anything.
  test('shows the turn the agent starts by itself when its background work ends', async ({
    page,
  }) => {
    await startThread(page, 'Count the tea leaves in the background');
    const items = conversation(page);
    await expect(items.getByTestId('item-assistant_text')).toHaveText(
      'I asked a background agent to count them.',
    );
    await expect(page.getByTestId('background-work')).toHaveText(
      'Waiting for background work: Count the tea leaves',
    );
    const done = await fetch(`http://127.0.0.1:${e2eOutlookControlPort}/background-done`, {
      method: 'PUT',
    });
    expect(done.status).toBe(200);
    await expect(items.getByTestId('item-assistant_text')).toHaveText([
      'I asked a background agent to count them.',
      'The background agent counted 42 leaves.',
    ]);
    await expect(items.getByTestId('item-user')).toHaveCount(1);
    await expect(page.getByTestId('background-work')).toBeHidden();
    await expect(items.getByLabel('Turn usage')).toHaveCount(2);
    const idle = threadList(page).getByRole('region', { name: 'Idle' });
    await expect(idle.getByRole('link', { name: /Count the tea leaves/ })).toBeVisible();
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

  // Agent workbench U2 (spec 64, 65): the server stores the notification; the window showing
  // the thread keeps quiet, another window shows it and its Open goes to the thread.
  test('notifies when a chat thread needs you', async ({ page, context }) => {
    await page.goto('/chat');
    await expect(threadList(page)).toBeVisible();
    const other = await context.newPage();
    const info: unknown = JSON.parse(await readFile(path.join(e2eHome, 'server.json'), 'utf8'));
    await other.addInitScript((serverInfo) => {
      (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
    }, info);
    await startThread(other, 'Please approve the kettle check');
    await expect(
      conversation(other).getByRole('region', { name: 'Approval request' }),
    ).toContainText('pnpm test');

    const toast = page
      .getByRole('listitem')
      .filter({ hasText: 'Needs you: Please approve the kettle check' });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('pnpm test');
    await expect(
      other.getByRole('listitem').filter({ hasText: 'Needs you: Please approve' }),
    ).toHaveCount(0);
    await toast.getByRole('button', { name: 'Open' }).click();
    await expect(
      page.getByRole('heading', { name: 'Please approve the kettle check' }),
    ).toBeVisible();
    await expect(
      conversation(page).getByRole('region', { name: 'Approval request' }),
    ).toContainText('pnpm test');
    await other.close();
  });

  // Agent workbench U2 (spec 66 to 70).
  test('filters, renames, archives and marks unread', async ({ page }) => {
    await startThread(page, 'Count the kettle whistles');
    const composer = page.getByRole('combobox', { name: 'Message' });
    await expect(conversation(page).getByText('You said: Count the kettle whistles')).toBeVisible();
    await composer.fill('The teapot hums in a minor key');
    await composer.press('Enter');
    await expect(conversation(page).getByText('You said: The teapot hums')).toBeVisible();

    // A word only in a message finds the thread; Ctrl+Shift+F focuses the filter.
    await page.keyboard.press('Control+Shift+F');
    const filter = page.getByRole('searchbox', { name: 'Filter threads' });
    await expect(filter).toBeFocused();
    await filter.fill('teapot minor');
    const rows = threadList(page).getByRole('link', { name: /Count the kettle whistles/ });
    await expect(rows).toHaveCount(1);
    await expect(threadList(page).locator('[data-thread-row]')).toHaveCount(1);
    await filter.fill('Demo kettle whistles');
    await expect(rows).toHaveCount(1);
    await filter.fill('');

    // `/` from the list goes back to the filter; arrows move and Enter opens.
    await page.goto('/chat');
    await threadList(page).locator('[data-thread-row]').first().focus();
    await page.keyboard.press('/');
    await expect(filter).toBeFocused();
    await filter.fill('kettle whistles');
    await page.keyboard.press('ArrowDown');
    await expect(rows).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Count the kettle whistles' })).toBeVisible();
    await filter.fill('');

    // F2 renames, even from the composer; the title changes in the list, header and palette.
    await composer.focus();
    await page.keyboard.press('F2');
    const title = page.getByRole('textbox', { name: 'Thread title' });
    await expect(title).toBeFocused();
    await title.fill('Kettle whistle census');
    await title.press('Enter');
    await expect(page.getByRole('heading', { name: 'Kettle whistle census' })).toBeVisible();
    const renamed = threadList(page).getByRole('link', { name: /Kettle whistle census/ });
    await expect(renamed).toBeVisible();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await palette.getByRole('combobox').fill('whistle census');
    await expect(palette.getByRole('option', { name: /Kettle whistle census/ })).toBeVisible();
    // The palette finds it by words only in a message too.
    await palette.getByRole('combobox').fill('teapot minor');
    await expect(palette.getByRole('option', { name: /Kettle whistle census/ })).toBeVisible();
    await palette.getByRole('combobox').fill('archive thread');
    await page.keyboard.press('Enter');

    // Archived: gone from the list, found by the filter and the palette, and back again.
    await expect(renamed).toHaveCount(0);
    await expect(page.getByTestId('thread-archived')).toHaveText('Archived');
    await filter.fill('census');
    await expect(renamed).toContainText('Archived');
    await filter.fill('');
    await page.keyboard.press('Control+k');
    await palette.getByRole('combobox').fill('whistle census');
    await expect(palette.getByRole('option', { name: /Kettle whistle census/ })).toContainText(
      'Archived',
    );
    await palette.getByRole('combobox').fill('unarchive thread');
    await page.keyboard.press('Enter');
    await expect(renamed).toBeVisible();

    // A turn that ends while the window is away leaves the thread bold until it is opened.
    await composer.fill('Wait for the kettle');
    await composer.press('Enter');
    await expect(page.getByTestId('thread-state')).toHaveText('Working');
    // The window loses the focus, as when the user switches to another program.
    await page.evaluate("window.dispatchEvent(new Event('blur'))");
    await page.keyboard.press('Control+.');
    await expect(page.getByTestId('thread-state')).toHaveText('Idle');
    await expect(renamed.getByTestId('thread-unread')).toBeVisible();
    await page.goto('/chat');
    await expect(renamed.getByTestId('thread-unread')).toBeVisible();
    await expect(renamed.getByTestId('thread-row-title')).toHaveCSS('font-weight', '600');
    await page.keyboard.press('Alt+Shift+ArrowDown');
    await expect(page.getByRole('heading', { name: 'Kettle whistle census' })).toBeVisible();
    await expect(renamed.getByTestId('thread-unread')).toHaveCount(0);

    await page.keyboard.press('Control+k');
    await palette.getByRole('combobox').fill('mark unread');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/chat$/);
    await expect(renamed.getByTestId('thread-unread')).toBeVisible();
    // Opening it again reads it.
    await renamed.click();
    await expect(page.getByRole('heading', { name: 'Kettle whistle census' })).toBeVisible();
    await expect(renamed.getByTestId('thread-unread')).toHaveCount(0);
  });

  test('finds threads and actions in the palette', async ({ page }) => {
    await startThread(page, 'Palette target');
    await page.goto('/chat');
    await expect(page.getByRole('navigation', { name: 'Threads' })).toBeVisible();
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

  test('thread-list', async ({ page }) => {
    await startThread(page, 'Descale the kettle');
    await expect(conversation(page).getByText('You said: Descale the kettle')).toBeVisible();
    await startThread(page, 'Sketch the tea timer screen');
    await expect(conversation(page).getByText('You said: Sketch the tea timer')).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog').getByRole('combobox').fill('mark unread');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/chat$/);
    await expect(
      threadList(page)
        .getByRole('link', { name: /Sketch the tea timer screen/ })
        .getByTestId('thread-unread'),
    ).toBeVisible();
    await expect(threadList(page).getByRole('link', { name: /Descale the kettle/ })).toBeVisible();
    await page.keyboard.press('Control+Shift+F');
    await page.screenshot({ path: sketchPath('2026-11-agent-workbench', 'thread-list') });
  });

  test('tool-rows', async ({ page }) => {
    await startThread(page, 'Run the tools');
    const group = conversation(page).getByTestId('item-tool_group');
    await expect(
      group.locator(':scope > details > summary').getByTestId('tool-command'),
    ).toHaveText('$ pnpm dev');
    await group.locator(':scope > details > summary').click();
    const failing = group.getByTestId('item-tool_call').nth(0);
    await failing.locator('summary').click();
    await expect(failing.getByTestId('tool-output-text')).toContainText('expected 2 rings');
    await page.getByRole('combobox', { name: 'Message' }).focus();
    await page.keyboard.press('Control+t');
    await expect(page.getByRole('region', { name: 'Pinned tasks' })).toBeVisible();
    await page.screenshot({ path: sketchPath('2026-11-agent-workbench', 'tool-rows') });
    await page.keyboard.press('Control+.');
    await expect(conversation(page).getByTestId('turn-stopped')).toBeVisible();
  });

  test('skill-chip', async ({ page }) => {
    await page.goto('/chat/new');
    await choose(page.getByLabel('Project'), 'Demo');
    const composer = page.getByRole('combobox', { name: 'Message' });
    await composer.pressSequentially('/deli');
    await composer.press('Enter');
    await composer.pressSequentially('/hand');
    await composer.press('Enter');
    await composer.pressSequentially('Ship the timer screen');
    await composer.press('Enter');
    const answer = conversation(page).getByTestId('item-assistant_text');
    await expect(answer).toContainText('End your final message');
    await composer.pressSequentially('/verd');
    await composer.press('Enter');
    await composer.pressSequentially('and then /ch');
    await expect(page.getByRole('listbox', { name: 'Skills' }).getByRole('option')).not.toHaveCount(
      0,
    );
    await page.screenshot({ path: sketchPath('2026-11-wow-skills', 'skill-chip') });
  });
});
