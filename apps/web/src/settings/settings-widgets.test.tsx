import { screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render';
import { keyConflicts, keyScope } from './keybindings-table';

// Audit E-06, E-07, E-10, E-11, E-18: labels instead of ids, units as suffixes, work hours as
// time fields, Reset only when changed, keybindings with conflicts.

describe('settings widgets', () => {
  it('shows milliseconds as seconds and stores milliseconds', async () => {
    const { runtime } = await renderApp('/settings/providers');
    const input = await screen.findByLabelText('Test timeout');
    expect((input as HTMLInputElement).value).toBe('120');
    const row = within(screen.getByTestId('setting-providers.testTimeoutMs'));
    expect(row.getByText('s')).toBeTruthy();
    fireEvent.change(input, { target: { value: '90' } });
    expect(runtime.settings.getState().values['providers.testTimeoutMs']).toBe(90_000);
  });

  it('names enum values and offers radio choices with descriptions', async () => {
    const user = userEvent.setup();
    const { runtime } = await renderApp('/settings/scheduler');
    const row = within(await screen.findByTestId('setting-scheduler.missedPolicy'));
    expect(
      row.getByText('Show them as missed on the calendar with a "Run now" action.'),
    ).toBeTruthy();
    await user.click(row.getByRole('radio', { name: 'Run them now' }));
    expect(runtime.settings.getState().values['scheduler.missedPolicy']).toBe('run');
  });

  it('edits work hours with time fields and day toggles', async () => {
    const user = userEvent.setup();
    const { runtime } = await renderApp('/settings/calendar');
    const row = within(await screen.findByTestId('setting-calendar.workHours'));
    await user.click(row.getByRole('button', { name: 'Saturday' }));
    expect(runtime.settings.getState().values['calendar.workHours']).toEqual({
      start: '08:00',
      end: '17:00',
      days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
    });
  });

  it('offers Reset only when the value differs from the default', async () => {
    const user = userEvent.setup();
    await renderApp('/settings/calendar');
    const row = within(await screen.findByTestId('setting-calendar.hourHeight'));
    expect(row.queryAllByRole('button', { name: /^Reset/ })).toEqual([]);
    fireEvent.change(row.getByLabelText('Hour height'), { target: { value: '60' } });
    const [reset] = row.getAllByRole('button', { name: 'Reset Hour height to default' });
    await user.click(reset!);
    expect(row.queryAllByRole('button', { name: /^Reset/ })).toEqual([]);
  });

  it('hides the Jira email for Server sign-in', async () => {
    const user = userEvent.setup();
    await renderApp('/settings/trackers');
    expect(await screen.findByTestId('setting-trackers.jira.email')).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: 'Jira Server or Data Center' }));
    expect(screen.queryByTestId('setting-trackers.jira.email')).toBeNull();
  });

  it('finds settings across groups', async () => {
    const user = userEvent.setup();
    await renderApp('/settings/providers');
    await user.type(await screen.findByLabelText('Search settings'), 'poll');
    expect(screen.getByRole('heading', { name: 'Search results' })).toBeTruthy();
    expect(screen.getByTestId('setting-outlook.pollSeconds')).toBeTruthy();
  });
});

describe('keybindings', () => {
  it('groups by where a key works and marks conflicts that can fire together', () => {
    expect(keyScope('keybindings.calendarToday')).toBe('Calendar');
    expect(keyScope('keybindings.stopTurn')).toBe('Chat');
    expect(keyScope('keybindings.palette')).toBe('General');
    const conflicts = keyConflicts({
      'keybindings.palette': 'Mod+K',
      'keybindings.calendarToday': 'Ctrl+K',
      'keybindings.newCard': 'C',
      'keybindings.stopTurn': 'C',
    });
    expect(conflicts.get('keybindings.palette')).toEqual(['keybindings.calendarToday']);
    expect(conflicts.has('keybindings.newCard')).toBe(false);
  });
});
