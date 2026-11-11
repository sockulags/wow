import { describe, expect, it } from 'vitest';
import { webLinksIn } from './adapter.js';

describe('web addresses in a text', () => {
  it('keeps brackets an address closes, and ends at one it did not open', () => {
    expect(
      webLinksIn(
        [
          'See https://a.example.invalid/Plan+(draft).',
          '[x](https://b.example.invalid/x)',
          '[https://c.example.invalid/Notes+[old]](https://d.example.invalid/y)',
          '(https://e.example.invalid/z)',
        ].join('\n'),
      ),
    ).toEqual([
      'https://a.example.invalid/Plan+(draft)',
      'https://b.example.invalid/x',
      'https://c.example.invalid/Notes+[old]',
      'https://d.example.invalid/y',
      'https://e.example.invalid/z',
    ]);
  });

  it('leaves out a bracket the address opens and never closes', () => {
    expect(webLinksIn('https://a.example.invalid/a(b and https://b.example.invalid/c[1')).toEqual([
      'https://a.example.invalid/a',
      'https://b.example.invalid/c',
    ]);
  });

  it('reads long texts without spaces in steps that grow with the length, not its square', () => {
    const size = 200_000;
    for (const text of [
      'https://a]'.repeat(size / 10),
      '(https://a)'.repeat(size / 11),
      'https://a('.repeat(size / 10),
      `https://a${'.'.repeat(size)}b`,
      `https://a${'.'.repeat(size)}`,
    ]) {
      const meter = { steps: 0 };
      expect(webLinksIn(text, meter).length).toBeGreaterThan(0);
      expect(meter.steps).toBeLessThanOrEqual(2 * text.length);
    }
  });
});
