import type { Locator } from '@playwright/test';

// The themed Select and Combobox controls open their list in a portal, so the option is found on
// the page rather than inside the trigger.
export async function choose(trigger: Locator, option: string | RegExp): Promise<void> {
  await trigger.click();
  await trigger
    .page()
    .getByRole('option', { name: option, exact: typeof option === 'string' })
    .click();
}

// Opens the list, hands its options to the check, and closes it again.
export async function withOptions(
  trigger: Locator,
  check: (options: Locator) => Promise<void>,
): Promise<void> {
  await trigger.click();
  await check(trigger.page().getByRole('option'));
  await trigger.page().keyboard.press('Escape');
}
