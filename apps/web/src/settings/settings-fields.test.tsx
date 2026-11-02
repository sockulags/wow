import { KeyValueList, Keybinding, type SettingDefinition } from '@wow/contracts';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestRuntime, renderWithRuntime } from '@/test/render';
import { fieldKind } from './field-kind';
import { SettingsForm } from './settings-page';

// One setting of every field type the settings page can render.
const definitions = {
  'advanced.name': {
    schema: z.string().min(2, 'At least two characters'),
    group: 'advanced',
    label: 'Name',
    description: 'A text field.',
    default: 'wow',
    scope: 'global',
  },
  'advanced.port': {
    schema: z.number().int().min(1024).max(65535),
    group: 'advanced',
    label: 'Port',
    description: 'A number field.',
    default: 4317,
    scope: 'global',
    restartRequired: true,
  },
  'advanced.enabled': {
    schema: z.boolean(),
    group: 'advanced',
    label: 'Enabled',
    description: 'A boolean field.',
    default: false,
    scope: 'global',
  },
  'advanced.level': {
    schema: z.enum(['debug', 'info', 'warn']),
    group: 'advanced',
    label: 'Log level',
    description: 'An enum field.',
    default: 'info',
    scope: 'global',
  },
  'advanced.folders': {
    schema: z.array(z.string().min(1, 'Folder cannot be empty')),
    group: 'advanced',
    label: 'Folders',
    description: 'A list field.',
    default: ['Inbox'],
    scope: 'global',
  },
  'advanced.days': {
    schema: z.array(z.enum(['monday', 'tuesday'])).min(1, 'Pick at least one day'),
    group: 'advanced',
    label: 'Days',
    description: 'A list of choices.',
    default: ['monday'],
    scope: 'global',
  },
  'advanced.env': {
    schema: KeyValueList,
    group: 'advanced',
    label: 'Environment',
    description: 'A key-value field with secret flags.',
    default: [{ key: 'TOKEN', value: 'abc', secret: true }],
    scope: 'provider',
    secret: true,
  },
  'advanced.shortcut': {
    schema: Keybinding,
    group: 'advanced',
    label: 'Shortcut',
    description: 'A keybinding field.',
    default: 'Mod+K',
    scope: 'global',
  },
  'advanced.hours': {
    schema: z
      .object({ start: z.string(), end: z.string() })
      .refine((hours) => hours.start < hours.end, { message: 'End after start', path: ['end'] }),
    group: 'advanced',
    label: 'Hours',
    description: 'An object field.',
    default: { start: '08:00', end: '17:00' },
    scope: 'global',
  },
} satisfies Record<string, SettingDefinition>;

function setup(initial: Record<string, unknown> = {}) {
  const runtime = createTestRuntime(definitions, initial);
  const view = renderWithRuntime(<SettingsForm entries={Object.entries(definitions)} />, runtime);
  const row = (key: keyof typeof definitions) => within(screen.getByTestId(`setting-${key}`));
  const value = (key: keyof typeof definitions) => runtime.settings.getState().values[key];
  return { ...view, row, value, user: userEvent.setup() };
}

describe('field kinds', () => {
  it('maps each schema to its editor', () => {
    expect(Object.values(definitions).map((d) => fieldKind(d.schema).kind)).toEqual([
      'text',
      'number',
      'boolean',
      'enum',
      'list',
      'list',
      'keyValue',
      'keybinding',
      'object',
    ]);
    expect(fieldKind(definitions['advanced.port'].schema)).toEqual({
      kind: 'number',
      min: 1024,
      max: 65535,
      integer: true,
    });
  });
});

describe('generated settings fields', () => {
  it('renders label, description, default and restart marker', () => {
    const { row } = setup({ 'advanced.showSettingKeys': true });
    expect(row('advanced.port').getByText('Port')).toBeTruthy();
    expect(row('advanced.port').getByText('A number field.')).toBeTruthy();
    expect(row('advanced.port').getByText('Restart required')).toBeTruthy();
    expect(row('advanced.port').getByText(/default 4317/)).toBeTruthy();
  });

  it('text: writes valid input and reports invalid input without writing', async () => {
    const { row, value, user } = setup();
    const input = row('advanced.name').getByLabelText('Name');
    await user.clear(input);
    await user.type(input, 'x');
    expect(row('advanced.name').getByRole('alert').textContent).toContain('At least two');
    expect(value('advanced.name')).toBeUndefined();
    await user.type(input, 'y');
    expect(value('advanced.name')).toBe('xy');
    expect(row('advanced.name').queryByRole('alert')).toBeNull();
  });

  it('number: enforces the range', async () => {
    const { row, value } = setup();
    const input = row('advanced.port').getByLabelText('Port');
    fireEvent.change(input, { target: { value: '80' } });
    expect(row('advanced.port').getByRole('alert').textContent).toMatch(/>=\s*1024/);
    expect(value('advanced.port')).toBeUndefined();
    fireEvent.change(input, { target: { value: '5000' } });
    expect(value('advanced.port')).toBe(5000);
  });

  it('boolean: toggles', async () => {
    const { row, value, user } = setup();
    await user.click(row('advanced.enabled').getByRole('switch'));
    expect(value('advanced.enabled')).toBe(true);
  });

  it('enum: picks an option', async () => {
    const { row, value, user } = setup();
    await user.click(row('advanced.level').getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'warn' }));
    expect(value('advanced.level')).toBe('warn');
  });

  it('list: adds, edits and rejects an empty entry', async () => {
    const { row, value, user } = setup();
    await user.click(row('advanced.folders').getByRole('button', { name: 'Add' }));
    expect(row('advanced.folders').getByRole('alert').textContent).toContain('cannot be empty');
    await user.type(row('advanced.folders').getByLabelText('Folders 2'), 'Archive');
    expect(value('advanced.folders')).toEqual(['Inbox', 'Archive']);
    await user.click(row('advanced.folders').getByRole('button', { name: 'Remove Folders 1' }));
    expect(value('advanced.folders')).toEqual(['Archive']);
  });

  it('list of choices: keeps at least one', async () => {
    const { row, value, user } = setup();
    await user.click(row('advanced.days').getByRole('checkbox', { name: 'tuesday' }));
    expect(value('advanced.days')).toEqual(['monday', 'tuesday']);
    await user.click(row('advanced.days').getByRole('checkbox', { name: 'monday' }));
    await user.click(row('advanced.days').getByRole('checkbox', { name: 'tuesday' }));
    expect(row('advanced.days').getByRole('alert').textContent).toContain('at least one');
    expect(value('advanced.days')).toEqual(['tuesday']);
  });

  it('key-value: masks secret values and rejects duplicate keys', async () => {
    const { row, value, user } = setup();
    const env = row('advanced.env');
    expect(env.getByLabelText('Environment 1 value').getAttribute('type')).toBe('password');
    await user.click(env.getByRole('checkbox', { name: 'Environment 1 secret' }));
    expect(env.getByLabelText('Environment 1 value').getAttribute('type')).toBe('text');
    expect(value('advanced.env')).toEqual([{ key: 'TOKEN', value: 'abc', secret: false }]);

    await user.click(env.getByRole('button', { name: 'Add variable' }));
    await user.type(env.getByLabelText('Environment 2 key'), 'TOKEN');
    expect(env.getByRole('alert').textContent).toContain('Keys must be unique');
    await user.type(env.getByLabelText('Environment 2 key'), '2');
    expect(value('advanced.env')).toEqual([
      { key: 'TOKEN', value: 'abc', secret: false },
      { key: 'TOKEN2', value: '', secret: false },
    ]);
  });

  it('keybinding: records a shortcut and can clear it', async () => {
    const { row, value, user } = setup();
    const shortcut = row('advanced.shortcut');
    await user.click(shortcut.getByRole('button', { name: /^Shortcut:/ }));
    await user.keyboard('{Control>}{Shift>}p{/Shift}{/Control}');
    expect(value('advanced.shortcut')).toBe('Mod+Shift+P');
    await user.click(shortcut.getByRole('button', { name: 'Clear' }));
    expect(value('advanced.shortcut')).toBe('');
  });

  it('object: validates across sub-fields', async () => {
    const { row, value, user } = setup();
    const end = row('advanced.hours').getByLabelText('End');
    await user.clear(end);
    await user.type(end, '07:00');
    expect(row('advanced.hours').getByRole('alert').textContent).toContain('end: End after start');
    expect(value('advanced.hours')).toBeUndefined();
    await user.clear(end);
    await user.type(end, '18:00');
    expect(value('advanced.hours')).toEqual({ start: '08:00', end: '18:00' });
  });

  it('resets a changed setting to its default', async () => {
    const { row, value, user } = setup();
    expect(row('advanced.enabled').queryAllByRole('button', { name: /^Reset/ })).toEqual([]);
    await user.click(row('advanced.enabled').getByRole('switch'));
    await user.click(
      row('advanced.enabled').getAllByRole('button', { name: 'Reset Enabled to default' })[0]!,
    );
    expect(value('advanced.enabled')).toBeUndefined();
    expect(row('advanced.enabled').getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });
});
