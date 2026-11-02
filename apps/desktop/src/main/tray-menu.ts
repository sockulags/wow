export type TrayAction =
  'open' | 'openChat' | 'openCalendar' | 'newThread' | 'toggleScheduler' | 'installUpdate' | 'quit';

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
  // Threads that wait for an answer plus runs waiting at a gate (audit E-15).
  readonly needsYou?: number | undefined;
  // The next scheduled trigger: its card's title and its local time ("16:30").
  readonly next?: { readonly title: string; readonly at: string } | undefined;
}

const item = (label: string, action: TrayAction, enabled: boolean): TrayEntry => ({
  kind: 'item',
  label,
  action,
  enabled,
});

const needYouText = (count: number) => `${count} need${count === 1 ? 's' : ''} you`;

export function trayMenu(state: TrayState): TrayEntry[] {
  const day: TrayEntry[] = [
    ...(state.needsYou ? [item(needYouText(state.needsYou), 'openChat', state.serverReady)] : []),
    ...(state.next
      ? [item(`Next: ${state.next.title} at ${state.next.at}`, 'openCalendar', state.serverReady)]
      : []),
  ];
  return [
    ...day,
    ...(day.length > 0 ? [{ kind: 'separator' } as const] : []),
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
        : state.needsYou
          ? `wow · ${needYouText(state.needsYou)}`
          : 'wow';

// The tray's summary of the day from the server's rows: how many need you, and the next trigger.
export function traySummary(
  threads: readonly { readonly state: string }[],
  runs: readonly { readonly state: string }[],
  triggers: readonly {
    readonly state: string;
    readonly runAt: string;
    readonly calendarItemId: string;
  }[],
  items: readonly { readonly id: string; readonly title: string }[],
  now: Date,
  formatTime: (instant: Date) => string,
): Pick<TrayState, 'needsYou' | 'next'> {
  const needsYou =
    threads.filter((thread) => thread.state === 'needs_you').length +
    runs.filter((run) => run.state === 'waiting').length;
  const upcoming = triggers
    .filter((trigger) => trigger.state === 'scheduled' && Date.parse(trigger.runAt) > now.getTime())
    .toSorted((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt))[0];
  const title = upcoming && items.find((entry) => entry.id === upcoming.calendarItemId)?.title;
  return {
    needsYou,
    next:
      upcoming === undefined
        ? undefined
        : { title: title || 'Untitled card', at: formatTime(new Date(upcoming.runAt)) },
  };
}
