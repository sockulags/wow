import { settingsRegistry } from '@wow/contracts';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Settings coverage (U13): every tunable named in docs/architecture.md "Settings registry" is a
// registry entry and the other way round, and no tunable-looking constant in the server or the
// web app hides outside the registry.

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const registryKeys = Object.keys(settingsRegistry);

interface DocGroup {
  readonly group: string;
  // The delivery unit that still owes these keys, when the group is marked with one.
  readonly pendingUnit: string | undefined;
  readonly keys: readonly string[];
}

export function parseRegistryDoc(markdown: string): DocGroup[] {
  const start = markdown.indexOf('## Settings registry');
  if (start === -1) throw new Error('docs/architecture.md has no "Settings registry" section');
  const end = markdown.indexOf('\n## ', start + 1);
  const section = markdown.slice(start, end === -1 ? undefined : end);
  const groups: DocGroup[] = [];
  // A list item and its indented continuation lines.
  for (const item of section.split(/\n(?=- )/).slice(1)) {
    const text = item.split(/\n(?! {2})/)[0] ?? '';
    const head = /^- ([a-z]+)(?: \((U\d+)\))?:/.exec(text);
    if (!head?.[1]) continue;
    const keys = [...text.matchAll(/`([a-z][A-Za-z0-9]*(?:\.(?:[A-Za-z0-9]+|\*))+)`/g)].map(
      (match) => match[1] ?? '',
    );
    groups.push({ group: head[1], pendingUnit: head[2], keys });
  }
  return groups;
}

const covers = (pattern: string, key: string) =>
  pattern.endsWith('.*') ? key.startsWith(pattern.slice(0, -1)) : pattern === key;

describe('settings registry and docs/architecture.md', async () => {
  const groups = parseRegistryDoc(await readFile(path.join(root, 'docs/architecture.md'), 'utf8'));
  const named = groups.flatMap((group) => group.keys.map((key) => ({ ...group, key })));

  it('lists every settings group of the registry', () => {
    const groupsInRegistry = new Set(Object.values(settingsRegistry).map((entry) => entry.group));
    expect(groups.map((group) => group.group)).toEqual(
      expect.arrayContaining([...groupsInRegistry]),
    );
  });

  it('registers every setting the architecture names', () => {
    const missing = named
      .filter(({ pendingUnit }) => pendingUnit === undefined)
      .filter(({ key }) => !registryKeys.some((registered) => covers(key, registered)))
      .map(({ key }) => key);
    expect(missing, 'named in docs/architecture.md but not in settingsRegistry').toEqual([]);
  });

  it('keeps the pending marks honest', () => {
    const landed = named
      .filter(({ pendingUnit }) => pendingUnit !== undefined)
      .filter(({ key }) => registryKeys.some((registered) => covers(key, registered)))
      .map(({ key, pendingUnit }) => `${key} is registered: remove "(${pendingUnit})"`);
    expect(landed).toEqual([]);
  });

  it('names every registered setting', () => {
    const unnamed = registryKeys.filter((key) => !named.some((entry) => covers(entry.key, key)));
    expect(unnamed, 'in settingsRegistry but not in docs/architecture.md').toEqual([]);
  });

  it('puts each key under its own group', () => {
    const misplaced = named
      .filter(({ group, key }) => !key.startsWith(`${group}.`))
      .map(({ group, key }) => `${key} under ${group}`);
    expect(misplaced).toEqual([]);
    const outsideGroup = Object.entries(settingsRegistry)
      .filter(([key, definition]) => !key.startsWith(`${definition.group}.`))
      .map(([key]) => key);
    expect(outsideGroup).toEqual([]);
  });
});

// A literal number in one of these shapes is a value someone may want to change.
const tunableName =
  /(?:ms|seconds|minutes|hours|days|timeout|interval|delay|limit|max|min|retries|attempts|port|ttl|size|threshold|debounce|throttle|backoff)$/i;
const declaration =
  /(?:\bconst|\breadonly)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(-?\d[\d_]*(?:\.\d+)?)\b/g;
const property = /(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*:\s*(-?\d[\d_]*(?:\.\d+)?)\s*(?=[,}\n])/g;
const timer = /\bset(?:Timeout|Interval)\s*\([^;]*?,\s*(\d[\d_]*)\s*\)/g;

export interface TunableConstant {
  readonly name: string;
  readonly value: string;
  readonly line: number;
}

const trivial = (value: string) => ['0', '1', '-1'].includes(value.replaceAll('_', ''));

export function findTunables(source: string): TunableConstant[] {
  // Comments are prose, not code; drop them but keep line numbers.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const lineOf = (index: number) => code.slice(0, index).split('\n').length;
  const found: TunableConstant[] = [];
  for (const pattern of [declaration, property]) {
    for (const match of code.matchAll(pattern)) {
      const [, name = '', value = ''] = match;
      if (tunableName.test(name) && !trivial(value)) {
        found.push({ name, value, line: lineOf(match.index) });
      }
    }
  }
  for (const match of code.matchAll(timer)) {
    const value = match[1] ?? '';
    if (!trivial(value)) found.push({ name: 'timer delay', value, line: lineOf(match.index) });
  }
  return found;
}

// `<file>:<name>` → why it is not a setting. Keep reasons concrete; an entry that no longer matches
// anything fails the test so the list does not rot.
const exemptions: Readonly<Record<string, string>> = {
  'apps/server/src/hosts/github.ts:pageSize':
    "GitHub's largest page (per_page=100): a limit of the host's API, not a preference",
};

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .filter((entry) => !/\.test\.tsx?$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

describe('tunable constants', () => {
  it('finds the shapes it looks for', () => {
    const sample = [
      'const pollTimeoutMs = 5_000;',
      'readonly maxRetries: number = 3;',
      'const options = { initialDelayMs: 500, maxDelayMs: 10_000 };',
      'setTimeout(flush, 250);',
      'const attempts = 0; // a counter, not a tunable',
      'const pageTitle = 42;',
      '// const commentedTimeoutMs = 9000;',
    ].join('\n');
    expect(findTunables(sample).map(({ name, line }) => `${line}:${name}`)).toEqual([
      '1:pollTimeoutMs',
      '2:maxRetries',
      '3:initialDelayMs',
      '3:maxDelayMs',
      '4:timer delay',
    ]);
  });

  it('has a registry entry for every tunable in apps/server and apps/web', async () => {
    const files = [
      ...(await sourceFiles(path.join(root, 'apps/server/src'))),
      ...(await sourceFiles(path.join(root, 'apps/web/src'))),
    ];
    const used = new Set<string>();
    const unregistered: string[] = [];
    for (const file of files) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      for (const found of findTunables(await readFile(file, 'utf8'))) {
        const id = `${relative}:${found.name}`;
        if (Object.hasOwn(exemptions, id)) used.add(id);
        else unregistered.push(`${relative}:${found.line} ${found.name} = ${found.value}`);
      }
    }
    expect(
      unregistered,
      'Add a settingsRegistry entry and read it, or add an exemption with the reason',
    ).toEqual([]);
    expect(Object.keys(exemptions).filter((id) => !used.has(id))).toEqual([]);
  });
});
