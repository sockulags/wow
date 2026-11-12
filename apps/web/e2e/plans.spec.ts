import { expect, test, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { e2eHome } from './env';
import { e2eLiveIntentId, e2eLivePlan, e2ePlansDir } from './plans-seed';
import { sketchPath, sketching, sketchUse } from './sketch';

// U5 ground truth (review loop spec 21, 22, 24, 25) against invented plan files in the seeded
// project's `plan-files` folder (e2e/plans-seed.ts). No plan is followed here, so every status is
// what the files alone say; e2e/hosts.spec.ts follows one.

test.beforeEach(async ({ page }) => {
  // What the desktop preload injects: the contents of `~/.wow/server.json`.
  const info: unknown = JSON.parse(await readFile(path.join(e2eHome, 'server.json'), 'utf8'));
  await page.addInitScript((serverInfo) => {
    (globalThis as { wowServerInfo?: unknown }).wowServerInfo = serverInfo;
  }, info);
});

const plans = (page: Page) => page.getByRole('navigation', { name: 'Plans' });
const unit = (page: Page, key: string) => page.getByTestId(`unit-${key}`);

async function openTeaTimer(page: Page): Promise<void> {
  await page.goto('/plans');
  await plans(page)
    .getByRole('link', { name: /A tea timer that rings/ })
    .click();
  await expect(page.getByRole('heading', { name: /A tea timer that rings/ })).toBeVisible();
}

test.describe('plans', () => {
  test('plans view lists units @review-loop-21', async ({ page }) => {
    await page.goto('/calendar');
    await page
      .getByRole('navigation', { name: 'Sections' })
      .getByRole('link', { name: 'Plans' })
      .click();
    await expect(page).toHaveURL(/\/plans$/);

    // Every intent of the project with status, revision and which files it has (spec 21).
    const demo = plans(page).getByRole('region', { name: 'Demo' });
    await expect(demo.getByRole('link')).toHaveCount(5);
    const tea = demo.getByRole('link', { name: /A tea timer that rings/ });
    await expect(tea).toContainText('accepted · rev 2');
    await expect(tea).toContainText('spec');
    await expect(tea).toContainText('plan');
    await expect(tea).toContainText('stale');
    await expect(demo.getByRole('link', { name: /A seed swap list/ })).toContainText(
      'accepted · rev 1· no spec· no plan',
    );

    await tea.click();
    const files = page.getByRole('region', { name: 'Files' });
    await expect(files.getByTestId('plan-file-intent.md')).toContainText('accepted · rev 2');
    await expect(files.getByTestId('plan-file-spec.md')).toContainText(
      'Stale: built on intent@1, intent.md is at rev 2',
    );
    await expect(files.getByTestId('plan-file-plan.md')).toContainText('units in files');
    await expect(files.getByTestId('plan-file-plan.md')).not.toContainText('Stale');

    // Keys, titles, dependencies and the blocked note from both dash forms (spec 22).
    const units = page.getByRole('region', { name: 'Units' });
    await expect(units.getByTestId('unit-key')).toHaveText(['U1', 'U2', 'U3', 'U4']);
    await expect(unit(page, 'U2').getByTestId('unit-title')).toHaveText('Ring the bell at zero');
    await expect(unit(page, 'U2').getByTestId('unit-depends')).toHaveText('Depends on U1');
    await expect(unit(page, 'U2').getByTestId('unit-blocked')).toHaveText(
      'Blocked: the bell is on order',
    );
    await expect(unit(page, 'U3').getByTestId('unit-depends')).toHaveText('Depends on U1, U2');
    await expect(unit(page, 'U1').getByTestId('unit-depends')).toHaveCount(0);

    // Not followed, so no host is asked: blocked, or status unknown with the reason (spec 24).
    await expect(unit(page, 'U2').getByTestId('unit-status')).toHaveText('Blocked');
    await expect(unit(page, 'U1').getByTestId('unit-status')).toHaveText('Status unknown');
    await expect(unit(page, 'U3').getByTestId('unit-status')).toHaveText('Status unknown');
    await expect(units.getByTestId('unit-status-reason')).toHaveText(
      'Status unknown: This plan is not followed, so only its files are read.',
    );
  });

  test('shows a unit contract for source: files, with absent fields said so', async ({ page }) => {
    await openTeaTimer(page);
    await expect(page.getByTestId('unit-contract')).toHaveCount(0);
    await page.getByRole('button', { name: 'Contract of U1' }).click();
    await expect(page).toHaveURL(/unit=U1/);
    const contract = unit(page, 'U1').getByTestId('unit-contract');
    await expect(contract.getByRole('term')).toHaveText([
      'Outcome',
      'Boundaries',
      'Change surface',
      'Acceptance',
      'Ground truth',
      'Dependencies',
      'Evidence and settled decisions',
      'Delivery target',
      'Open risks',
    ]);
    await expect(contract).toContainText('the timer counts down from one to twenty minutes');
    await expect(contract.getByRole('listitem')).toHaveCount(2);
    await expect(contract.getByText('Not in this contract')).toHaveCount(0);

    // An older plan without some fields shows them as absent, not as problems.
    await page.getByRole('button', { name: 'Contract of U3' }).click();
    await expect(unit(page, 'U1').getByTestId('unit-contract')).toHaveCount(0);
    const older = unit(page, 'U3').getByTestId('unit-contract');
    await expect(older).toContainText('the lid shows minutes and seconds left');
    await expect(older.getByText('Not in this contract')).toHaveCount(7);
    await expect(page.getByRole('region', { name: 'Problems' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Contract of U3' }).click();
    await expect(page.getByTestId('unit-contract')).toHaveCount(0);
  });

  test('shows key and title only for source: issues', async ({ page }) => {
    await page.goto('/plans');
    await plans(page)
      .getByRole('link', { name: /A kettle that stops/ })
      .click();
    const units = page.getByRole('region', { name: 'Units' });
    await expect(units.getByTestId('unit-key')).toHaveText(['K-1', 'K-2']);
    await expect(units.getByTestId('unit-title')).toHaveText([
      'Boil to a chosen temperature',
      'Keep warm for ten minutes',
    ]);
    await expect(page.getByTestId('plan-file-plan.md')).toContainText('units in issues');
    await expect(units.getByRole('button')).toHaveCount(0);
    await expect(units.getByTestId('unit-depends')).toHaveCount(0);
    await expect(units.getByTestId('unit-blocked')).toHaveText(
      'Blocked: the thermostat is on order',
    );
  });

  test('lists a plan that cannot be read with its problem and line', async ({ page }) => {
    await page.goto('/plans');
    const broken = plans(page).getByRole('link', { name: /Raised beds watered/ });
    await expect(broken).toContainText('1 problem');
    // The other intents still show.
    await expect(plans(page).getByRole('link')).toHaveCount(5);
    await broken.click();
    await expect(page.getByRole('region', { name: 'Problems' }).getByRole('listitem')).toHaveText([
      'plan.md line 11: "## Units" has no "- [KEY] title" lines',
    ]);
    await expect(page.getByTestId('unit-key')).toHaveCount(0);
  });

  test('follows a plan file that changes on disk', async ({ page }) => {
    const file = path.join(e2ePlansDir(e2eHome), e2eLiveIntentId, 'plan.md');
    await writeFile(file, e2eLivePlan('- [C1] Weigh what goes in'));
    await page.goto('/plans');
    await plans(page)
      .getByRole('link', { name: /A compost log/ })
      .click();
    await expect(page.getByTestId('unit-key')).toHaveText(['C1']);

    await writeFile(file, e2eLivePlan('- [C1] Weigh what goes in\n- [C2] Turn the heap weekly'));
    await expect(page.getByTestId('unit-key')).toHaveText(['C1', 'C2']);
    await expect(unit(page, 'C2').getByTestId('unit-title')).toHaveText('Turn the heap weekly');
  });

  test('opens plans, units and a refresh from the palette and the keyboard', async ({ page }) => {
    await page.goto('/calendar');
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
    await page.keyboard.press('Control+4');
    await expect(page).toHaveURL(/\/plans$/);

    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await expect(palette.getByRole('option', { name: /Refresh now/ })).toBeVisible();
    await palette.getByRole('combobox').fill('kettle that stops');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: /A kettle that stops/ })).toBeVisible();

    await openTeaTimer(page);
    await page.keyboard.press('Control+k');
    await palette.getByRole('combobox').fill('unit u2');
    await page.keyboard.press('Enter');
    await expect(unit(page, 'U2').getByTestId('unit-contract')).toContainText(
      'a bell rings once when the timer reaches zero',
    );

    await plans(page).getByRole('button', { name: 'Refresh now' }).click();
    await expect(unit(page, 'U2').getByTestId('unit-contract')).toBeVisible();
  });
});

test.describe('sketch', () => {
  test.skip(!sketching, 'Set WOW_E2E_SKETCHES to write the screenshots');
  test.use(sketchUse);

  test('plans', async ({ page }) => {
    await openTeaTimer(page);
    await page.getByRole('button', { name: 'Contract of U1' }).click();
    await expect(unit(page, 'U1').getByTestId('unit-contract').getByRole('listitem')).toHaveCount(
      2,
    );
    await page.screenshot({ path: sketchPath('2026-11-review-loop', 'plans') });
  });
});
