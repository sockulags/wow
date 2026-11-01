import { describe, expect, it } from 'vitest';
import { prefersMock } from './index.js';

describe('@wow/outlook-bridge', () => {
  it('uses the mock off Windows or when asked', () => {
    expect(prefersMock('linux', {})).toBe(true);
    expect(prefersMock('win32', { WOW_OUTLOOK: 'mock' })).toBe(true);
    expect(prefersMock('win32', {})).toBe(false);
  });
});
