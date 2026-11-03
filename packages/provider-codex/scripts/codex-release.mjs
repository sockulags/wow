// Helpers for .github/workflows/codex-protocol.yml, which moves this package to a new codex release.
//
//   node scripts/codex-release.mjs check [--exact] < version   prints current=, latest=, update=
//   node scripts/codex-release.mjs docs <version>              names <version> where the docs say
//                                                              which codex the protocol comes from
//
// `check` reads `npm view @openai/codex version` (one version) or `... versions --json` (a JSON
// array) from stdin. Prereleases and platform builds (0.167.0-alpha.1, 0.166.0-linux-x64) never
// count as an update; with --exact (a version the owner asked for) they are an error instead.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(packageDir, '..', '..');

const stable = /^(\d+)\.(\d+)\.(\d+)$/;

/** @param {string} version */
export function isStable(version) {
  return stable.test(version);
}

/** @param {string} a @param {string} b @returns {number} negative, zero or positive like a sort */
export function compareVersions(a, b) {
  const pa = stable.exec(a);
  const pb = stable.exec(b);
  if (!pa || !pb) throw new Error(`Not a stable version: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** @param {string} source text of src/protocol/generated/index.ts */
export function readProtocolVersion(source) {
  const match = /export const codexProtocolVersion = '([^']+)';/.exec(source);
  if (!match?.[1]) throw new Error('codexProtocolVersion not found in the generated index.ts');
  return match[1];
}

/**
 * @param {string} input stdin of `check`: one version or a JSON array of versions
 * @returns {string | undefined} the newest stable version, or undefined when there is none
 */
export function latestStable(input) {
  const text = input.trim();
  if (text.startsWith('[')) {
    /** @type {unknown} */
    const list = JSON.parse(text);
    if (!Array.isArray(list)) throw new Error('Expected a JSON array of versions');
    const versions = list.filter((v) => typeof v === 'string' && isStable(v));
    return versions.toSorted(compareVersions).at(-1);
  }
  const version = text.replace(/^"|"$/g, '');
  return isStable(version) ? version : undefined;
}

/** @param {string} current @param {string | undefined} latest */
export function checkOutput(current, latest) {
  const update = latest !== undefined && compareVersions(latest, current) > 0;
  return `current=${current}\nlatest=${latest ?? ''}\nupdate=${update}\n`;
}

// Where the docs name the codex release the generated protocol comes from. Every pattern must
// match, so a reworded sentence fails the workflow instead of leaving an old version behind.
export const docMentions = [
  {
    file: 'packages/provider-codex/README.md',
    pattern: /(generated from codex \*\*)\d+\.\d+\.\d+(\*\*)/,
  },
  { file: 'docs/architecture.md', pattern: /(\(currently codex )\d+\.\d+\.\d+(\))/ },
];

/** @param {string} text @param {RegExp} pattern @param {string} version @param {string} file */
export function replaceMention(text, pattern, version, file) {
  if (!pattern.test(text))
    throw new Error(`${file} no longer names the codex version (${pattern})`);
  return text.replace(pattern, `$1${version}$2`);
}

function main() {
  const [command, arg] = process.argv.slice(2);
  if (command === 'check' && (arg === undefined || arg === '--exact')) {
    const index = readFileSync(join(packageDir, 'src/protocol/generated/index.ts'), 'utf8');
    const input = readFileSync(0, 'utf8');
    const latest = latestStable(input);
    if (!latest && arg === '--exact') throw new Error(`Not a stable version: "${input.trim()}"`);
    process.stdout.write(checkOutput(readProtocolVersion(index), latest));
  } else if (command === 'docs' && arg && isStable(arg)) {
    for (const { file, pattern } of docMentions) {
      const path = join(repoDir, file);
      writeFileSync(path, replaceMention(readFileSync(path, 'utf8'), pattern, arg, file));
    }
  } else {
    throw new Error(
      'Usage: codex-release.mjs check [--exact] < version | codex-release.mjs docs <version>',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
