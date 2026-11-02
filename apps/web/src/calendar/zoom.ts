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

const clampHeight = (height: number, floor = zoomBounds.min): number =>
  Math.min(zoomBounds.max, Math.max(Math.max(zoomBounds.min, floor), Math.round(height)));

// Whole steps land on tens of percent of the default height, so the toolbar reads 120%, 140%…
const GRID_PERCENT = 10;
const heightAt = (percent: number) => (zoomBounds.default * percent) / 100;
const percentOf = (height: number) => (height / zoomBounds.default) * 100;

// The hour height after `steps` zoom steps of `stepPercent` each (negative steps zoom out). Steps
// may be fractional (a trackpad pinch) and are not rounded; a whole step always moves at least one
// tenth. `floor` is the height at which the whole day fits the view.
export function zoomedHeight(
  current: number,
  steps: number,
  stepPercent: number,
  floor = zoomBounds.min,
): number {
  const factor = (1 + stepPercent / 100) ** steps;
  if (!Number.isInteger(steps)) return clampHeight(current * factor, floor);
  const direction = Math.sign(steps);
  // From the percent shown, so 120% steps to 140%, not to the 145% its rounded pixels give.
  let percent = Math.round((zoomPercent(current) * factor) / GRID_PERCENT) * GRID_PERCENT;
  if (direction > 0 && heightAt(percent) <= current) percent += GRID_PERCENT;
  if (direction < 0 && heightAt(percent) >= current) percent -= GRID_PERCENT;
  return clampHeight(heightAt(percent), floor);
}

// The percent the toolbar shows: the tens a whole step lands on, otherwise the nearest percent.
export function zoomPercent(height: number): number {
  const tens = Math.round(percentOf(height) / GRID_PERCENT) * GRID_PERCENT;
  return Math.round(heightAt(tens)) === height ? tens : Math.round(percentOf(height));
}

// Levels the zoom menu offers, inside the setting's bounds.
export const zoomPresets: readonly number[] = [50, 75, 100, 150, 200, 300].filter(
  (percent) => heightAt(percent) >= zoomBounds.min && heightAt(percent) <= zoomBounds.max,
);
export const presetHeight = (percent: number): number => Math.round(heightAt(percent));

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
  // The height at which the whole day fills the grid; zooming out stops there.
  readonly floor: number;
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
  // The grid reports the height at which 24 hours fill it.
  setFloor(height: number): void;
  // Settles once every requested height has been written (or failed).
  idle(): Promise<void>;
}

const zooms = new WeakMap<SettingsStore, Zoom>();

export function calendarZoom(settings: SettingsStore): Zoom {
  const found = zooms.get(settings);
  if (found) return found;
  const store = createStore<ZoomState>(() => ({ pending: undefined, floor: zoomBounds.min }));
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
      const next = clampHeight(height, store.getState().floor);
      if (next === zoom.current()) return false;
      store.setState({ pending: next });
      queued = next;
      void flush();
      return true;
    },
    step(steps) {
      const percent = settingValue(settings.getState().values, 'calendar.zoomStep');
      return zoom.set(zoomedHeight(zoom.current(), steps, percent, store.getState().floor));
    },
    // Back to the default by clearing the stored value, so the setting reads as not changed.
    reset() {
      const changed = zoom.current() !== zoomBounds.default;
      store.setState({ pending: zoomBounds.default });
      queued = undefined;
      idle = idle
        .then(() => settings.reset('calendar.hourHeight'))
        .catch(() => undefined)
        .then(() => {
          if (!writing && queued === undefined) store.setState({ pending: undefined });
        });
      return changed;
    },
    setFloor(height) {
      const floor = Math.min(zoomBounds.max, Math.max(zoomBounds.min, Math.ceil(height)));
      if (floor !== store.getState().floor) store.setState({ floor });
    },
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
