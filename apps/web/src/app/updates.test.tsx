import type { UpdateState } from '@wow/contracts';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createTestRuntime, renderApp } from '@/test/render';
import { createUpdatesClient, describeUpdateError, type DesktopUpdatesBridge } from './updates';

// The web app's side of auto-update (behavior 35): it shows the state the desktop sends and
// passes "Check for updates" and "Restart to update" back.

const idle: UpdateState = {
  status: 'idle',
  enabled: true,
  currentVersion: '0.1.0',
  version: null,
  percent: null,
  error: null,
  checkedAt: '2026-11-02T09:00:00.000Z',
};

class FakeBridge implements DesktopUpdatesBridge {
  checks = 0;
  installs = 0;
  #listener: ((state: unknown) => void) | undefined;
  constructor(private readonly initial: unknown) {}
  getState() {
    return Promise.resolve(this.initial);
  }
  onState(listener: (state: unknown) => void) {
    this.#listener = listener;
    return () => undefined;
  }
  check() {
    this.checks++;
    return Promise.resolve();
  }
  install() {
    this.installs++;
    return Promise.resolve();
  }
  push(state: unknown) {
    act(() => this.#listener?.(state));
  }
}

const runtimeWith = (bridge: FakeBridge) => ({
  ...createTestRuntime(),
  updates: createUpdatesClient(bridge),
});

const openPalette = async (user: ReturnType<typeof userEvent.setup>, query: string) => {
  await user.keyboard('{Control>}k{/Control}');
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByRole('combobox'), query);
  return dialog;
};

describe('updates in the web app', () => {
  it('shows nothing about updates outside the desktop app', async () => {
    const user = userEvent.setup();
    await renderApp('/settings/updates');
    expect((await screen.findByTestId('update-status')).textContent).toMatch(
      /installed desktop app only/,
    );
    expect(screen.queryByRole('status', { name: 'Update' })).toBeNull();
    const dialog = await openPalette(user, 'check for updates');
    expect(within(dialog).queryByRole('option', { name: /Check for updates/ })).toBeNull();
  });

  it('checks from the palette and shows download progress as the desktop reports it', async () => {
    const user = userEvent.setup();
    const bridge = new FakeBridge(idle);
    const { router } = await renderApp('/calendar', runtimeWith(bridge));
    await openPalette(user, 'check for updates');
    await user.click(await screen.findByRole('option', { name: /Check for updates/ }));
    expect(bridge.checks).toBe(1);
    expect(router.state.location.pathname).toBe('/settings/updates');
    const status = await screen.findByTestId('update-status');
    expect(status.textContent).toMatch(/wow 0\.1\.0 is up to date/);
    bridge.push({ ...idle, status: 'downloading', version: '0.2.0', percent: 42 });
    expect(status.textContent).toMatch(/Downloading wow 0\.2\.0: 42%/);
  });

  it('offers "Restart to update" in a banner and the palette once the update is downloaded', async () => {
    const user = userEvent.setup();
    const bridge = new FakeBridge(idle);
    await renderApp('/calendar', runtimeWith(bridge));
    expect(screen.queryByRole('status', { name: 'Update' })).toBeNull();
    bridge.push({ ...idle, status: 'ready', version: '0.2.0', percent: 100 });
    const banner = await screen.findByRole('status', { name: 'Update' });
    expect(banner.textContent).toMatch(/wow 0\.2\.0 is downloaded/);
    await user.click(within(banner).getByRole('button', { name: 'Restart to update' }));
    expect(bridge.installs).toBe(1);
    await openPalette(user, 'restart to update');
    await user.click(await screen.findByRole('option', { name: /Restart to update to 0\.2\.0/ }));
    expect(bridge.installs).toBe(2);
  });

  it('hides the ready banner with Later and links to the release notes', async () => {
    const user = userEvent.setup();
    const bridge = new FakeBridge({ ...idle, status: 'ready', version: '0.2.0', percent: 100 });
    await renderApp('/calendar', runtimeWith(bridge));
    const banner = await screen.findByRole('status', { name: 'Update' });
    expect(within(banner).getByRole('link', { name: "What's new" }).getAttribute('href')).toBe(
      'https://github.com/sockulags/wow/releases/tag/v0.2.0',
    );
    await user.click(within(banner).getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('status', { name: 'Update' })).toBeNull();
  });

  it('shows a failed check in words until dismissed', async () => {
    const user = userEvent.setup();
    const bridge = new FakeBridge({ ...idle, status: 'error', error: 'offline' });
    await renderApp('/calendar', runtimeWith(bridge));
    const banner = await screen.findByRole('alert', { name: 'Update' });
    expect(banner.textContent).toMatch(/Update failed: offline/);
    await user.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert', { name: 'Update' })).toBeNull();
  });

  it('translates common updater errors', () => {
    expect(describeUpdateError('net::ERR_INTERNET_DISCONNECTED', '18:30')).toBe(
      'No internet connection. wow will try again at 18:30.',
    );
    expect(describeUpdateError('something odd', undefined)).toBe('Update failed: something odd');
  });

  it('hides "Check for updates" while updates are off', async () => {
    const user = userEvent.setup();
    const bridge = new FakeBridge({ ...idle, enabled: false, checkedAt: null });
    await renderApp('/settings/updates', runtimeWith(bridge));
    expect((await screen.findByTestId('update-status')).textContent).toMatch(
      /Automatic updates are off/,
    );
    const dialog = await openPalette(user, 'check for updates');
    expect(within(dialog).queryByRole('option', { name: /Check for updates/ })).toBeNull();
  });
});
