import { settingsRegistry } from '@wow/contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestRuntime, renderApp } from '@/test/render';

const panel = () => screen.queryByRole('complementary', { name: 'Context panel' });

// jsdom has no matchMedia; a narrow window is one whose max-width queries match.
function narrowWindow() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('context panel', () => {
  it('opens with its key, stores that, and says what it shows in the calendar', async () => {
    const user = userEvent.setup();
    const { runtime } = await renderApp('/calendar');
    expect(panel()).toBeNull();
    await user.keyboard('{Control>}j{/Control}');
    const aside = panel();
    expect(aside).not.toBeNull();
    expect(runtime.settings.getState().values['appearance.contextPanel']).toBe(true);
    expect(within(aside as HTMLElement).getByText('Nothing selected')).toBeTruthy();
    expect(within(aside as HTMLElement).getByText(/Select a card to see its details/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Close context panel' }));
    expect(panel()).toBeNull();
    expect(runtime.settings.getState().values['appearance.contextPanel']).toBe(false);
  });

  it('moves the focus into the panel and back with its key, opening it first', async () => {
    const user = userEvent.setup();
    await renderApp('/settings/appearance');
    const search = screen.getByRole('button', { name: /Search/ });
    search.focus();
    await user.keyboard('{F6}');
    const aside = await screen.findByRole('complementary', { name: 'Context panel' });
    expect(document.activeElement).toBe(aside);
    await user.keyboard('{F6}');
    expect(document.activeElement).toBe(search);
  });

  it('resizes from its edge with the arrow keys and stores the width', async () => {
    const user = userEvent.setup();
    const runtime = createTestRuntime(undefined, { 'appearance.contextPanel': true });
    await renderApp('/calendar', runtime);
    const edge = screen.getByRole('separator', { name: 'Resize context panel' });
    const start = settingsRegistry['appearance.contextPanelWidth'].default;
    expect(edge.getAttribute('aria-valuenow')).toBe(String(start));
    edge.focus();
    await user.keyboard('{ArrowLeft}');
    expect(runtime.settings.getState().values['appearance.contextPanelWidth']).toBe(start + 16);
    await user.keyboard('{End}');
    expect(runtime.settings.getState().values['appearance.contextPanelWidth']).toBe(720);
  });

  it('in a narrow window stays out of the way and opens over the view without the setting', async () => {
    narrowWindow();
    const user = userEvent.setup();
    const runtime = createTestRuntime(undefined, { 'appearance.contextPanel': true });
    await renderApp('/calendar', runtime);
    expect(panel()).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Toggle context panel' }));
    expect(panel()?.dataset['overlay']).toBe('');
    await user.click(screen.getByRole('button', { name: 'Close context panel' }));
    expect(panel()).toBeNull();
    expect(runtime.settings.getState().values['appearance.contextPanel']).toBe(true);
  });

  it('over a run view reports and stores no more than the width it shows', async () => {
    narrowWindow();
    vi.stubGlobal('innerWidth', 1024);
    const user = userEvent.setup();
    const runtime = createTestRuntime(undefined, { 'appearance.contextPanelWidth': 720 });
    await renderApp('/workflows/runs/run-1', runtime);
    await user.click(screen.getByRole('button', { name: 'Toggle context panel' }));
    const edge = screen.getByRole('separator', { name: 'Resize context panel' });
    // 1024 px less the rail, the workflows list and the gate bar's room (35rem).
    expect(edge.getAttribute('aria-valuenow')).toBe('464');
    expect(edge.getAttribute('aria-valuemax')).toBe('464');
    expect(panel()?.style.width).toBe('min(464px, 100%)');
    edge.focus();
    await user.keyboard('{ArrowRight}');
    expect(runtime.settings.getState().values['appearance.contextPanelWidth']).toBe(448);
    await user.keyboard('{End}');
    expect(runtime.settings.getState().values['appearance.contextPanelWidth']).toBe(464);
    await user.keyboard('{ArrowLeft}');
    expect(runtime.settings.getState().values['appearance.contextPanelWidth']).toBe(464);
  });

  it('over a run view keeps the stored width on a click of its edge without a move', async () => {
    narrowWindow();
    vi.stubGlobal('innerWidth', 1024);
    const user = userEvent.setup();
    const runtime = createTestRuntime(undefined, { 'appearance.contextPanelWidth': 720 });
    await renderApp('/workflows/runs/run-1', runtime);
    await user.click(screen.getByRole('button', { name: 'Toggle context panel' }));
    const edge = screen.getByRole('separator', { name: 'Resize context panel' });
    expect(edge.getAttribute('aria-valuenow')).toBe('464');
    edge.setPointerCapture = () => undefined;
    await user.pointer({ keys: '[MouseLeft]', target: edge });
    expect(runtime.settings.getState().values['appearance.contextPanelWidth']).toBe(720);
  });

  it('lists "Show in panel" only for a view with a selection', async () => {
    const user = userEvent.setup();
    await renderApp('/calendar?item=card-1');
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox'), 'show in panel');
    expect(within(dialog).getByRole('option', { name: /Show in panel/ })).toBeTruthy();
  });

  it('has no "Show in panel" without a selection', async () => {
    const user = userEvent.setup();
    await renderApp('/settings/appearance');
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox'), 'show in panel');
    expect(within(dialog).queryByRole('option', { name: /Show in panel/ })).toBeNull();
  });
});
