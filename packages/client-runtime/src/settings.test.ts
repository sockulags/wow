import { describe, expect, it } from 'vitest';
import {
  createMemorySettingsSource,
  createSettingsStore,
  resolveSetting,
  settingValue,
} from './settings.js';
import { settingsRegistry } from '@wow/contracts';

describe('settings', () => {
  it('starts from defaults and applies a valid write', async () => {
    const store = createSettingsStore(createMemorySettingsSource());
    expect(store.getState().ready).toBe(true);
    expect(settingValue(store.getState().values, 'appearance.theme')).toBe('dark');

    await expect(store.write('appearance.theme', 'light')).resolves.toEqual({ ok: true });
    expect(settingValue(store.getState().values, 'appearance.theme')).toBe('light');

    await store.reset('appearance.theme');
    expect(settingValue(store.getState().values, 'appearance.theme')).toBe('dark');
  });

  it('rejects an invalid value with readable issues and keeps the old one', async () => {
    const store = createSettingsStore(createMemorySettingsSource());
    const result = await store.write('calendar.workHours', {
      start: '17:00',
      end: '08:00',
      days: ['monday'],
    });
    expect(result).toEqual({ ok: false, issues: ['end: Work hours must end after they start'] });
    expect(settingValue(store.getState().values, 'calendar.workHours').start).toBe('08:00');
  });

  it('rejects unknown keys', async () => {
    const store = createSettingsStore(createMemorySettingsSource());
    await expect(store.write('nope', 1)).resolves.toEqual({
      ok: false,
      issues: ['Unknown setting "nope"'],
    });
  });

  it('falls back to the default when a stored value no longer fits the schema', () => {
    expect(
      resolveSetting(settingsRegistry, { 'calendar.lookaheadDays': 500 }, 'calendar.lookaheadDays'),
    ).toBe(14);
  });
});
