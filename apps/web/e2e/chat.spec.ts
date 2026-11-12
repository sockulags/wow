import { expect, test, type Page } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { e2eHome, e2eNeedsYouWorkflowId, e2eOutlookControlPort, e2eTrackerPort } from './env';
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
const messageBox = (page: Page) => page.getByRole('combobox', { name: 'Message' });

// A thread on the Claude instance: a new thread starts on the instance of the newest thread,
// which an earlier case may have put on Codex.
async function startClaudeThread(page: Page, message: string) {
  await page.goto('/chat/new');
  await choose(page.getByLabel('Provider instance'), 'Mock Claude');
  await choose(page.getByLabel('Project'), 'Demo');
  await expect(page.getByTestId('model-bar')).toBeVisible();
  await messageBox(page).fill(message);
  await messageBox(page).press('Enter');
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
}

// A Codex thread whose "wait" turn runs until `endWait` ends it.
async function startCodexWait(page: Page, message: string) {
  await page.goto('/chat/new');
  await choose(page.getByLabel('Provider instance'), 'Mock Codex');
  await choose(page.getByLabel('Project'), 'Demo');
  await expect(page.getByTestId('model-bar')).toBeVisible();
  await messageBox(page).fill(message);
  await messageBox(page).press('Enter');
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('thread-state')).toHaveText('Working');
}

// Ends the open thread's "wait" turn through the mock's control port (e2e/server.ts).
async function endWait(page: Page) {
  const threadId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  const done = await fetch(
    `http://127.0.0.1:${e2eOutlookControlPort}/turn-done?threadId=${threadId}`,
    { method: 'PUT' },
  );
  expect(done.status).toBe(200);
}

// Puts the open thread back on the mock's first model, the default effort and Ask, through the
// composer bar.
async function resetBar(page: Page) {
  const bar = page.getByTestId('model-bar');
  for (const [part, option] of [
    ['Model', /^Mock model$/],
    ['Effort', /^Default/],
    ['Permission mode', /^Ask for permissions/],
  ] as const) {
    await bar.getByRole('button', { name: part }).click();
    await page.getByRole('listbox', { name: part }).getByRole('option', { name: option }).click();
  }
  await expect(bar).toHaveText('Mock model·Default·Ask');
}

// An invented screenshot drawn in the page and pasted (Ctrl+V) or dropped on the composer, as the
// browser hands a file to it (agent workbench spec 53). The code is a string, since the e2e files
// are typed without the DOM.
async function addImage(page: Page, how: 'paste' | 'drop', name: string, hue: number) {
  await messageBox(page).waitFor();
  const failed = await page.evaluate(`(async () => {
    const box = document.querySelector('textarea[aria-label="Message"]');
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 200;
    const draw = canvas.getContext('2d');
    draw.fillStyle = 'hsl(${hue} 30% 92%)';
    draw.fillRect(0, 0, 320, 200);
    draw.fillStyle = 'hsl(${hue} 45% 40%)';
    draw.fillRect(0, 0, 320, 28);
    draw.fillStyle = 'hsl(${hue} 50% 60%)';
    draw.fillRect(20, 48, 180, 16);
    draw.fillRect(20, 76, 240, 16);
    draw.fillStyle = 'hsl(0 70% 55%)';
    draw.fillRect(20, 112, 120, 40);
    draw.fillStyle = 'white';
    draw.font = '16px sans-serif';
    draw.fillText('Invented', 34, 138);
    const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
    const file = new File([blob], ${JSON.stringify(name)}, { type: 'image/png' });
    const data = new DataTransfer();
    data.items.add(file);
    if (${JSON.stringify(how)} === 'paste') {
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    } else {
      box.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
      box.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }
    return blob === null ? 'The page drew no picture' : '';
  })()`);
  expect(failed).toBe('');
}

test.describe('chat', () => {
  test('streams a reply with reasoning, tool rows, tasks and usage', async ({ page }) => {
    await startThread(page, 'Hello there');
    const items = conversation(page);
    await expect(items.getByTestId('item-assistant_text')).toContainText('You said: Hello there');
    // The message, then its turn's start time.
    await expect(items.getByTestId('item-user')).toHaveText(/^Hello there\d{2}:\d{2}$/);

    const reasoning = items.getByTestId('item-reasoning');
    await expect(reasoning.getByText('The user said hello.')).toBeHidden();
    // Done reasoning reads how long it took (agent workbench spec 88).
    await expect(reasoning.getByTestId('reasoning-label')).toHaveText(/^Thought for \d+ s$/);
    await reasoning.getByTestId('reasoning-label').click();
    await expect(reasoning.getByText('The user said hello.')).toBeVisible();

    // Each update of the task list is a marker; the latest is pinned above the composer.
    await expect(items.getByTestId('task-marker')).toHaveText('Updated tasks (1/2)');
    await expect(page.getByTestId('task-pin-line')).toHaveText('1/2 · Answer it');
    await expect(items.getByLabel('Turn usage')).toHaveText(
      'Mock model · 1,200 in · 340 out · 800 cached · $0.01',
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
    await expect(conversation(page).getByTestId('item-assistant_text')).toContainText(
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
    // Windows hands the clipboard's text back with its own line ends.
    const copied = await page.evaluate<string>('navigator.clipboard.readText()');
    expect(copied.replaceAll('\r\n', '\n')).toMatch(
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
    // An empty note denies without one (agent workbench spec 37).
    await approval.getByTestId('approval-note').press('Enter');
    await expect(approval).toContainText('Denied');
    await expect(conversation(page).getByText('The command was denied.')).toBeVisible();
    await expect(conversation(page).getByTestId('item-tool_call')).toContainText('error');
  });

  test('approves an edit seen as a diff @agent-workbench-33 @agent-workbench-36', async ({
    page,
  }) => {
    await startClaudeThread(page, 'Edit the timer');
    const approval = conversation(page).getByRole('region', { name: 'Approval request' });
    await expect(approval.getByRole('table', { name: 'Diff of src/timer.ts' })).toBeVisible();
    await expect(
      approval.getByRole('table', { name: 'Diff of src/timer.ts' }).locator('tr[data-kind="add"]'),
    ).toHaveCount(1);
    // An edit has no rule of its own: Accept edits is for that (spec 38).
    await expect(
      approval.getByRole('button', { name: 'Always allow in this project' }),
    ).toHaveCount(0);
    await expect(approval).toBeFocused();
    await page.keyboard.press('a');
    await expect(approval.getByTestId('approval-decision')).toHaveText('Allowed once');
    await expect(conversation(page).getByText('The timer rings twice now.')).toBeVisible();
    const row = conversation(page).getByTestId('item-tool_call');
    await expect(row.getByTestId('tool-line')).toHaveText('Edit src/timer.ts');
    await expect(row.getByTestId('edit-counts')).toHaveText('+1 −0');
    await row.getByTestId('tool-line').click();
    await expect(row.getByRole('table', { name: 'Diff of src/timer.ts' })).toBeVisible();
    // Open file opens the edited file in a panel tab, Git or not (spec 17, 33).
    await row.getByRole('button', { name: 'Open file' }).click();
    const panel = page.getByRole('complementary', { name: 'Context panel' });
    await expect(panel.getByRole('tab', { name: 'timer.ts' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      panel.getByRole('region', { name: 'File viewer' }).getByTestId('viewer-path'),
    ).toHaveText('src/timer.ts');
    // Leave the panel closed for the cases after this one.
    await page.keyboard.press('Control+j');
    await expect(panel).toBeHidden();
  });

  test('denies with a note @agent-workbench-37', async ({ page }) => {
    // Claude Code hears the note as the denial's message.
    await startClaudeThread(page, 'Approve deleting the cache');
    const approval = conversation(page).getByRole('region', { name: 'Approval request' });
    await expect(approval).toBeFocused();
    await page.keyboard.press('d');
    const note = approval.getByPlaceholder('No, and tell it what to do instead');
    await expect(note).toBeFocused();
    await note.fill('Move it to the trash instead');
    await note.press('Enter');
    await expect(approval.getByTestId('approval-decision')).toHaveText(
      'Denied: Move it to the trash instead',
    );
    await expect(
      conversation(page).getByText('The command was denied: Move it to the trash instead'),
    ).toBeVisible();

    // Codex takes no message with a decline: the turn stops and the note is the next message.
    await page.goto('/chat/new');
    await choose(page.getByLabel('Provider instance'), 'Mock Codex');
    await choose(page.getByLabel('Project'), 'Demo');
    await expect(page.getByTestId('model-bar')).toBeVisible();
    await messageBox(page).fill('Approve clearing the logs');
    await messageBox(page).press('Enter');
    const codexApproval = conversation(page).getByRole('region', { name: 'Approval request' });
    await expect(codexApproval).toBeFocused();
    await page.keyboard.press('d');
    await codexApproval.getByTestId('approval-note').fill('Keep the logs of today');
    await codexApproval.getByTestId('approval-note').press('Enter');
    await expect(codexApproval.getByTestId('approval-decision')).toHaveText(
      'Denied: Keep the logs of today',
    );
    await expect(conversation(page).getByTestId('turn-stopped')).toBeVisible();
    await expect(conversation(page).getByText('You said: Keep the logs of today')).toBeVisible();
    await expect(page.getByTestId('thread-state')).toHaveText('Idle');
  });

  test('always allows a command in this project @agent-workbench-38 @agent-workbench-39 @agent-workbench-40', async ({
    page,
  }) => {
    await startClaudeThread(page, 'Watch the tests');
    const approval = conversation(page).getByRole('region', { name: 'Approval request' });
    // The card shows the rule before it is stored.
    await expect(approval.getByTestId('approval-rule')).toHaveText(
      'Run commands starting with pnpm test',
    );
    await expect(approval).toBeFocused();
    await page.keyboard.press('y');
    await expect(approval.getByTestId('approval-decision')).toHaveText(
      'Always allowed in this project: Run commands starting with pnpm test',
    );
    await expect(conversation(page).getByText('The command ran.')).toBeVisible();

    // Another thread of the project, on the other provider: wow answers by the rule.
    await page.goto('/chat/new');
    await choose(page.getByLabel('Provider instance'), 'Mock Codex');
    await choose(page.getByLabel('Project'), 'Demo');
    await expect(page.getByTestId('model-bar')).toBeVisible();
    await messageBox(page).fill('Run the tests once');
    await messageBox(page).press('Enter');
    const byRule = conversation(page).getByRole('region', { name: 'Approval request' });
    await expect(byRule.getByTestId('approval-decision')).toHaveText(
      'Allowed by rule: Run commands starting with pnpm test',
    );
    await expect(conversation(page).getByText('The command ran.')).toBeVisible();

    // Removed in Settings, the next request asks again.
    await page.goto('/settings/approvals');
    const rule = page.getByTestId('always-allow-rule');
    await expect(rule).toHaveCount(1);
    await expect(rule).toContainText('Run commands starting with pnpm test');
    await expect(rule).toContainText('Added');
    await rule.getByRole('button', { name: /Remove/ }).click();
    await expect(page.getByTestId('always-allow-rule')).toHaveCount(0);
    await startClaudeThread(page, 'Run the tests once');
    const asks = conversation(page).getByRole('region', { name: 'Approval request' });
    await expect(asks.getByRole('button', { name: 'Allow once' })).toBeVisible();
    await page.keyboard.press('a');
    await expect(asks.getByTestId('approval-decision')).toHaveText('Allowed once');
  });

  test('starts from a plan @agent-workbench-42 @agent-workbench-43', async ({ page }) => {
    await page.goto('/chat/new');
    await choose(page.getByLabel('Provider instance'), 'Mock Claude');
    await choose(page.getByLabel('Project'), 'Demo');
    const bar = page.getByTestId('model-bar');
    await expect(bar).toBeVisible();
    await bar.getByRole('button', { name: 'Permission mode' }).click();
    await page
      .getByRole('listbox', { name: 'Permission mode' })
      .getByRole('option', { name: /^Plan only/ })
      .click();
    await expect(bar.getByRole('button', { name: 'Permission mode' })).toHaveText('Plan only');
    await messageBox(page).fill('Plan the work');
    await messageBox(page).press('Enter');
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
    const card = conversation(page).getByTestId('plan-card');
    await expect(card.getByRole('heading', { name: 'Plan: ring twice' })).toBeVisible();
    // The first choice has the focus, so Enter starts the plan accepting edits.
    await expect(card.getByRole('button', { name: 'Start, accept edits' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(card.getByTestId('approval-decision')).toHaveText('Started, accepting edits');
    await expect(bar.getByRole('button', { name: 'Permission mode' })).toHaveText('Accept edits');
    await expect(conversation(page).getByText('Starting on the plan.')).toBeVisible();

    // Keep planning with its digit key and a note.
    await messageBox(page).fill('Plan the work again');
    await messageBox(page).press('Enter');
    const again = conversation(page).getByTestId('plan-card').last();
    await expect(again.getByRole('button', { name: 'Start, accept edits' })).toBeFocused();
    await page.keyboard.press('3');
    await again.getByPlaceholder('What to change in the plan').fill('Write the test first');
    await page.keyboard.press('Enter');
    await expect(again.getByTestId('approval-decision')).toHaveText(
      'Kept planning: Write the test first',
    );
    await expect(
      conversation(page).getByText('I will keep planning: Write the test first'),
    ).toBeVisible();
    await resetBar(page);
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
    await expect(items.getByTestId('item-assistant_text')).toContainText(
      'I asked a background agent to count them.',
    );
    await expect(page.getByTestId('background-label')).toHaveText('Waiting for background work');
    await expect(page.getByTestId('background-chip')).toContainText('Count the tea leaves');
    const done = await fetch(`http://127.0.0.1:${e2eOutlookControlPort}/background-done`, {
      method: 'PUT',
    });
    expect(done.status).toBe(200);
    await expect(items.getByTestId('item-assistant_text')).toContainText([
      'I asked a background agent to count them.',
      'The background agent counted 42 leaves.',
    ]);
    await expect(items.getByTestId('item-user')).toHaveCount(1);
    await expect(page.getByTestId('background-work')).toBeHidden();
    await expect(items.getByLabel('Turn usage')).toHaveCount(2);
    const idle = threadList(page).getByRole('region', { name: 'Idle' });
    await expect(idle.getByRole('link', { name: /Count the tea leaves/ })).toBeVisible();
  });

  // Agent workbench U11 (spec 44): the subagent's calls and note are listed under its call
  // while it works; its answer shows after, with the count and the time.
  test("shows a subagent's work under its call @agent-workbench-44", async ({ page }) => {
    await startClaudeThread(page, 'Explore with an agent');
    const agent = conversation(page).getByTestId('agent-row');
    await expect(agent).toHaveCount(1);
    await expect(agent.getByTestId('agent-task')).toHaveText('Agent: explore the auth code');
    const work = agent.getByRole('list', { name: "The subagent's work" });
    await expect(work.getByTestId('tool-command')).toHaveText('$ pnpm test auth');
    await expect(work.getByRole('listitem')).toHaveCount(4);
    await expect(agent.getByTestId('agent-facts')).toContainText('3 tool calls');
    await expect(agent.getByTestId('agent-answer')).toHaveCount(0);

    const done = await fetch(`http://127.0.0.1:${e2eOutlookControlPort}/agent-done`, {
      method: 'PUT',
    });
    expect(done.status).toBe(200);
    await expect(agent.getByTestId('agent-answer')).toContainText(
      'The kettle checks mayStart in src/auth.ts',
    );
    await expect(agent.getByTestId('agent-facts')).toHaveText('3 tool calls · 1:32');
    await expect(work).toBeHidden();
    await expect(page.getByTestId('thread-state')).toHaveText('Idle');
    await expect(conversation(page).getByText('That is where the kettle checks it.')).toBeVisible();
    // A reload shows the same, from what the server stored (spec 48).
    await page.reload();
    await expect(conversation(page).getByTestId('agent-facts')).toHaveText('3 tool calls · 1:32');
    await conversation(page)
      .getByRole('button', { name: /Agent: explore the auth code/ })
      .click();
    await expect(
      conversation(page).getByRole('list', { name: "The subagent's work" }).getByRole('listitem'),
    ).toHaveCount(4);
  });

  // Spec 90: two chips count up; one opens to its last output; Stop stops it; Ctrl+B on the
  // running command sends it to the background.
  test('sends a running command to the background and stops a background task @agent-workbench-90', async ({
    page,
  }) => {
    await startClaudeThread(page, 'Serve the kettle app');
    await expect(page.getByTestId('thread-state')).toHaveText('Working');
    await expect(page.getByTestId('background-chip')).toHaveCount(1);
    await messageBox(page).focus();
    await page.keyboard.press('Control+b');
    const chips = page.getByTestId('background-chip');
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(1)).toContainText('pnpm dev');
    await expect(page.getByTestId('thread-state')).toHaveText('Idle');
    await expect(page.getByTestId('background-label')).toHaveText('Waiting for background work');
    // Each chip counts up from the time the server stored for it.
    await expect(page.getByTestId('background-elapsed')).toHaveText([/^\d+:\d{2}$/, /^\d+:\d{2}$/]);

    await chips.first().click();
    const popover = page.getByRole('dialog');
    await expect(popover.getByTestId('background-output')).toHaveText('Counted 30 leaves so far');
    await popover.getByRole('button', { name: 'Stop' }).click();
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toContainText('pnpm dev');
  });

  test('keeps a draft and a queued message across threads and a reload @agent-workbench-49 @agent-workbench-50 @agent-workbench-52', async ({
    page,
  }) => {
    await startCodexWait(page, 'Wait for the kettle');
    const threadA = page.url();
    const queued = page.getByTestId('queued-message');

    // Enter during the turn: the server holds it, with Edit and Cancel.
    await messageBox(page).fill('Then sum it up');
    await messageBox(page).press('Enter');
    await expect(queued).toContainText('Queued · sent when the turn ends');
    await expect(queued).toContainText('Then sum it up');
    await expect(messageBox(page)).toHaveValue('');
    // Edit takes it off the queue and puts it back in the composer; Enter queues it again.
    await queued.getByRole('button', { name: 'Edit' }).click();
    await expect(queued).toBeHidden();
    await expect(messageBox(page)).toHaveValue('Then sum it up');
    await messageBox(page).press('Enter');
    await expect(queued).toContainText('Then sum it up');

    // A draft with a chip, then another thread: its composer is its own.
    await messageBox(page).pressSequentially('/deli');
    await messageBox(page).press('Enter');
    await messageBox(page).pressSequentially('and list the cups');
    await page.goto('/chat/new');
    await choose(page.getByLabel('Provider instance'), 'Mock Claude');
    await choose(page.getByLabel('Project'), 'Demo');
    await messageBox(page).fill('Hello from the other thread');
    await messageBox(page).press('Enter');
    await expect(conversation(page).getByTestId('item-assistant_text')).toContainText(
      'You said: Hello from the other thread',
    );
    await expect(messageBox(page)).toHaveValue('');

    await page.goto(threadA);
    await expect(messageBox(page)).toHaveValue('and list the cups');
    const picked = page.getByRole('list', { name: 'Picked skills' });
    await expect(picked).toHaveText('deliver-work');
    await expect(queued).toContainText('Then sum it up');
    await page.reload();
    await expect(messageBox(page)).toHaveValue('and list the cups');
    await expect(picked).toHaveText('deliver-work');
    await expect(queued).toContainText('Then sum it up');

    // A second message joins the first; sending empties the composer.
    await messageBox(page).press('Enter');
    await expect(messageBox(page)).toHaveValue('');
    await expect(picked).toBeHidden();
    await expect(queued).toContainText('Then sum it up');
    await expect(queued).toContainText('and list the cups');
    await expect(queued.getByRole('list', { name: 'Queued with skills' })).toHaveText(
      'deliver-work',
    );

    // The turn ends: the server sends what waited, as one message.
    await endWait(page);
    await expect(queued).toBeHidden();
    const sent = conversation(page).getByTestId('item-user').last();
    await expect(sent).toContainText('Then sum it up');
    await expect(sent).toContainText('and list the cups');
    await expect(sent.getByTestId('sent-from-queue')).toHaveText('Sent when the turn ended');
    await expect(conversation(page).getByTestId('item-assistant_text').last()).toContainText(
      'You said: $deliver-work Then sum it up',
    );

    // Cancel takes a queued message off, and the server sends nothing.
    await messageBox(page).fill('Wait for the second kettle');
    await messageBox(page).press('Enter');
    await expect(page.getByTestId('thread-state')).toHaveText('Working');
    await messageBox(page).fill('Never mind this');
    await messageBox(page).press('Enter');
    await queued.getByRole('button', { name: 'Cancel' }).click();
    await expect(queued).toBeHidden();
    await endWait(page);
    await expect(page.getByTestId('thread-state')).toHaveText('Idle');
    await expect(conversation(page).getByText('Never mind this')).toHaveCount(0);
  });

  test('hands a message to the running Claude Code turn and shows it sent @agent-workbench-51', async ({
    page,
  }) => {
    await startClaudeThread(page, 'Wait for the tea');
    await expect(page.getByTestId('thread-state')).toHaveText('Working');
    await messageBox(page).fill('Also warm the cups');
    await messageBox(page).press('Enter');
    const handed = conversation(page).getByTestId('item-user').last();
    await expect(handed).toContainText('Also warm the cups');
    await expect(handed.getByTestId('sent-from-queue')).toHaveText('Sent during the turn');
    await expect(page.getByTestId('queued-message')).toBeHidden();
    await endWait(page);
    await expect(page.getByTestId('thread-state')).toHaveText('Idle');
    await expect(conversation(page).getByTestId('item-user')).toHaveCount(2);
  });

  test('runs /clear from the composer @agent-workbench-58 @agent-workbench-59 @agent-workbench-60', async ({
    page,
  }) => {
    await startClaudeThread(page, 'Clear me later');
    await expect(conversation(page).getByTestId('item-assistant_text')).toContainText(
      'You said: Clear me later',
    );
    const oldThread = page.url();
    const bar = page.getByTestId('model-bar');
    await bar.getByRole('button', { name: 'Effort' }).click();
    await page
      .getByRole('listbox', { name: 'Effort' })
      .getByRole('option', { name: 'High' })
      .click();
    await expect(bar).toHaveText('Mock model·High·Ask');

    const list = page.getByRole('listbox', { name: 'Skills' });
    await messageBox(page).pressSequentially('/');
    // wow's commands, then Claude Code's own, then the skills.
    await expect(list.locator('[cmdk-group-heading]').first()).toHaveText('Commands');
    await expect(list.locator('[cmdk-group-heading]').nth(1)).toHaveText('Claude Code commands');
    const commands = list.getByRole('group', { name: 'Commands' }).getByRole('option');
    for (const name of ['/model', '/effort', '/plan', '/compact', '/clear', '/done']) {
      await expect(commands.filter({ hasText: name }).first()).toBeVisible();
    }
    // /fork has no palette command yet, so it is not listed.
    await expect(commands.filter({ hasText: '/fork' })).toHaveCount(0);
    const claude = list.getByRole('group', { name: 'Claude Code commands' }).getByRole('option');
    await expect(claude).toHaveCount(2);
    await expect(claude.first()).toContainText('/review');

    // A Claude Code command goes into the text, to be sent as typed.
    await messageBox(page).pressSequentially('rev');
    await messageBox(page).press('Enter');
    await expect(messageBox(page)).toHaveValue('/review ');
    await messageBox(page).fill('');

    await messageBox(page).pressSequentially('/cle');
    await messageBox(page).press('Enter');
    await expect(page).toHaveURL(/\/chat\/new$/);
    await expect(page.getByLabel('Provider instance')).toHaveText(/Mock Claude/);
    await expect(page.getByLabel('Project')).toHaveText(/Demo/);
    await expect(page.getByTestId('model-bar')).toHaveText('Mock model·High·Ask');
    await expect(threadList(page).getByRole('link', { name: /Clear me later/ })).toBeVisible();

    // New threads start from the last one, so the later cases get the defaults back.
    await page.goto(oldThread);
    await resetBar(page);
  });

  // U3's `/` list runs U2's "Rename thread" (spec 58, 67).
  test('renames the thread with /rename from the composer', async ({ page }) => {
    await startClaudeThread(page, 'Name me from the composer');
    await expect(conversation(page).getByTestId('item-assistant_text')).toContainText(
      'You said: Name me from the composer',
    );
    await messageBox(page).pressSequentially('/rena');
    await messageBox(page).press('Enter');
    await expect(messageBox(page)).toHaveValue('');
    const title = page.getByRole('textbox', { name: 'Thread title' });
    await expect(title).toBeFocused();
    await title.fill('Named by slash');
    await title.press('Enter');
    await expect(page.getByRole('heading', { name: 'Named by slash' })).toBeVisible();
    await expect(threadList(page).getByRole('link', { name: /Named by slash/ })).toBeVisible();
  });

  test('sends a pasted image @agent-workbench-53 @agent-workbench-55', async ({ page }) => {
    await startClaudeThread(page, 'Look at my screen');
    const threadId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    await expect(conversation(page).getByTestId('item-assistant_text')).toContainText(
      'You said: Look at my screen',
    );
    const images = page.getByRole('list', { name: 'Images', exact: true });
    await addImage(page, 'paste', 'image.png', 210);
    await addImage(page, 'drop', 'kettle.png', 30);
    await expect(images.getByTestId('composer-image-chip')).toHaveCount(2);
    // Backspace at the start of the text takes the last one off whole.
    await messageBox(page).focus();
    await messageBox(page).press('Backspace');
    await expect(images.getByTestId('composer-image-chip')).toHaveCount(1);
    await addImage(page, 'drop', 'kettle.png', 30);
    await images.getByRole('button', { name: 'Show kettle.png full size' }).click();
    const viewer = page.getByRole('dialog', { name: 'kettle.png' });
    await expect(viewer.getByTestId('image-full-size')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();

    await messageBox(page).fill('What is wrong here?');
    await messageBox(page).press('Enter');
    await expect(images).toBeHidden();
    // The mock adapter says how many images it was handed, and of which type.
    await expect(conversation(page).getByTestId('item-assistant_text').last()).toContainText(
      'Received 2 images. Types: png, png.',
    );
    const sent = conversation(page).getByRole('list', { name: 'Sent with images' });
    await expect(sent.getByRole('img')).toHaveCount(2);

    await page.reload();
    await expect(sent.getByRole('img', { name: 'Image 1' })).toHaveAttribute(
      'src',
      /^data:image\/png;base64,/,
    );
    await expect(sent.getByRole('img', { name: 'kettle.png' })).toBeVisible();
    // Stored under wow's home, in the thread's own folder (spec 55): the two sent and the one
    // taken off before sending.
    const stored = await readdir(path.join(e2eHome, 'images', `t-${threadId}`));
    expect(stored).toHaveLength(3);
    for (const file of stored) expect(file).toMatch(/^[0-9a-f-]{36}\.png$/);
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

  test('picks model, effort and mode from the composer bar @agent-workbench-1 @agent-workbench-2 @agent-workbench-3 @agent-workbench-4 @agent-workbench-5 @agent-workbench-7', async ({
    page,
  }) => {
    await startClaudeThread(page, 'Pick from the bar');
    const bar = page.getByTestId('model-bar');
    await expect(bar).toHaveText('Mock model·Default·Ask');
    // The header keeps the project and the provider; the selects left it.
    await expect(page.locator('header').getByRole('combobox')).toHaveCount(0);

    const box = messageBox(page);
    await box.focus();
    await page.keyboard.press('Control+Shift+M');
    const models = page.getByRole('listbox', { name: 'Model' });
    await models.getByRole('option', { name: /Mock model, large/ }).click();
    await expect(bar.getByRole('button', { name: 'Model' })).toHaveText('Mock model, large');
    await expect(box).toBeFocused();
    await page.keyboard.press('Control+Shift+E');
    await page
      .getByRole('listbox', { name: 'Effort' })
      .getByRole('option', { name: /^High/ })
      .click();
    await expect(bar.getByRole('button', { name: 'Effort' })).toHaveText('High');

    // Shift+Tab steps through Ask, Accept edits and Plan only; Bypass only from the list.
    const mode = bar.getByRole('button', { name: 'Permission mode' });
    await box.press('Shift+Tab');
    await expect(mode).toHaveText('Accept edits');
    await expect(mode).toHaveClass(/text-state-done/);
    await box.press('Shift+Tab');
    await expect(mode).toHaveText('Plan only');
    await expect(mode).toHaveClass(/text-info/);
    await box.press('Shift+Tab');
    await expect(mode).toHaveText('Ask');
    await expect(box).toBeFocused();
    await mode.click();
    await page
      .getByRole('listbox', { name: 'Permission mode' })
      .getByRole('option', { name: 'Bypass permissions' })
      .click();
    await expect(mode).toHaveText('Bypass permissions');
    await expect(mode).toHaveClass(/text-destructive/);
    // The second key leaves the composer.
    await box.focus();
    await box.press('Escape');
    await expect(box).not.toBeFocused();

    // thread.configure stored the picks: they hold after a reload.
    await page.reload();
    await expect(page.getByTestId('model-bar')).toHaveText(
      'Mock model, large·High·Bypass permissions',
    );
    // A new thread starts from the last one, so the later cases get the defaults back.
    await resetBar(page);

    // A new thread has the same bar; on Codex the list says what the provider offers.
    await page.goto('/chat/new');
    await choose(page.getByLabel('Provider instance'), 'Mock Codex');
    await expect(page.getByTestId('model-bar')).toHaveText('Mock model for Codex·Medium·Read only');
    await page.getByTestId('model-bar').getByRole('button', { name: 'Model' }).click();
    const offered = page.getByRole('listbox', { name: 'Model' }).getByRole('option');
    await expect(offered).toHaveText([
      "Mock model for Codex(provider's default)Invented: the everyday mock model",
      'Mock model for Codex, miniInvented: small and quick',
    ]);
    await expect(offered.first().getByRole('img', { name: 'Takes images' })).toBeVisible();
    await expect(offered.last().getByRole('img', { name: 'Takes images' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByTestId('model-bar').getByRole('button', { name: 'Effort' }).click();
    await expect(page.getByRole('listbox', { name: 'Effort' }).getByRole('option')).toHaveText([
      'Low',
      "Medium(model's default)",
      'High',
    ]);
  });

  test('sets the model from the palette @agent-workbench-6', async ({ page }) => {
    await startClaudeThread(page, 'Pick from the palette');
    const bar = page.getByTestId('model-bar');
    await expect(bar).toHaveText('Mock model·Default·Ask');
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await palette.getByRole('combobox').fill('Model: Mock model');
    // The current model is marked.
    await expect(
      palette.getByRole('option', { name: /^Model: Mock model\s*Current/ }),
    ).toBeVisible();
    await palette.getByRole('combobox').fill('Model: Mock model, large');
    await palette.getByRole('option', { name: /Model: Mock model, large/ }).click();
    await expect(bar.getByRole('button', { name: 'Model' })).toHaveText('Mock model, large');

    await page.keyboard.press('Control+k');
    await palette.getByRole('combobox').fill('Permission mode: Plan only');
    await palette.getByRole('option', { name: /Permission mode: Plan only/ }).click();
    await expect(bar.getByRole('button', { name: 'Permission mode' })).toHaveText('Plan only');

    await page.keyboard.press('Control+k');
    await palette.getByRole('combobox').fill('Effort: High');
    await palette.getByRole('option', { name: /Effort: High/ }).click();
    await expect(bar.getByRole('button', { name: 'Effort' })).toHaveText('High');

    await page.keyboard.press('Control+k');
    await palette.getByRole('combobox').fill('Choose model');
    await palette.getByRole('option', { name: /Choose model/ }).click();
    await expect(page.getByRole('listbox', { name: 'Model' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.getByTestId('model-bar')).toHaveText('Mock model, large·High·Plan only');
    await resetBar(page);
  });

  test('shows a model change and a compaction in the conversation @agent-workbench-9 @agent-workbench-45 @agent-workbench-46 @agent-workbench-57 @agent-workbench-75', async ({
    page,
  }) => {
    // The skill list opens under a new thread's composer, so the pickers above stay in view.
    await page.goto('/chat/new');
    await choose(page.getByLabel('Provider instance'), 'Mock Claude');
    await messageBox(page).pressSequentially('/');
    const skills = page.getByRole('listbox', { name: 'Skills' });
    await expect(skills).toBeVisible();
    const listTop = (await skills.boundingBox())?.y ?? 0;
    for (const picker of [page.getByLabel('Provider instance'), page.getByLabel('Project')]) {
      const box = await picker.boundingBox();
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(listTop);
    }
    await messageBox(page).press('Escape');
    await messageBox(page).fill('');

    await startClaudeThread(page, 'Hello there');
    await expect(conversation(page).getByTestId('item-assistant_text')).toContainText(
      'You said: Hello there',
    );
    const bar = page.getByTestId('model-bar');
    await bar.getByRole('button', { name: 'Model' }).click();
    await page
      .getByRole('listbox', { name: 'Model' })
      .getByRole('option', { name: /Mock model, large/ })
      .click();
    await messageBox(page).focus();
    await messageBox(page).press('Shift+Tab');
    await expect(bar.getByRole('button', { name: 'Permission mode' })).toHaveText('Accept edits');
    // `/compact` from the command list sends the provider's compact message.
    await messageBox(page).pressSequentially('/compact');
    await messageBox(page).press('Enter');

    // One divider names both changes before the message; each usage row names its model.
    const dividers = conversation(page).getByTestId('settings-divider');
    await expect(dividers).toHaveText([
      'Model: Mock model → Mock model, large · Mode: Accept edits',
    ]);
    await expect(conversation(page).getByTestId('compaction-divider')).toHaveText(
      'Conversation compacted (manual) · 152k → 18k',
    );
    const usage = conversation(page).getByLabel('Turn usage');
    await expect(usage).toHaveCount(2);
    await expect(usage.nth(0)).toContainText(/^Mock model · /);
    await expect(usage.nth(1)).toContainText(/^Mock model, large · /);
    // The rows carry their times: each message its start, each answer its turn's end.
    await expect(conversation(page).getByTestId('message-time')).toHaveCount(4);

    // A running turn of two tool calls: no tokens on Claude Code.
    await messageBox(page).fill('Use two tools');
    await messageBox(page).press('Enter');
    await expect(page.getByTestId('working-line')).toContainText(
      /^Running pnpm test · \d+:\d\d · 2 tool calls · Ctrl\+\. to stop$/,
    );
    await page.keyboard.press('Control+.');
    await expect(page.getByTestId('thread-state')).toHaveText('Idle');
    await resetBar(page);

    // Codex counts tokens during the turn.
    await startCodexWait(page, 'Use two tools');
    await expect(page.getByTestId('working-line')).toContainText(
      /^Running pnpm test · \d+:\d\d · 2 tool calls · ↑12k ↓1\.3k · Ctrl\+\. to stop$/,
    );
    await page.keyboard.press('Control+.');
    await expect(page.getByTestId('thread-state')).toHaveText('Idle');
  });

  test('jumps to the next that needs you @agent-workbench-76 @agent-workbench-74', async ({
    page,
  }) => {
    // The older: an approval in a chat thread.
    await startClaudeThread(page, 'Approve the kettle test');
    const approval = conversation(page).getByRole('region', { name: 'Approval request' });
    await expect(approval).toBeVisible();
    const approvalPath = new URL(page.url()).pathname;
    // The newer: a run waiting at its gate.
    const runId = `needs-you-${Date.now()}`;
    const query = new URLSearchParams({ workflowId: e2eNeedsYouWorkflowId, runId });
    const started = await fetch(`http://127.0.0.1:${e2eTrackerPort}/run?${query}`, {
      method: 'POST',
    });
    expect(started.ok).toBe(true);
    await page.goto(`/workflows/runs/${runId}`);
    await expect(page.getByTestId('run-state')).toHaveText('Waiting for you');

    // Elsewhere in the app, with what waits already read from the server.
    await page.keyboard.press('Control+1');
    await expect(page).toHaveURL(/\/calendar/);
    // Cases before this one may leave older things waiting: each press lands on the next one,
    // oldest first, until the run's gate, which is the newest; the approval comes before it.
    const runPath = `/workflows/runs/${runId}`;
    const visited: string[] = [];
    // The e2e files have no DOM types; the page's document as far as this case reads it. The
    // functions run in the page, so each names it itself.
    type PageGlobal = { document: { readonly activeElement: unknown; readonly body: unknown } };
    let before = await page.evaluateHandle(
      () => (globalThis as unknown as PageGlobal).document.activeElement,
    );
    while (!visited.includes(runPath)) {
      expect(visited.length).toBeLessThan(10);
      await page.keyboard.press('Control+Shift+J');
      await page.waitForFunction((previous) => {
        const { document } = globalThis as unknown as PageGlobal;
        return document.activeElement !== previous && document.activeElement !== document.body;
      }, before);
      before = await page.evaluateHandle(
        () => (globalThis as unknown as PageGlobal).document.activeElement,
      );
      const pathname = new URL(page.url()).pathname;
      visited.push(pathname);
      if (pathname === approvalPath) await expect(approval).toBeFocused();
    }
    expect(visited.indexOf(approvalPath)).toBeGreaterThan(-1);
    expect(visited.indexOf(approvalPath)).toBeLessThan(visited.indexOf(runPath));
    await expect(page.locator(':focus')).toHaveText('Approve');

    // Back in the thread, Alt+Up moves through the messages.
    await page.goto(approvalPath);
    await expect(approval).toBeVisible();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(conversation(page).getByTestId('item-user')).toBeFocused();

    // Leave nothing waiting for the cases after this one.
    await approval.getByRole('button', { name: /Allow once/ }).click();
    await expect(conversation(page).getByText('The command ran.')).toBeVisible();
    await page.goto(`/workflows/runs/${runId}`);
    await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
    await expect(page.getByTestId('run-state')).not.toHaveText('Waiting for you');
  });

  test('edits the last message and forks from an earlier one @agent-workbench-62 @agent-workbench-63 @agent-workbench-71 @agent-workbench-74', async ({
    page,
  }) => {
    await startClaudeThread(page, 'Descale the kettle');
    await expect(conversation(page).getByText('You said: Descale the kettle')).toBeVisible();
    await messageBox(page).fill('Build the timer');
    await messageBox(page).press('Enter');
    await expect(conversation(page).getByText(/You said: Build the timer/)).toBeVisible();
    await messageBox(page).fill('Edit the timer');
    await messageBox(page).press('Enter');
    const approval = conversation(page).getByRole('region', { name: 'Approval request' });
    await approval.getByRole('button', { name: /Allow once/ }).click();
    await expect(conversation(page).getByText('The timer rings twice now.')).toBeVisible();

    // Up in the empty composer brings the last message back; that turn changed a file.
    await messageBox(page).focus();
    await messageBox(page).press('ArrowUp');
    await expect(messageBox(page)).toHaveValue('Edit the timer');
    await expect(page.getByTestId('edit-files-note')).toHaveText(
      'Files stay as they are: what that turn changed is not undone.',
    );
    await messageBox(page).fill('Add a bell to the timer');
    await messageBox(page).press('Enter');
    // The mock replays what it kept: the conversation goes on from before the edited message.
    await expect(
      conversation(page).getByText('Picked up after: "Descale the kettle", "Build the timer".'),
    ).toBeVisible();
    const users = conversation(page).getByTestId('item-user');
    await expect(users).toHaveCount(3);
    const earlier = users.nth(2).getByTestId('earlier-version');
    await earlier.getByText('Earlier version').click();
    await expect(earlier.getByTestId('earlier-exchange')).toContainText('Edit the timer');
    await expect(earlier.getByTestId('earlier-exchange')).toContainText(
      'The timer rings twice now.',
    );

    // F on the second message forks there: the first two exchanges, the same settings.
    const origin = new URL(page.url()).pathname;
    const bar = await page.getByTestId('model-bar').textContent();
    await users.nth(1).focus();
    await page.keyboard.press('f');
    await expect(page).not.toHaveURL(origin);
    await expect(page.getByTestId('thread-forked-from')).toContainText('Forked from');
    await expect(conversation(page).getByTestId('item-user')).toHaveCount(2);
    await expect(conversation(page).getByText('Add a bell to the timer')).toHaveCount(0);
    await expect(page.getByTestId('model-bar')).toHaveText(bar ?? '');
    await messageBox(page).fill('Add a light instead');
    await messageBox(page).press('Enter');
    await expect(
      conversation(page).getByText('Picked up after: "Descale the kettle", "Build the timer".'),
    ).toBeVisible();
    await page.getByTestId('thread-forked-from').getByRole('link').click();
    await expect(page).toHaveURL(origin);
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

  test('approval-diff', async ({ page }) => {
    await startClaudeThread(page, 'Edit the timer');
    const approval = conversation(page).getByRole('region', { name: 'Approval request' });
    await expect(approval.getByRole('table', { name: 'Diff of src/timer.ts' })).toBeVisible();
    await page.screenshot({ path: sketchPath('2026-11-agent-workbench', 'approval-diff') });
    await page.keyboard.press('a');
    await expect(conversation(page).getByText('The timer rings twice now.')).toBeVisible();
  });

  test('plan-card', async ({ page }) => {
    await startClaudeThread(page, 'Plan the work');
    const card = conversation(page).getByTestId('plan-card');
    await expect(card.getByRole('heading', { name: 'Plan: ring twice' })).toBeVisible();
    await page.screenshot({ path: sketchPath('2026-11-agent-workbench', 'plan-card') });
    await page.keyboard.press('2');
    await expect(card.getByTestId('approval-decision')).toHaveText('Started, asking each time');
  });

  test('model-bar', async ({ page }) => {
    await startClaudeThread(page, 'Hello there');
    await expect(conversation(page).getByTestId('item-assistant_text')).toContainText(
      'You said: Hello there',
    );
    const box = messageBox(page);
    await box.focus();
    await box.press('Shift+Tab');
    await expect(
      page.getByTestId('model-bar').getByRole('button', { name: 'Permission mode' }),
    ).toHaveText('Accept edits');
    await box.fill('Now run the tests');
    await page.keyboard.press('Control+Shift+M');
    await expect(page.getByRole('listbox', { name: 'Model' })).toBeVisible();
    // The list fades in; the picture waits for that to end.
    // (A string, since the e2e files are typed without the DOM.)
    await page.evaluate(
      'Promise.all(document.getAnimations().map((animation) => animation.finished))',
    );
    await page.screenshot({ path: sketchPath('2026-11-agent-workbench', 'model-bar') });
  });

  test('composer-queued', async ({ page }) => {
    await startCodexWait(page, 'Wait for the kettle to boil');
    await messageBox(page).fill('Then sum up what you found in three lines');
    await messageBox(page).press('Enter');
    await expect(page.getByTestId('queued-message')).toBeVisible();
    await messageBox(page).pressSequentially('/deli');
    await messageBox(page).press('Enter');
    await messageBox(page).pressSequentially('and after that, list the cups we need');
    await page.screenshot({ path: sketchPath('2026-11-agent-workbench', 'composer-queued') });
    await page.keyboard.press('Control+.');
    await expect(page.getByTestId('thread-state')).toHaveText('Idle');
  });

  test('conversation', async ({ page }) => {
    await startClaudeThread(page, 'Hello there');
    await expect(conversation(page).getByTestId('item-assistant_text')).toContainText(
      'You said: Hello there',
    );
    const bar = page.getByTestId('model-bar');
    await bar.getByRole('button', { name: 'Model' }).click();
    await page
      .getByRole('listbox', { name: 'Model' })
      .getByRole('option', { name: /Mock model, large/ })
      .click();
    await messageBox(page).focus();
    await messageBox(page).press('Shift+Tab');
    // `/compact` from the command list sends the provider's compact message.
    await messageBox(page).pressSequentially('/compact');
    await messageBox(page).press('Enter');
    await expect(conversation(page).getByTestId('compaction-divider')).toBeVisible();
    await messageBox(page).fill('Use two tools');
    await messageBox(page).press('Enter');
    await expect(page.getByTestId('working-line')).toContainText('2 tool calls');
    await page.keyboard.press('Control+o');
    await page.screenshot({ path: sketchPath('2026-11-agent-workbench', 'conversation') });
    await page.keyboard.press('Control+.');
    await expect(page.getByTestId('thread-state')).toHaveText('Idle');
    await resetBar(page);
  });

  test('fork', async ({ page }) => {
    await startClaudeThread(page, 'Descale the kettle');
    await expect(conversation(page).getByText('You said: Descale the kettle')).toBeVisible();
    await messageBox(page).fill('Edit the timer');
    await messageBox(page).press('Enter');
    await conversation(page)
      .getByRole('region', { name: 'Approval request' })
      .getByRole('button', { name: /Allow once/ })
      .click();
    await expect(conversation(page).getByText('The timer rings twice now.')).toBeVisible();
    await messageBox(page).focus();
    await messageBox(page).press('ArrowUp');
    await messageBox(page).fill('Add a bell to the timer');
    await messageBox(page).press('Enter');
    await expect(conversation(page).getByText(/Picked up after/)).toBeVisible();
    const users = conversation(page).getByTestId('item-user');
    await users.nth(1).getByText('Earlier version').click();
    await messageBox(page).focus();
    await messageBox(page).press('ArrowUp');
    await expect(page.getByTestId('edit-notice')).toBeVisible();
    await users.nth(0).hover();
    await expect(users.nth(0).getByRole('button', { name: 'Fork from here' })).toBeVisible();
    await page.screenshot({ path: sketchPath('2026-11-agent-workbench', 'fork') });
    await page.getByTestId('edit-notice').getByRole('button', { name: 'Cancel' }).click();
  });

  test('subagent', async ({ page }) => {
    // Work in the background, then a subagent at work in the same thread.
    await startClaudeThread(page, 'Serve the kettle app');
    await messageBox(page).focus();
    await page.keyboard.press('Control+b');
    await expect(page.getByTestId('background-chip')).toHaveCount(2);
    await expect(page.getByTestId('thread-state')).toHaveText('Idle');
    await messageBox(page).fill('Explore with an agent');
    await messageBox(page).press('Enter');
    await expect(
      conversation(page).getByRole('list', { name: "The subagent's work" }).getByRole('listitem'),
    ).toHaveCount(4);
    await page.screenshot({ path: sketchPath('2026-11-agent-workbench', 'subagent') });
    await fetch(`http://127.0.0.1:${e2eOutlookControlPort}/agent-done`, { method: 'PUT' });
    await expect(page.getByTestId('thread-state')).toHaveText('Idle');
  });

  test('image-chip', async ({ page }) => {
    await startClaudeThread(page, 'Hello there');
    await addImage(page, 'paste', 'image.png', 210);
    await messageBox(page).fill('Why does the timer stop here?');
    await messageBox(page).press('Enter');
    await expect(conversation(page).getByTestId('item-assistant_text').last()).toContainText(
      'Received 1 image. Types: png.',
    );
    await addImage(page, 'paste', 'image.png', 140);
    await addImage(page, 'drop', 'kettle-settings.png', 30);
    const images = page.getByRole('list', { name: 'Images', exact: true });
    await expect(images.getByRole('img')).toHaveCount(2);
    await messageBox(page).pressSequentially('And these two, the settings before and after');
    await page.screenshot({ path: sketchPath('2026-11-agent-workbench', 'image-chip') });
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
