import {
  createMemorySettingsSource,
  createSettingsStore,
  settingValue,
  type SettingsSource,
} from '@wow/client-runtime';
import { describe, expect, it } from 'vitest';
import { calendarZoom, wheelSteps, zoomBounds, zoomedHeight } from './zoom';

describe('zoom steps', () => {
  it('takes its bounds and default from the hourHeight setting', () => {
    expect(zoomBounds).toEqual({ min: 24, max: 160, default: 48 });
  });

  it('multiplies by the step, rounds and clamps', () => {
    expect(zoomedHeight(48, 1, 20)).toBe(58);
    expect(zoomedHeight(58, -1, 20)).toBe(48);
    expect(zoomedHeight(48, -1, 20)).toBe(40);
    expect(zoomedHeight(150, 1, 20)).toBe(160);
    expect(zoomedHeight(25, -1, 20)).toBe(24);
    expect(zoomedHeight(160, 1, 20)).toBe(160);
  });

  it('moves at least a pixel for a whole step and nothing for a tiny pinch', () => {
    expect(zoomedHeight(24, 1, 1)).toBe(25);
    expect(zoomedHeight(48, 0.01, 20)).toBe(48);
    expect(zoomedHeight(48, 0.5, 20)).toBe(53);
  });

  it('reads wheel notches and pinch deltas as steps', () => {
    expect(wheelSteps({ deltaY: -100, deltaMode: 0 })).toBe(1);
    expect(wheelSteps({ deltaY: 200, deltaMode: 0 })).toBe(-2);
    expect(wheelSteps({ deltaY: -4, deltaMode: 0 })).toBeCloseTo(0.04);
    expect(wheelSteps({ deltaY: 3, deltaMode: 1 })).toBe(-1);
  });
});

const setup = () => {
  const memory = createMemorySettingsSource();
  const writes: unknown[] = [];
  const source: SettingsSource = {
    ...memory,
    write: (key, value) => {
      writes.push(value);
      return memory.write(key, value);
    },
  };
  const settings = createSettingsStore(source);
  const stored = () => settingValue(settings.getState().values, 'calendar.hourHeight');
  return { settings, writes, stored, zoom: calendarZoom(settings) };
};

describe('calendarZoom', () => {
  it('shows a step at once and settles on the stored setting', async () => {
    const { zoom, stored, writes } = setup();
    expect(zoom.step(1)).toBe(true);
    expect(zoom.store.getState().pending).toBe(58);
    expect(zoom.current()).toBe(58);
    await zoom.idle();
    expect(stored()).toBe(58);
    expect(zoom.store.getState().pending).toBeUndefined();
    expect(writes).toEqual([58]);
  });

  it('keeps one write in flight and writes the last of quick steps', async () => {
    const { zoom, stored, writes } = setup();
    zoom.step(1);
    zoom.step(1);
    zoom.step(1);
    expect(zoom.current()).toBe(84);
    await zoom.idle();
    expect(writes).toEqual([58, 84]);
    expect(stored()).toBe(84);
    expect(zoom.store.getState().pending).toBeUndefined();
  });

  it('does nothing past the bounds and resets to the default', async () => {
    const { zoom, stored, writes, settings } = setup();
    await settings.write('calendar.hourHeight', 160);
    writes.length = 0;
    expect(zoom.step(1)).toBe(false);
    expect(writes).toEqual([]);
    expect(zoom.reset()).toBe(true);
    await zoom.idle();
    expect(stored()).toBe(48);
  });

  it('is one zoom per settings store', () => {
    const { settings, zoom } = setup();
    expect(calendarZoom(settings)).toBe(zoom);
  });
});
