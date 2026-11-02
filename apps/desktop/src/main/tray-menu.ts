export type TrayAction = 'open' | 'newThread' | 'toggleScheduler' | 'installUpdate' | 'quit';

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
  // The downloaded release waiting for "Restart to update", if any.
  readonly updateReady: string | undefined;
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
    ...(state.updateReady === undefined
      ? []
      : [item(`Restart to update (${state.updateReady})`, 'installUpdate', state.serverReady)]),
    item('Quit', 'quit', true),
  ];
}

export const trayTooltip = (state: TrayState): string =>
  !state.serverReady
    ? 'wow (starting)'
    : state.updateReady !== undefined
      ? `wow (update ${state.updateReady} ready)`
      : state.schedulerPaused
        ? 'wow (scheduler paused)'
        : 'wow';
