import { settingsRegistry, systemWorkHours } from '@wow/contracts';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fieldKind } from '@/settings/field-kind';
import { Field } from '@/settings/fields';
import { renderWithRuntime } from '@/test/render';
import { FromOutlookField, ZoneField } from './settings-fields';

describe('calendar settings that follow Outlook (F-8, audit B-08, B-09, B-20)', () => {
  it('picks the Outlook and zone editors from the schemas', () => {
    expect(fieldKind(settingsRegistry['calendar.zone'].schema)).toEqual({ kind: 'timeZone' });
    expect(fieldKind(settingsRegistry['calendar.workHours'].schema)).toMatchObject({
      kind: 'fromOutlook',
      inner: { kind: 'workHours' },
    });
    expect(fieldKind(settingsRegistry['calendar.firstDayOfWeek'].schema)).toMatchObject({
      kind: 'fromOutlook',
      inner: { kind: 'enum' },
    });
    expect(settingsRegistry['calendar.workHours'].default).toBe('outlook');
  });

  it('shows the fallback until Outlook is read, and Override starts from it', () => {
    const onChange = vi.fn<(next: unknown) => void>();
    renderWithRuntime(
      <FromOutlookField id="hours" preference="workHours" value="outlook" onChange={onChange}>
        <span>editor</span>
      </FromOutlookField>,
    );
    expect(screen.getByTestId('hours-outlook').textContent).toBe(
      'Outlook has not said yet, so wow uses 08:00–17:00, Mon–Fri',
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Override Outlook' }));
    expect(onChange).toHaveBeenCalledWith(systemWorkHours);
  });

  it('edits an override with Mon–Sun toggles and goes back to Outlook', () => {
    const onChange = vi.fn<(next: unknown) => void>();
    renderWithRuntime(
      <Field
        id="hours"
        label="Work hours"
        kind={fieldKind(settingsRegistry['calendar.workHours'].schema)}
        value={{ start: '09:00', end: '18:00', days: ['monday'] }}
        invalid={false}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Saturday' }));
    expect(onChange).toHaveBeenLastCalledWith({
      start: '09:00',
      end: '18:00',
      days: ['monday', 'saturday'],
    });
    fireEvent.click(screen.getByRole('switch', { name: 'Override Outlook' }));
    expect(onChange).toHaveBeenLastCalledWith('outlook');
  });

  it('offers Outlook and the system zone first in the zone picker', () => {
    renderWithRuntime(
      <ZoneField
        id="zone"
        label="Time zone"
        value="system"
        invalid={false}
        onChange={vi.fn<(next: unknown) => void>()}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Time zone' });
    expect(trigger.textContent).toMatch(/^System \(/);
  });
});
