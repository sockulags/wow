import { expect, test } from '@playwright/test';
import { settingsRegistry } from '@wow/contracts';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// U6 of the app assistant: the spec's ground truth names the behaviors `pnpm e2e` must cover.
// Each case that covers one carries `@app-assistant-<n>` in its title, so
// `pnpm e2e --grep @app-assistant` runs exactly those. These checks read files only; no browser
// starts.

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '..', '..', '..');
const intent = path.join(repository, 'intents', '2026-11-app-assistant');
const read = (file: string) => readFile(file, 'utf8');
const tag = '@app-assistant-';

function groundTruthBehaviors(spec: string): number[] {
  const section = spec.slice(spec.indexOf('## Ground truth'), spec.indexOf('## Open risks'));
  const line = /`pnpm e2e` with the mock provider[^:]*:([\d,\sand]+)\./.exec(section)?.[1];
  if (!line) throw new Error('The spec names no behaviors for `pnpm e2e`');
  return [...line.matchAll(/\d+/g)].map((match) => Number(match[0]));
}

// The numbered behaviors of the spec, "1. Given …" to the last.
const specBehaviors = (spec: string): number[] =>
  [...spec.matchAll(/^(\d+)\. Given /gm)].map((match) => Number(match[1]));

async function taggedBehaviors(): Promise<Map<number, string[]>> {
  const covered = new Map<number, string[]>();
  const own = path.basename(fileURLToPath(import.meta.url));
  for (const file of await readdir(here)) {
    if (!file.endsWith('.spec.ts') || file === own) continue;
    const text = await read(path.join(here, file));
    for (const title of text.matchAll(/test\(\s*'([^']*)'/g)) {
      for (const match of (title[1] ?? '').matchAll(new RegExp(`${tag}(\\d+)`, 'g'))) {
        const behavior = Number(match[1]);
        covered.set(behavior, [...(covered.get(behavior) ?? []), `${file}: ${title[1]}`]);
      }
    }
  }
  return covered;
}

test.describe('app assistant coverage', () => {
  test('every behavior the ground truth names has an e2e case that names it', async () => {
    const spec = await read(path.join(intent, 'spec.md'));
    const named = groundTruthBehaviors(spec);
    expect(named).toEqual([7, 8, 9, 10, 11, 14, 17, 19, 21, 22, 25, 26]);
    const covered = await taggedBehaviors();
    expect(named.filter((behavior) => !covered.has(behavior))).toEqual([]);
    // Cases may cover more behaviors than the ground truth names, but only ones the spec has.
    const known = specBehaviors(spec);
    expect([...covered.keys()].filter((behavior) => !known.includes(behavior))).toEqual([]);
  });

  test('every sketch the spec interface names exists', async () => {
    const spec = await read(path.join(intent, 'spec.md'));
    const interfaceSection = spec.slice(spec.indexOf('## Interface'), spec.indexOf('## Bound'));
    const sketches = [
      ...interfaceSection.matchAll(/`intents\/2026-11-app-assistant\/sketches\/([\w-]+\.png)`/g),
    ].map((match) => match[1] ?? '');
    expect(sketches).toContain('first-start.png');
    const missing: string[] = [];
    for (const sketch of sketches) {
      await access(path.join(intent, 'sketches', sketch)).catch(() => missing.push(sketch));
    }
    expect(missing).toEqual([]);
  });

  test('the user guide has the assistant section and names its settings', async () => {
    const guide = await read(path.join(repository, 'docs', 'user-guide.md'));
    const section = guide.slice(guide.indexOf('## Assistant'), guide.indexOf('## Settings'));
    for (const heading of [
      '### Changes, proposals and Undo',
      '### Secrets',
      '### A setup to share',
      '### When it cannot start',
      '### Making a host token',
      '### Why does this not work',
    ]) {
      expect(section).toContain(heading);
    }
    const keys = [
      ...Object.entries(settingsRegistry)
        .filter(([, definition]) => definition.group === 'assistant')
        .map(([key]) => key),
      'keybindings.goAssistant',
      'providers.offerSetup',
    ];
    expect(keys.filter((key) => !guide.includes(`\`${key}\``))).toEqual([]);
    expect(guide).toContain('**Connect an agent**');
  });

  test('the Windows smoke check has the manual assistant check from the spec', async () => {
    const smoke = await read(path.join(repository, 'docs', 'windows-smoke.md'));
    const section = smoke.slice(smoke.indexOf('## 10. Assistant'), smoke.indexOf('## 11.'));
    expect(section).toMatch(/GitLab host through the assistant[\s\S]*token[\s\S]*test[\s\S]*pass/);
    expect(section).toMatch(/conversation[\s\S]*\.wow[\s\S]*no match/);
    expect(section).toMatch(/read `C:\\Windows\\win\.ini`/);
    expect(smoke.slice(smoke.indexOf('## 1. Install'), smoke.indexOf('## 2.'))).toContain(
      'Connect an agent',
    );
  });
});
