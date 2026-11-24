import { settingsRegistry } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { keyConflicts, keyScope } from './keybindings-table';

// Issue #64: the default keys share no key where both can fire, and the check still finds a real
// clash.

const defaults = Object.fromEntries(
  Object.entries(settingsRegistry)
    .filter(([key]) => key.startsWith('keybindings.'))
    .map(([key, definition]) => [key, String(definition.default)]),
);

describe('keybinding clashes', () => {
  it('finds none among the defaults', () => {
    expect([...keyConflicts(defaults).keys()]).toEqual([]);
  });

  it('still finds two global keys on the same binding', () => {
    const clashing = {
      ...defaults,
      'keybindings.palette': defaults['keybindings.toggleSidebar'] ?? '',
    };
    expect(keyConflicts(clashing).get('keybindings.palette')).toContain(
      'keybindings.toggleSidebar',
    );
  });

  it('places the dialog, approval and changes keys where they fire', () => {
    expect(keyScope('keybindings.commitConfirm')).toBe('Dialog');
    expect(keyScope('keybindings.calendarSaveCard')).toBe('Dialog');
    expect(keyScope('keybindings.approvalDeny')).toBe('Approval');
    expect(keyScope('keybindings.threadChanges')).toBe('Chat');
  });
});
