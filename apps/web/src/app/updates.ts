import { UpdateState } from '@wow/contracts';
import { createStore, type StoreApi } from 'zustand';
import type { AppCommand } from './commands';

// Auto-update in the web app (behavior 35). The desktop main process owns the update state and
// sends it through the preload (`window.wowDesktop.updates`, apps/desktop/src/preload); this
// module keeps the last state it sent and passes the user's actions back. Outside the desktop app,
// or in an unpackaged build, there is no state and nothing about updates is shown.

export interface DesktopUpdatesBridge {
  getState(): Promise<unknown>;
  onState(listener: (state: unknown) => void): () => void;
  check(): Promise<unknown>;
  install(): Promise<unknown>;
}

declare global {
  interface Window {
    // Set by the desktop preload.
    wowDesktop?: {
      readonly updates?: DesktopUpdatesBridge;
      // The native folder dialog (apps/desktop/src/preload).
      readonly pickFolder?: () => Promise<unknown>;
    };
  }
}

export interface UpdatesClient {
  // Undefined until the desktop answers, and for good when updates do not run in this build.
  readonly store: StoreApi<UpdateState | undefined>;
  check(): void;
  install(): void;
}

const parse = (value: unknown): UpdateState | undefined => {
  const parsed = UpdateState.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export function createUpdatesClient(bridge: DesktopUpdatesBridge): UpdatesClient {
  const store = createStore<UpdateState | undefined>(() => undefined);
  let pushed = false;
  bridge.onState((value) => {
    const state = parse(value);
    if (state === undefined) return;
    pushed = true;
    store.setState(state, true);
  });
  // A push that arrived first is newer than this answer.
  void bridge.getState().then((value) => {
    if (!pushed) store.setState(parse(value), true);
  });
  return {
    store,
    check: () => void bridge.check(),
    install: () => void bridge.install(),
  };
}

export function updateCommands(state: UpdateState | undefined): AppCommand[] {
  if (state === undefined) return [];
  const commands: AppCommand[] = [];
  if (state.enabled)
    commands.push({
      id: 'updates.check',
      title: 'Check for updates',
      group: 'Actions',
      keywords: ['update', 'upgrade', 'version', 'release'],
      run: ({ updates, navigate }) => {
        updates?.check();
        void navigate({ to: '/settings/$group', params: { group: 'updates' } });
      },
    });
  if (state.status === 'ready')
    commands.push({
      id: 'updates.install',
      title: state.version === null ? 'Restart to update' : `Restart to update to ${state.version}`,
      group: 'Actions',
      keywords: ['update', 'upgrade', 'install', 'restart'],
      run: ({ updates }) => updates?.install(),
    });
  return commands;
}

// One line about the state, for the settings page and the banner.
export function describeUpdate(state: UpdateState): string {
  const release = state.version === null ? 'The update' : `wow ${state.version}`;
  switch (state.status) {
    case 'idle':
      if (!state.enabled) return `wow ${state.currentVersion}. Automatic updates are off.`;
      return state.checkedAt === null
        ? `wow ${state.currentVersion}.`
        : `wow ${state.currentVersion} is up to date.`;
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return `${release} is available. Starting the download…`;
    case 'downloading':
      return `Downloading ${release}: ${state.percent ?? 0}%`;
    case 'ready':
      return `${release} is downloaded. Restart to update.`;
    case 'error':
      return `Update failed: ${state.error ?? 'unknown error'}`;
  }
}
