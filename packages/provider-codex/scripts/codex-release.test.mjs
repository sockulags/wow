import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkOutput,
  compareVersions,
  docMentions,
  latestStable,
  readProtocolVersion,
  replaceMention,
} from './codex-release.mjs';

const repoDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

describe('compareVersions', () => {
  it('compares numerically, not as text', () => {
    expect(compareVersions('0.166.0', '0.166.0')).toBe(0);
    expect(compareVersions('0.167.0', '0.166.0')).toBeGreaterThan(0);
    expect(compareVersions('0.99.0', '0.166.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.999.999')).toBeGreaterThan(0);
    expect(compareVersions('0.166.10', '0.166.9')).toBeGreaterThan(0);
  });

  it('refuses prereleases', () => {
    expect(() => compareVersions('0.167.0-alpha.1', '0.166.0')).toThrow('0.167.0-alpha.1');
  });
});

describe('latestStable', () => {
  it('picks the newest stable version from npm view --json, skipping prereleases and platform builds', () => {
    const versions = [
      '0.9.0',
      '0.166.0',
      '0.166.0-linux-x64',
      '0.167.0-alpha.4',
      '0.167.0-alpha.4-win32-x64',
      '0.100.0',
    ];
    expect(latestStable(JSON.stringify(versions))).toBe('0.166.0');
  });

  it('takes a single version as given', () => {
    expect(latestStable('0.170.2\n')).toBe('0.170.2');
    expect(latestStable('"0.170.2"')).toBe('0.170.2');
  });

  it('finds nothing in a single prerelease or a list without stable versions', () => {
    expect(latestStable('0.170.0-alpha.1')).toBeUndefined();
    expect(latestStable('["0.1.0-beta"]')).toBeUndefined();
  });
});

describe('check', () => {
  it('reads the generated version and says whether to update', () => {
    const index = `// Generated\nexport const codexProtocolVersion = '0.166.0';\n`;
    const current = readProtocolVersion(index);
    expect(checkOutput(current, '0.166.0')).toBe('current=0.166.0\nlatest=0.166.0\nupdate=false\n');
    expect(checkOutput(current, '0.167.0')).toBe('current=0.166.0\nlatest=0.167.0\nupdate=true\n');
    expect(checkOutput(current, '0.165.3')).toContain('update=false');
    expect(checkOutput(current, undefined)).toBe('current=0.166.0\nlatest=\nupdate=false\n');
  });

  it('reads the committed generated index', () => {
    const index = readFileSync(
      join(repoDir, 'packages/provider-codex/src/protocol/generated/index.ts'),
      'utf8',
    );
    expect(readProtocolVersion(index)).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('fails when the generated index has no version', () => {
    expect(() => readProtocolVersion('export {};')).toThrow('codexProtocolVersion');
  });
});

describe('docs', () => {
  it('finds every version mention in the committed docs, on the generated version', () => {
    const index = readFileSync(
      join(repoDir, 'packages/provider-codex/src/protocol/generated/index.ts'),
      'utf8',
    );
    const version = readProtocolVersion(index);
    for (const { file, pattern } of docMentions) {
      const match = pattern.exec(readFileSync(join(repoDir, file), 'utf8'));
      expect({ file, mention: match?.[0] }).toEqual({
        file,
        mention: expect.stringContaining(version),
      });
    }
  });

  it('replaces the version and keeps the sentence', () => {
    const [readme] = docMentions;
    if (!readme) throw new Error('no doc mentions');
    const text = 'is generated from codex **0.166.0** and is not edited by hand';
    expect(replaceMention(text, readme.pattern, '0.170.1', readme.file)).toBe(
      'is generated from codex **0.170.1** and is not edited by hand',
    );
    expect(() => replaceMention('reworded', readme.pattern, '0.170.1', readme.file)).toThrow(
      readme.file,
    );
  });
});
