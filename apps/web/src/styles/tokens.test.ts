import { describe, expect, it } from 'vitest';

// Agent workbench spec 85: text in the "needs you" colour, such as "Waiting for you", reads at
// 4.5:1 or more in both themes, measured from the tokens themselves; dots and borders keep the
// bright colour.

const sources = import.meta.glob<string>('/src/**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

// Read from the file: tests do not load CSS (`css: false`), and these are the shipped values.
// The web app has no Node types, so the little of node:fs used here is typed by hand.
interface TextFiles {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
}
const files = (await import(/* @vite-ignore */ 'node:fs/promises' as string)) as TextFiles;
const { process } = globalThis as unknown as { process: { cwd(): string } };
// Tests run from the web app's folder.
const tokens = await files.readFile(`${process.cwd()}/src/styles/tokens.css`, 'utf8');

type Oklch = readonly [number, number, number];

function block(selector: string): string {
  const start = tokens.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`No ${selector} block in tokens.css`);
  return tokens.slice(start, tokens.indexOf('\n}', start));
}

// A token's own value in a block, following one var() to another token.
function token(css: string, name: string, fallback?: string): Oklch {
  const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();
  if (value === undefined) {
    if (fallback !== undefined) return token(fallback, name);
    throw new Error(`No --${name}`);
  }
  const alias = /^var\(--([\w-]+)\)$/.exec(value)?.[1];
  if (alias) return token(css, alias, fallback);
  const parts = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (!parts) throw new Error(`--${name} is not an opaque oklch(): ${value}`);
  return [Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

// OKLCH to linear sRGB (Björn Ottosson's matrices), clipped to the gamut, then WCAG luminance.
function luminance([lightness, chroma, hue]: Oklch): number {
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const [red, green, blue] = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => Math.min(1, Math.max(0, channel)));
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}

const contrast = (a: Oklch, b: Oklch): number => {
  const [light, dark] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
};

describe('the "needs you" text colour (spec 85)', () => {
  const light = block(':root');
  const dark = block('.dark');
  const surfaces = ['background', 'card', 'muted', 'popover'];

  it('reads at 4.5:1 or more on every surface in the light theme', () => {
    const text = token(light, 'state-needs-you-text');
    for (const surface of surfaces) {
      expect({ surface, ratio: contrast(text, token(light, surface)) >= 4.5 }).toEqual({
        surface,
        ratio: true,
      });
    }
    // The bright colour stays for dots and borders, and would not do as text.
    expect(contrast(token(light, 'state-needs-you'), token(light, 'background'))).toBeLessThan(4.5);
  });

  it('reads at 4.5:1 or more on every surface in the dark theme', () => {
    const text = token(dark, 'state-needs-you-text', light);
    for (const surface of surfaces) {
      expect({ surface, ratio: contrast(text, token(dark, surface)) >= 4.5 }).toEqual({
        surface,
        ratio: true,
      });
    }
  });

  it('is what every text in that colour uses', () => {
    const bare = Object.entries(sources).filter(([, text]) =>
      /\btext-state-needs-you(?!-text)\b/.test(text),
    );
    expect(bare.map(([path]) => path)).toEqual([]);
  });
});
