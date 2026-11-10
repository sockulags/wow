import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { choose, withOptions } from './controls';
import { e2eChangesHome, e2eHostileSkillName, e2eRulesWorkflowId } from './env';
import { sketchPath, sketching, sketchUse } from './sketch';

// Workflow branches U2 ground truth (spec 14 to 17) against the Changes copy of the e2e server:
// rules under "After this step" in the builder and the diagram of the paths a run can take.
// The workflow is made from the Initiative template; nothing is run here.

if (sketching) test.use(sketchUse);

const intent = '2026-11-workflow-branches';

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
const rulesOf = (step: Locator, number: number) =>
  step.getByRole('list', { name: `Step ${number} rules` });
const diagram = (page: Page) =>
  page.getByRole('region', { name: 'Paths' }).getByRole('img', { name: 'Diagram' });
// What the diagram's arrows say, in the order they were written.
const arrowWords = (page: Page) => diagram(page).locator('.edgeLabel').filter({ hasText: /\S/ });
const boxWords = (page: Page) => diagram(page).locator('.node');

// A box's words as the diagram draws them. A label that does not fit on one line is drawn one
// word per line, and then the text has no space between them; which labels fit depends on the
// machine's fonts.
const drawn = (label: string) =>
  new RegExp(
    `^${label
      .split(' ')
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
      .join(String.raw`\s*`)}$`,
  );

test.describe('workflow rules', () => {
  test('build a workflow with a loop', async ({ page }) => {
    await page.goto('/workflows/new?template=initiative');
    await builder(page).getByLabel('Workflow name').fill('Initiative with a loop');

    // Without rules the diagram is a straight line: the steps in list order between Start and
    // End, and the three gates of the template (spec 15, 17).
    await expect(boxWords(page)).toHaveText([
      drawn('Start'),
      drawn('1. capture-intent'),
      drawn('2. plan-work'),
      drawn('3. shape-work'),
      drawn('4. deliver-work'),
      drawn('5. check-work'),
      drawn('End'),
    ]);
    await expect(arrowWords(page)).toHaveText(['gate', 'gate', 'gate']);

    // A step without expected artifacts is not offered the artifacts fact; one with them is
    // (spec 16).
    const check = stepAt(page, 5);
    const rules = rulesOf(check, 5);
    await expect(rules.getByRole('listitem')).toHaveText([
      'Otherwise: the next step (this is the last step, so the run ends)',
    ]);
    await expect(rulesOf(stepAt(page, 1), 1).getByRole('listitem')).toHaveText([
      'Otherwise: the next step',
    ]);
    await check.getByRole('button', { name: 'Add rule' }).click();
    await withOptions(rules.getByLabel('Step 5 rule 1 fact'), async (options) => {
      await expect(options).toHaveText(['the verdict is', 'the checks are', 'the step failed']);
    });
    const capture = stepAt(page, 1);
    await capture.getByRole('button', { name: 'Add rule' }).click();
    await withOptions(capture.getByLabel('Step 1 rule 1 fact'), async (options) => {
      await expect(options).toHaveText([
        'the verdict is',
        'the checks are',
        'the expected artifacts are',
        'the step failed',
      ]);
    });
    await capture.getByRole('button', { name: 'Remove step 1 rule 1' }).click();
    await expect(rulesOf(capture, 1).getByTestId('step-rule')).toHaveCount(0);

    // The user picks fact, value and target; "Otherwise: the next step" stays last (spec 14).
    await choose(rules.getByLabel('Step 5 rule 1 fact'), 'the verdict is');
    await choose(rules.getByLabel('Step 5 rule 1 value'), 'blocked');
    await choose(rules.getByLabel('Step 5 rule 1 target'), 'End');
    // The second rule is added with its key, and the keyboard is on it.
    await expect(rules.getByLabel('Step 5 rule 1 target')).toBeFocused();
    await page.keyboard.press('Alt+R');
    await expect(rules.getByLabel('Step 5 rule 2 fact')).toBeFocused();
    await choose(rules.getByLabel('Step 5 rule 2 value'), 'changes requested');
    await choose(rules.getByLabel('Step 5 rule 2 target'), '4. deliver-work');
    await expect(rules.getByRole('listitem')).toHaveText([
      /the verdict is.*blocked.*go to.*End/,
      /the verdict is.*changes requested.*go to.*4\. deliver-work/,
      'Otherwise: the next step (this is the last step, so the run ends)',
    ]);

    // The diagram follows: a dotted arrow per rule with its condition, and "otherwise" on the
    // way to the next step.
    await expect(arrowWords(page)).toHaveText([
      'gate',
      'gate',
      'gate',
      'verdict blocked',
      'verdict changes requested',
      'otherwise',
    ]);

    // The second rule moves up by keyboard, and the keyboard stays on it.
    await rules.getByLabel('Step 5 rule 2 target').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(rules.getByLabel('Step 5 rule 1 target')).toBeFocused();
    await expect(rules.getByLabel('Step 5 rule 1 value')).toHaveText('changes requested');
    await expect(rules.getByLabel('Step 5 rule 2 value')).toHaveText('blocked');

    await builder(page).getByRole('button', { name: 'Create workflow' }).click();
    await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);

    // Saved with the rules in that order.
    await page.reload();
    await expect(stepAt(page, 5)).toContainText('2 rules');
    await expect(arrowWords(page)).toHaveText([
      'gate',
      'gate',
      'gate',
      'verdict changes requested',
      'verdict blocked',
      'otherwise',
    ]);
    if (sketching) {
      // Tall enough for the whole diagram, then back to the size of the other screenshots.
      await page.setViewportSize({ ...sketchUse.viewport, height: 1500 });
      await page.screenshot({ path: sketchPath(intent, 'paths-diagram') });
      await page.setViewportSize(sketchUse.viewport);
    }
    await page.getByRole('button', { name: 'Expand step 5' }).click();
    const saved = rulesOf(stepAt(page, 5), 5);
    await expect(saved.getByLabel('Step 5 rule 1 value')).toHaveText('changes requested');
    await expect(saved.getByLabel('Step 5 rule 1 target')).toHaveText('4. deliver-work');
    await expect(saved.getByLabel('Step 5 rule 2 value')).toHaveText('blocked');
    await expect(saved.getByLabel('Step 5 rule 2 target')).toHaveText('End');
    if (sketching) {
      await saved.scrollIntoViewIfNeeded();
      await page.screenshot({ path: sketchPath(intent, 'step-rules') });
    }

    // An edited rule changes the diagram before anything is saved (spec 15).
    await choose(saved.getByLabel('Step 5 rule 1 value'), 'not given');
    await expect(arrowWords(page)).toHaveText([
      'gate',
      'gate',
      'gate',
      'no verdict',
      'verdict blocked',
      'otherwise',
    ]);

    // The step a rule goes to is deleted: the rule is marked with the server's reason, and the
    // server refuses the workflow with the same reason (spec 16).
    await stepAt(page, 4).getByRole('button', { name: 'Remove step 4' }).click();
    const left = rulesOf(stepAt(page, 4), 4);
    await expect(left.getByLabel('Step 4 rule 1 target')).toHaveText(
      'A step that no longer exists',
    );
    await expect(left.getByTestId('step-rule').nth(0).getByRole('alert')).toHaveText(
      'The rule "no verdict" goes to a step that no longer exists',
    );
    await builder(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      builder(page).getByRole('alert').filter({ hasText: 'Step check-work, rule 1:' }),
    ).toHaveText(
      'Step check-work, rule 1: The rule "no verdict" goes to a step that no longer exists',
    );
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toHaveCount(0);
    // Pointing the rule at a step that exists makes it saveable again.
    await choose(left.getByLabel('Step 4 rule 1 target'), '3. shape-work');
    await expect(left.getByRole('alert')).toHaveCount(0);
    await builder(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  });

  test('a step name with quotes, brackets and a line break is drawn as text', async ({ page }) => {
    await page.goto(`/workflows/${e2eRulesWorkflowId}`);
    await expect(boxWords(page)).toHaveCount(4);
    // A long name is drawn on several lines, one piece of text per word.
    const words = await boxWords(page)
      .nth(2)
      .locator('.text-inner-tspan')
      .evaluateAll((pieces) => pieces.map((piece) => (piece.textContent ?? '').trim()).join(' '));
    expect(words).toBe(`2. ${e2eHostileSkillName.replace('\n', ' ')}`);
    await expect(page.getByRole('region', { name: 'Paths' }).getByRole('note')).toHaveCount(0);
    // The name stayed text: it made no element and no link in the drawing.
    await expect(diagram(page).locator('b, a, image, foreignObject')).toHaveCount(0);
  });
});
