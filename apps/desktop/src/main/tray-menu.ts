export type TrayAction = 'open' | 'newThread' | 'toggleScheduler' | 'quit';

export type TrayEntry =
  | {
      readonly kind: 'item';
      readonly label: string;
      readonly action: TrayAction;
      readonly enabled: boolean;
    }
  | { readonly kind: 'separator' };

export interface TrayState {
  // False while the server is starting: actions that need it are disabled.
  readonly serverReady: boolean;
  readonly schedulerPaused: boolean;
}

const item = (label: string, action: TrayAction, enabled: boolean): TrayEntry => ({
  kind: 'item',
  label,
  action,
  enabled,
});

export function trayMenu(state: TrayState): TrayEntry[] {
  return [
    item('Open', 'open', state.serverReady),
    item('New thread', 'newThread', state.serverReady),
    item(
      state.schedulerPaused ? 'Resume scheduler' : 'Pause scheduler',
      'toggleScheduler',
      state.serverReady,
    ),
    { kind: 'separator' },
    item('Quit', 'quit', true),
  ];
}

export const trayTooltip = (state: TrayState): string =>
  !state.serverReady ? 'wow (starting)' : state.schedulerPaused ? 'wow (scheduler paused)' : 'wow';
