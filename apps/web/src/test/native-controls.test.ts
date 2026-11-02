import { describe, expect, it } from 'vitest';

// Native pickers draw browser chrome that ignores the theme (a light popup in the dark theme).
// Views compose the themed controls instead: ChoiceSelect, Combobox and SuggestInput
// (components/combobox.tsx), DateField and TimeField (components/date-time-fields.tsx). Only the
// shadcn primitives in components/ui may touch the native elements.

const sources = import.meta.glob<string>('/src/**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const banned: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: '<select>', pattern: /<select[\s>]/ },
  { name: '<option>', pattern: /<option[\s>]/ },
  { name: '<datalist>', pattern: /<datalist[\s>]/ },
  { name: '<input list=…>', pattern: /\blist=\{/ },
  {
    name: 'native date or time input',
    pattern: /\btype=(?:"|'|\{\s*['"])(?:date|time|datetime-local|month|week)['"]/,
  },
];

function findings(path: string, text: string): string[] {
  return text
    .split('\n')
    .flatMap((line, index) =>
      banned
        .filter(({ pattern }) => pattern.test(line))
        .map(({ name }) => `${path}:${index + 1} uses ${name}: ${line.trim()}`),
    );
}

describe('native form controls', () => {
  it('are not used outside components/ui', () => {
    const scanned = Object.entries(sources).filter(
      ([path]) => !path.startsWith('/src/components/ui/'),
    );
    expect(scanned.length).toBeGreaterThan(20);
    expect(scanned.flatMap(([path, text]) => findings(path, text))).toEqual([]);
  });

  it('catches each banned form', () => {
    const samples = [
      '<select value={x}>',
      '<option value="">None</option>',
      '<datalist id="models">',
      '<Input list={`${id}-models`} />',
      '<Input type="date" />',
      "<input type='time' />",
      "<Input type={'datetime-local'} />",
    ];
    for (const sample of samples) expect(findings('sample', sample)).toHaveLength(1);
    expect(findings('sample', '<Input type="text" /> <SelectItem value="a" />')).toEqual([]);
  });
});
