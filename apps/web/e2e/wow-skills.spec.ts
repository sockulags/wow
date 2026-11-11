import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { choose } from './controls';
import { e2eChangesHome } from './env';
import { sketchPath, sketching, sketchUse } from './sketch';

// wow skills U2 ground truth (spec 3, 5, 7, 11, 12) against the Changes copy of the e2e server:
// write a skill in Settings → Skills and add it to a step, and see wow-verdict attached by
// itself to a step whose rule reads the verdict. The skill is invented.

if (sketching) test.use(sketchUse);

const intent = '2026-11-wow-skills';

test.beforeEach(async ({ page }) => {
  // What the desktop preload injects: the contents of `~/.wow/server.json`.
  const info: unknown = JSON.parse(
    await readFile(path.join(e2eChangesHome, 'server.json'), 'utf8'),
  );
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

const builder = (page: Page) => page.getByRole('form', { name: 'Workflow builder' });
const stepAt = (page: Page, number: number) =>
  builder(page)
    .getByRole('list', { name: 'Steps' })
    .getByTestId('workflow-step')
    .nth(number - 1);

const skillText = [
  'Before you change anything, read the tea timer notes in docs/timer.md.',
  'Keep every message to the user under five lines.',
].join('\n');

test.describe('wow skills in Settings and the builder', () => {
  test('write a skill and add it to a step', async ({ page }) => {
    await page.goto('/settings/skills');
    const yours = page.getByRole('region', { name: 'Your skills' });
    // The built-in skills are listed read-only with their text (spec 3).
    const builtIn = page.getByRole('region', { name: 'Built-in skills' });
    await expect(builtIn.getByTestId('built-in-skill')).toHaveCount(4);
    await expect(builtIn.getByRole('button', { name: /Edit|Delete/ })).toHaveCount(0);

    await yours.getByRole('button', { name: 'New skill' }).click();
    const editor = page.getByRole('dialog', { name: 'New skill' });
    // The name rule's reason is shown and nothing is saved (spec 5).
    await editor.getByLabel('Name').fill('wow-timer');
    await editor.getByLabel('Text').fill(skillText);
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toContainText(
      'Names starting with wow- are kept for the skills wow ships',
    );
    await editor.getByLabel('Name').fill('tea-timer-notes');
    await editor.getByLabel('When to use it').fill('Whenever the tea timer changes.');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toBeHidden();
    const row = yours.getByRole('listitem', { name: 'tea-timer-notes' });
    await expect(row).toContainText('Whenever the tea timer changes.');
    if (sketching) {
      await row.getByText('Show the text').click();
      await page
        .getByRole('region', { name: 'Built-in skills' })
        .getByRole('listitem', { name: 'wow-verdict' })
        .getByText('Show the text')
        .click();
      await page.screenshot({ path: sketchPath(intent, 'your-skills'), fullPage: true });
    }

    // Yours come first in the step's lists (spec 7), and Also follow adds it (spec 11).
    await page.goto('/workflows/new?template=bug');
    await builder(page).getByLabel('Workflow name').fill('Bug with notes');
    const deliver = stepAt(page, 1);
    const follow = deliver.getByTestId('also-follow');
    await deliver.getByRole('combobox', { name: 'Step 1 also follow' }).click();
    await expect(page.getByRole('option').first()).toHaveText(/^tea-timer-notes\s*Yours/);
    await page.getByRole('option', { name: /^tea-timer-notes/ }).click();
    await expect(follow).toContainText('tea-timer-notes');
    await builder(page).getByRole('button', { name: 'Create workflow' }).click();
    await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);

    // Saved with the step.
    await page.reload();
    await stepAt(page, 1).getByRole('button', { name: 'Expand step 1' }).click();
    await expect(stepAt(page, 1).getByTestId('also-follow')).toContainText('tea-timer-notes');

    // The palette edits and deletes it, with Undo.
    await page.goto('/settings/skills');
    await expect(yours.getByRole('listitem', { name: 'tea-timer-notes' })).toBeVisible();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await palette.getByRole('combobox').fill('Delete skill: tea-timer-notes');
    await palette.getByRole('option', { name: /Delete skill: tea-timer-notes/ }).click();
    await expect(yours.getByRole('listitem', { name: 'tea-timer-notes' })).toBeHidden();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(yours.getByRole('listitem', { name: 'tea-timer-notes' })).toBeVisible();
  });

  test('wow-verdict is attached by itself', async ({ page }) => {
    await page.goto('/workflows/new?template=bug');
    await builder(page).getByLabel('Workflow name').fill('Bug with a verdict');
    // The Bug template's check-work goes back when the verdict is changes requested, so wow
    // attaches wow-verdict to it, with the reason (spec 12).
    const check = stepAt(page, 2);
    const attached = check.getByRole('region', { name: 'Step 2 skills attached by wow' });
    await expect(attached.getByTestId('attached-skill')).toHaveText([
      /wow-verdict.*Because a rule of this step reads the verdict\./,
    ]);
    await expect(
      stepAt(page, 1).getByRole('region', { name: 'Step 1 skills attached by wow' }),
    ).toHaveCount(0);

    // A step can leave it out, and that is saved.
    await attached.getByRole('button', { name: 'Leave wow-verdict out of step 2' }).click();
    await expect(attached.getByTestId('attached-skill')).toContainText('Left out');
    await builder(page).getByRole('button', { name: 'Create workflow' }).click();
    await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);
    await page.reload();
    await stepAt(page, 2).getByRole('button', { name: 'Expand step 2' }).click();
    const saved = stepAt(page, 2).getByRole('region', { name: 'Step 2 skills attached by wow' });
    await expect(saved.getByTestId('attached-skill')).toContainText('Left out');
    await saved.getByRole('button', { name: 'Attach wow-verdict to step 2 again' }).click();
    await expect(saved.getByTestId('attached-skill')).toContainText('Because a rule');
    // Picked as a skill to also follow, it is no longer attached by itself.
    await choose(stepAt(page, 2).getByLabel('Step 2 also follow'), /^wow-verdict/);
    await expect(saved).toHaveCount(0);
  });
});
