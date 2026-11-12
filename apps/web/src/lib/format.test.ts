import { describe, expect, it } from 'vitest';
import { formatDuration, tookText } from './format';

describe('durations', () => {
  it('says a step under a second took under 1 s, not 0 s (agent workbench spec 98)', () => {
    expect(tookText(0)).toBe('Took under 1 s');
    expect(tookText(999)).toBe('Took under 1 s');
    expect(tookText(1000)).toBe('Took 1 s');
    expect(tookText(125_000)).toBe('Took 2 min 5 s');
  });

  it('reads seconds, minutes and hours', () => {
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(72_000)).toBe('1 min 12 s');
    expect(formatDuration(7_500_000)).toBe('2 h 5 min');
  });
});
