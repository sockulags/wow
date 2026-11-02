import { settingsRegistry } from '@wow/contracts';
import { settingValue, type SettingsStore } from '@wow/client-runtime';
import { createStore, type StoreApi } from 'zustand';

// The calendar's zoom is the `calendar.hourHeight` setting. Its bounds and default come from the
// registry, so the settings page, the keys and the wheel agree on them.

const definition = settingsRegistry['calendar.hourHeight'];

export const zoomBounds = {
  min: definition.schema.minValue ?? 1,
  max: definition.schema.maxValue ?? Number.MAX_SAFE_INTEGER,
  default: definition.default,
} as const;

const clampHeight = (height: number): number =>
  Math.min(zoomBounds.max, Math.max(zoomBounds.min, Math.round(height)));

// The hour height after `steps` zoom steps of `stepPercent` each (negative steps zoom out). Steps
// may be fractional (a trackpad pinch); a whole step always moves at least one pixel.
export function zoomedHeight(current: number, steps: number, stepPercent: number): number {
  const next = clampHeight(current * (1 + stepPercent / 100) ** steps);
  if (next !== current || Math.abs(steps) < 1) return next;
  return clampHeight(current + Math.sign(steps));
}

// Wheel deltas in zoom steps. Chromium reports one mouse-wheel notch as 100 pixels and a pinch
// as small pixel deltas with ctrlKey set; line and page modes count as one notch per event.
export function wheelSteps(event: { readonly deltaY: number; readonly deltaMode: number }): number {
  if (event.deltaMode !== 0) return -Math.sign(event.deltaY);
  return -event.deltaY / 100;
}

// Zoom requests from the grid, the toolbar and the commands. The newest requested height shows at
// once (`pending`) while it is written with `setting.set`; one write is in flight at a time and
// the last request wins, so a pinch does not queue a write per frame. The pending height is
// dropped when the stored setting reaches it or a write fails, so the grid ends up on the stored
// value like every other setting.
export interface ZoomState {
  readonly pending: number | undefined;
}

export interface Zoom {
  readonly store: StoreApi<ZoomState>;
  // The height the user last asked for, or the stored one.
  current(): number;
  // These return whether the height changed (it does not past the bounds).
  set(height: number): boolean;
  step(steps: number): boolean;
  reset(): boolean;
  // Called when the stored value changes.
  settle(stored: number): void;
  // Settles once every requested height has been written (or failed).
  idle(): Promise<void>;
}

const zooms = new WeakMap<SettingsStore, Zoom>();

export function calendarZoom(settings: SettingsStore): Zoom {
  const found = zooms.get(settings);
  if (found) return found;
  const store = createStore<ZoomState>(() => ({ pending: undefined }));
  const stored = () => settingValue(settings.getState().values, 'calendar.hourHeight');
  let writing = false;
  let queued: number | undefined;
  // Settles when no write is in flight or queued.
  let idle: Promise<void> = Promise.resolve();

  const flush = (): Promise<void> => {
    if (writing || queued === undefined) return idle;
    const height = queued;
    queued = undefined;
    if (height === stored()) {
      if (store.getState().pending === height) store.setState({ pending: undefined });
      return idle;
    }
    writing = true;
    idle = settings
      .write('calendar.hourHeight', height)
      .then(
        (result) => result.ok,
        () => false,
      )
      .then((ok) => {
        writing = false;
        if (queued === undefined) {
          // The stored value may have arrived while the write was in flight.
          if (!ok || store.getState().pending === stored()) store.setState({ pending: undefined });
          return undefined;
        }
        return flush();
      });
    return idle;
  };

  const zoom: Zoom = {
    store,
    current: () => store.getState().pending ?? stored(),
    set(height) {
      const next = clampHeight(height);
      if (next === zoom.current()) return false;
      store.setState({ pending: next });
      queued = next;
      void flush();
      return true;
    },
    step(steps) {
      const percent = settingValue(settings.getState().values, 'calendar.zoomStep');
      return zoom.set(zoomedHeight(zoom.current(), steps, percent));
    },
    reset: () => zoom.set(zoomBounds.default),
    idle: () => idle,
    settle(value) {
      if (store.getState().pending === value && !writing && queued === undefined) {
        store.setState({ pending: undefined });
      }
    },
  };
  settings.subscribe((state) => zoom.settle(settingValue(state.values, 'calendar.hourHeight')));
  zooms.set(settings, zoom);
  return zoom;
}
