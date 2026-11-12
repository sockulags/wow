import { expect, test, type Page } from '@playwright/test';
import { settingsRegistry } from '@wow/contracts';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { e2eAssistantHome } from './env';
import { sketchPath, sketching, sketchUse } from './sketch';

// U6 of the app assistant: the spec's ground truth names the behaviors `pnpm e2e` must cover.
// Each case that covers one carries `@app-assistant-<n>` in its title, so
// `pnpm e2e --grep @app-assistant` runs exactly those. These checks read files only; no browser
// starts.

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '..', '..', '..');
const intent = path.join(repository, 'intents', '2026-11-app-assistant');
const read = (file: string) => readFile(file, 'utf8');
const tag = '@app-assistant-';

function groundTruthBehaviors(spec: string): number[] {
  const section = spec.slice(spec.indexOf('## Ground truth'), spec.indexOf('## Open risks'));
  const line = /`pnpm e2e` with the mock provider[^:]*:([\d,\sand]+)\./.exec(section)?.[1];
  if (!line) throw new Error('The spec names no behaviors for `pnpm e2e`');
  return [...line.matchAll(/\d+/g)].map((match) => Number(match[0]));
}

// The numbered behaviors of the spec, "1. Given …" to the last.
const specBehaviors = (spec: string): number[] =>
  [...spec.matchAll(/^(\d+)\. Given /gm)].map((match) => Number(match[1]));

async function taggedBehaviors(): Promise<Map<number, string[]>> {
  const covered = new Map<number, string[]>();
  const own = path.basename(fileURLToPath(import.meta.url));
  for (const file of await readdir(here)) {
    if (!file.endsWith('.spec.ts') || file === own) continue;
    const text = await read(path.join(here, file));
    for (const title of text.matchAll(/test\(\s*'([^']*)'/g)) {
      for (const match of (title[1] ?? '').matchAll(new RegExp(`${tag}(\\d+)`, 'g'))) {
        const behavior = Number(match[1]);
        covered.set(behavior, [...(covered.get(behavior) ?? []), `${file}: ${title[1]}`]);
      }
    }
  }
  return covered;
}

test.describe('app assistant coverage', () => {
  test('every behavior the ground truth names has an e2e case that names it', async () => {
    const spec = await read(path.join(intent, 'spec.md'));
    const named = groundTruthBehaviors(spec);
    expect(named).toEqual([7, 8, 9, 10, 11, 14, 17, 19, 21, 22, 25, 26]);
    const covered = await taggedBehaviors();
    expect(named.filter((behavior) => !covered.has(behavior))).toEqual([]);
    // Cases may cover more behaviors than the ground truth names, but only ones the spec has.
    const known = specBehaviors(spec);
    expect([...covered.keys()].filter((behavior) => !known.includes(behavior))).toEqual([]);
  });

  test('every sketch the spec interface names exists', async () => {
    const spec = await read(path.join(intent, 'spec.md'));
    const interfaceSection = spec.slice(spec.indexOf('## Interface'), spec.indexOf('## Bound'));
    const sketches = [
      ...interfaceSection.matchAll(/`intents\/2026-11-app-assistant\/sketches\/([\w-]+\.png)`/g),
    ].map((match) => match[1] ?? '');
    expect(sketches).toContain('first-start.png');
    const missing: string[] = [];
    for (const sketch of sketches) {
      await access(path.join(intent, 'sketches', sketch)).catch(() => missing.push(sketch));
    }
    expect(missing).toEqual([]);
  });

  test('the user guide has the assistant section and names its settings', async () => {
    const guide = await read(path.join(repository, 'docs', 'user-guide.md'));
    const section = guide.slice(guide.indexOf('## Assistant'), guide.indexOf('## Settings'));
    for (const heading of [
      '### Changes, proposals and Undo',
      '### Secrets',
      '### A setup to share',
      '### When it cannot start',
      '### Making a host token',
      '### Why does this not work',
    ]) {
      expect(section).toContain(heading);
    }
    const keys = [
      ...Object.entries(settingsRegistry)
        .filter(([, definition]) => definition.group === 'assistant')
        .map(([key]) => key),
      'keybindings.goAssistant',
      'providers.offerSetup',
    ];
    expect(keys.filter((key) => !guide.includes(`\`${key}\``))).toEqual([]);
    expect(guide).toContain('**Connect an agent**');
  });

  test('the Windows smoke check has the manual assistant check from the spec', async () => {
    const smoke = await read(path.join(repository, 'docs', 'windows-smoke.md'));
    const section = smoke.slice(smoke.indexOf('## 10. Assistant'), smoke.indexOf('## 11.'));
    expect(section).toMatch(/GitLab host through the assistant[\s\S]*token[\s\S]*test[\s\S]*pass/);
    expect(section).toMatch(/conversation[\s\S]*\.wow[\s\S]*no match/);
    expect(section).toMatch(/read `C:\\Windows\\win\.ini`/);
    expect(smoke.slice(smoke.indexOf('## 1. Install'), smoke.indexOf('## 2.'))).toContain(
      'Connect an agent',
    );
  });
});

// Agent workbench U1 (spec 10): the Assistant view's composer bar writes the assistant's
// settings, as Settings → Assistant does, and its mode is not a choice. It runs against the
// assistant's server copy, in the `assistant` project with the other files that use it, and
// puts the model and effort back as it found them.
test.describe("the assistant's composer bar", () => {
  test.beforeEach(async ({ page }) => {
    const info: unknown = JSON.parse(
      await readFile(path.join(e2eAssistantHome, 'server.json'), 'utf8'),
    );
    await page.addInitScript((serverInfo) => {
      (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
    }, info);
  });

  test("the assistant's bar writes its settings @agent-workbench-10", async ({ page }) => {
    await page.goto('/assistant');
    const bar = page.getByTestId('model-bar');
    await expect(bar.getByRole('button', { name: 'Provider instance' })).toHaveText('Mock Claude');
    await expect(bar).toContainText('Read only');
    await expect(bar.getByRole('button', { name: 'Permission mode' })).toHaveCount(0);
    const model = bar.getByRole('button', { name: 'Model' });
    const effort = bar.getByRole('button', { name: 'Effort' });
    await expect(model).not.toHaveText('');
    const before = { model: await model.textContent(), effort: await effort.textContent() };

    // An option's name is its label and, for a model, its description after it.
    const pick = async (part: 'Model' | 'Effort', label: string) => {
      await bar.getByRole('button', { name: part }).click();
      await page
        .getByRole('listbox', { name: part })
        .getByRole('option')
        .filter({ has: page.getByText(label, { exact: true }) })
        .click();
    };
    await pick('Model', 'Mock model, large');
    await expect(model).toHaveText('Mock model, large');
    await pick('Effort', 'High');
    await expect(effort).toHaveText('High');

    await page.goto('/settings/assistant');
    await expect(page.getByTestId('setting-assistant.model').getByRole('textbox')).toHaveValue(
      'mock-model-large',
    );
    await expect(page.getByTestId('setting-assistant.effort').getByRole('textbox')).toHaveValue(
      'high',
    );

    // Back as it was: the thread on its earlier model and effort, the settings empty again.
    await page.goto('/assistant');
    await pick('Model', before.model ?? '');
    await expect(model).toHaveText(before.model ?? '');
    await pick('Effort', before.effort ?? '');
    await expect(effort).toHaveText(before.effort ?? '');
    await page.goto('/settings/assistant');
    for (const key of ['assistant.model', 'assistant.effort']) {
      await page.getByTestId(`setting-${key}`).getByText('Reset to default').click();
      await expect(page.getByTestId(`setting-${key}`).getByRole('textbox')).toHaveValue('');
    }
  });
});

const conversation = (page: Page) => page.getByRole('list', { name: 'Conversation' });

async function say(page: Page, text: string): Promise<void> {
  const composer = page.getByRole('combobox', { name: 'Message' });
  await composer.fill(text);
  await composer.press('Enter');
  await expect(conversation(page).getByTestId('item-user').filter({ hasText: text })).toBeVisible();
  await expect(conversation(page).locator(':scope > li').last()).toHaveAttribute(
    'data-testid',
    'item-assistant_text',
  );
}

// Agent workbench U13 (spec 41, 82, 95, 96) on the assistant's server copy: the rule is only
// proposed and waits for a yes on the line above the composer; wow's tool calls draw no raw
// row; a change row says its values as the settings page does. It leaves the server as it found
// it: the rule removed, the work hours undone.
test.describe('assistant polish', () => {
  test.use(sketching ? sketchUse : {});
  test.beforeEach(async ({ page }) => {
    const info: unknown = JSON.parse(
      await readFile(path.join(e2eAssistantHome, 'server.json'), 'utf8'),
    );
    await page.addInitScript((serverInfo) => {
      (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
    }, info);
  });

  test('the assistant proposes an always-allow rule @agent-workbench-41 @agent-workbench-82 @agent-workbench-95 @agent-workbench-96', async ({
    page,
  }) => {
    await page.goto('/assistant');
    await say(page, 'Make my work hours end at four, Monday to Friday');
    const row = page.getByRole('region', { name: 'Change: Work hours' }).last();
    await expect(row.getByTestId('assistant-change-values')).toHaveText(
      'From Outlook → 08:00–16:00, Mon–Fri',
    );

    await say(page, 'Always allow `pnpm test` in Demo');
    const card = page.getByRole('region', { name: 'Proposal: Always allow `pnpm test` in Demo' });
    await expect(card).toHaveAttribute('data-state', 'pending');
    await expect(card.getByRole('list', { name: 'What would change' })).toHaveText(
      'Always allow: new: Run commands starting with `pnpm test`',
    );
    // No raw tool row repeats the card or the change row; the read reads in words.
    await expect(conversation(page)).not.toContainText('mcp__wow__');
    await expect(conversation(page).getByTestId('tool-words').last()).toHaveText(
      'Read your projects',
    );
    const waiting = page.getByRole('status', { name: 'Waiting proposal' });
    await expect(waiting.getByTestId('assistant-waiting-text')).toHaveText(
      '1 proposal waits: Always allow `pnpm test` in Demo',
    );
    if (sketching) {
      await page.screenshot({
        path: sketchPath('2026-11-agent-workbench', 'assistant-polish'),
      });
    }

    // Nothing is stored before the yes.
    const approvals = await page.context().newPage();
    const info: unknown = JSON.parse(
      await readFile(path.join(e2eAssistantHome, 'server.json'), 'utf8'),
    );
    await approvals.addInitScript((serverInfo) => {
      (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
    }, info);
    await approvals.goto('/settings/approvals');
    await expect(approvals.getByTestId('setting-approvals.alwaysAllow')).toContainText('No rules');

    await waiting.getByRole('button', { name: 'Show' }).click();
    await expect(card).toBeFocused();
    await waiting.getByRole('button', { name: 'Yes' }).click();
    await expect(card).toHaveAttribute('data-state', 'accepted');
    await expect(waiting).toHaveCount(0);
    const rule = approvals
      .getByRole('region', { name: 'Rules of Demo' })
      .getByTestId('always-allow-rule');
    await expect(rule).toContainText('pnpm test');

    // As it was: the rule removed and the work hours back.
    await rule.getByRole('button', { name: 'Remove the rule in Demo' }).click();
    await expect(approvals.getByTestId('setting-approvals.alwaysAllow')).toContainText('No rules');
    await approvals.close();
    await row.getByRole('button', { name: 'Undo' }).click();
    await expect(row).toHaveAttribute('data-state', 'undone');
  });
});
