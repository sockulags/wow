import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from '@/test/render';
import { eventToBinding, formatBinding, normalizeBinding } from './keybindings';

const key = (
  code: string,
  modifiers: Partial<Record<'ctrl' | 'shift' | 'alt' | 'meta', boolean>>,
) => ({
  key: '',
  code,
  ctrlKey: modifiers.ctrl ?? false,
  shiftKey: modifiers.shift ?? false,
  altKey: modifiers.alt ?? false,
  metaKey: modifiers.meta ?? false,
});

describe('keybindings', () => {
  it('reads the physical key and folds Ctrl or Cmd into Mod', () => {
    expect(eventToBinding(key('KeyK', { ctrl: true }), false)).toBe('Mod+K');
    expect(eventToBinding(key('KeyK', { meta: true }), true)).toBe('Mod+K');
    expect(eventToBinding(key('Comma', { ctrl: true, shift: true }), false)).toBe('Mod+Shift+,');
    expect(eventToBinding(key('ControlLeft', { ctrl: true }), false)).toBeUndefined();
  });

  it('normalizes and formats stored bindings per platform', () => {
    expect(normalizeBinding('Shift+Ctrl+K', false)).toBe('Mod+Shift+K');
    expect(normalizeBinding('Meta+K', true)).toBe('Mod+K');
    expect(formatBinding('Mod+Shift+L', false)).toBe('Ctrl+Shift+L');
    expect(formatBinding('Mod+Shift+L', true)).toBe('⌘⇧L');
  });
});

describe('shell', () => {
  it('redirects / to the calendar and shows its empty state', async () => {
    const { router } = await renderApp('/');
    expect(router.state.location.pathname).toBe('/calendar');
    expect(await screen.findByText('No calendar items yet')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Calendar', 'Chat', 'Workflows', 'Backlog', 'Settings']);
  });

  it('opens the palette with Ctrl+K and navigates with the keyboard', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/calendar');
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox'), 'go to backlog');
    expect(within(dialog).getByRole('option', { name: /Go to Backlog/ })).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(router.state.location.pathname).toBe('/backlog');
    // Without a server the view says so rather than claiming an empty backlog.
    expect(await screen.findByText('Not connected to the wow server')).toBeTruthy();
  });

  it('lists settings pages and actions in the palette', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/calendar');
    await user.click(screen.getByRole('button', { name: /Search/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox'), 'keybind');
    await user.keyboard('{Enter}');
    expect(router.state.location.pathname).toBe('/settings/keybindings');
  });

  it('toggles the theme from the palette', async () => {
    const user = userEvent.setup();
    const { runtime } = await renderApp('/calendar');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox'), 'toggle theme');
    await user.keyboard('{Enter}');
    expect(runtime.settings.getState().values['appearance.theme']).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('applies a changed keybinding without a reload', async () => {
    const user = userEvent.setup();
    const { runtime } = await renderApp('/calendar');
    await act(() => runtime.settings.write('keybindings.toggleRightPanel', 'Mod+Shift+R'));
    expect(screen.queryByRole('complementary', { name: 'Details' })).toBeNull();
    await user.keyboard('{Control>}j{/Control}');
    expect(screen.queryByRole('complementary', { name: 'Details' })).toBeNull();
    await user.keyboard('{Control>}{Shift>}r{/Shift}{/Control}');
    expect(screen.getByRole('complementary', { name: 'Details' })).toBeTruthy();
  });

  it('runs shortcuts with Ctrl while the palette has focus (cmdk would claim Ctrl+J and Ctrl+K)', async () => {
    const user = userEvent.setup();
    await renderApp('/calendar');
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox'), 'zoom');
    // Ctrl+K again keeps the palette open; Ctrl+J reaches the app and closes the palette.
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.keyboard('{Control>}j{/Control}');
    expect(await screen.findByRole('complementary', { name: 'Details' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('toggles the sidebar with its keybinding', async () => {
    const user = userEvent.setup();
    await renderApp('/chat');
    await user.keyboard('{Control>}b{/Control}');
    expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull();
    await user.keyboard('{Control>}b{/Control}');
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeTruthy();
  });

  it('renders every setting group from the registry, with Projects after Providers', async () => {
    await renderApp('/settings');
    const groups = screen.getByRole('navigation', { name: 'Settings groups' });
    expect(
      within(groups)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'Providers',
      'Projects',
      'Chat',
      'Calendar',
      'Outlook',
      'Scheduler',
      'Workflows',
      'Skills',
      'Trackers',
      'Appearance',
      'Keybindings',
      'Advanced',
    ]);
    // Desktop and Updates only show in the desktop app.
    expect(await screen.findByLabelText('Test timeout')).toBeTruthy();
  });

  it('opens a new thread from the tray link and the keybinding', async () => {
    const user = userEvent.setup();
    const { router } = await renderApp('/chat?new=1');
    expect(router.state.location.pathname).toBe('/chat/new');
    await act(() => router.navigate({ to: '/calendar' }));
    await user.keyboard('{Control>}{Alt>}n{/Alt}{/Control}');
    expect(router.state.location.pathname).toBe('/chat/new');
  });

  it('shows not found for an unknown settings group', async () => {
    await renderApp('/settings/nope');
    expect(await screen.findByText('Page not found')).toBeTruthy();
  });
});
