import { settingsRegistry } from '@wow/contracts';
import { screen, within } from '@testing-library/react';
import { cleanup } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { settingGroupTitles, settingsByGroup } from '@/app/sections';
import { renderApp } from '@/test/render';
import { fieldKind } from './field-kind';

// Spec 33: every setting in the registry renders on its group's page with its description,
// default and current value, from the registry alone.

const formatDefault = (value: unknown): string =>
  typeof value === 'string' ? (value === '' ? '(none)' : value) : JSON.stringify(value);

describe('settings registry coverage', () => {
  it('gives every setting a group page, a label, a description and an editor', () => {
    const grouped = [...settingsByGroup().values()].flat().map(([key]) => key);
    expect(grouped.toSorted()).toEqual(Object.keys(settingsRegistry).toSorted());
    const incomplete = Object.entries(settingsRegistry)
      .filter(
        ([, definition]) =>
          definition.label === '' ||
          definition.description.length <= 10 ||
          !definition.schema.safeParse(definition.default).success ||
          !fieldKind(definition.schema).kind,
      )
      .map(([key]) => key);
    expect(incomplete).toEqual([]);
  });

  it.each([...settingsByGroup().entries()])('renders every %s setting', async (group, entries) => {
    await renderApp(`/settings/${group}`);
    expect(await screen.findByRole('heading', { name: settingGroupTitles[group] })).toBeTruthy();
    for (const [key, definition] of entries) {
      const row = within(screen.getByTestId(`setting-${key}`));
      expect(row.getByText(definition.label)).toBeTruthy();
      expect(row.getByText(definition.description)).toBeTruthy();
      expect(row.getByText(`${key} · default ${formatDefault(definition.default)}`)).toBeTruthy();
    }
    cleanup();
  });
});
