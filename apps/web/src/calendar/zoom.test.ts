import {
  createMemorySettingsSource,
  createSettingsStore,
  settingValue,
  type SettingsSource,
} from '@wow/client-runtime';
import { describe, expect, it } from 'vitest';
import { calendarZoom, wheelSteps, zoomBounds, zoomedHeight, zoomPercent } from './zoom';

describe('zoom steps', () => {
  it('takes its bounds and default from the hourHeight setting', () => {
    expect(zoomBounds).toEqual({ min: 24, max: 144, default: 48 });
  });

  it('multiplies by the step, lands on tens of percent and clamps', () => {
    expect(zoomedHeight(48, 1, 20)).toBe(58);
    expect(zoomPercent(58)).toBe(120);
    expect(zoomedHeight(58, 1, 20)).toBe(67);
    expect(zoomPercent(67)).toBe(140);
    expect(zoomedHeight(58, -1, 20)).toBe(48);
    expect(zoomedHeight(48, -1, 20)).toBe(38);
    expect(zoomPercent(38)).toBe(80);
    expect(zoomedHeight(130, 1, 20)).toBe(144);
    expect(zoomPercent(144)).toBe(300);
    expect(zoomedHeight(25, -1, 20)).toBe(24);
    expect(zoomedHeight(144, 1, 20)).toBe(144);
  });

  it('stops zooming out where the whole day fills the view', () => {
    expect(zoomedHeight(48, -1, 20, 36)).toBe(38);
    expect(zoomedHeight(38, -1, 20, 36)).toBe(36);
  });

  it('moves at least a tenth for a whole step and nothing for a tiny pinch', () => {
    expect(zoomedHeight(24, 1, 1)).toBe(29);
    expect(zoomPercent(53)).toBe(110);
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
    expect(zoom.current()).toBe(82);
    await zoom.idle();
    expect(writes).toEqual([58, 82]);
    expect(stored()).toBe(82);
    expect(zoom.store.getState().pending).toBeUndefined();
  });

  it('does nothing past the bounds and resets to the default', async () => {
    const { zoom, stored, writes, settings } = setup();
    await settings.write('calendar.hourHeight', 144);
    writes.length = 0;
    expect(zoom.step(1)).toBe(false);
    expect(writes).toEqual([]);
    expect(zoom.reset()).toBe(true);
    await zoom.idle();
    expect(stored()).toBe(48);
    // Reset clears the stored value instead of writing the default.
    expect('calendar.hourHeight' in settings.getState().values).toBe(false);
  });

  it('keeps zoom out above the floor the grid reports', async () => {
    const { zoom, stored } = setup();
    zoom.setFloor(45.2);
    expect(zoom.step(-1)).toBe(true);
    await zoom.idle();
    expect(stored()).toBe(46);
    expect(zoom.step(-1)).toBe(false);
  });

  it('is one zoom per settings store', () => {
    const { settings, zoom } = setup();
    expect(calendarZoom(settings)).toBe(zoom);
  });
});
