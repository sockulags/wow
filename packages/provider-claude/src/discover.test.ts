import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeClaudeProjectName, discoverClaudeFolders } from './discover.js';

// Invented Claude Code config directories: `projects/<encoded cwd>/<session>.jsonl`.

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), 'wow-claude-discover-'));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

async function session(folder: string, name: string, lines: unknown[], modified: string) {
  const dir = path.join(configDir, 'projects', folder);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(
    file,
    lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'),
  );
  await utimes(file, new Date(modified), new Date(modified));
}

describe('discoverClaudeFolders', () => {
  it('reads the cwd of the newest session, past summary lines and broken lines', async () => {
    await session(
      '-work-my-app',
      'old.jsonl',
      [{ type: 'user', cwd: '/work/my-app-old', sessionId: 'a' }],
      '2026-10-01T08:00:00.000Z',
    );
    await session(
      '-work-my-app',
      'new.jsonl',
      [
        { type: 'summary', summary: 'Invented summary' },
        '{"type":"user","cwd":',
        { type: 'user', cwd: '/work/my-app', sessionId: 'b' },
      ],
      '2026-11-01T08:00:00.000Z',
    );
    expect(await discoverClaudeFolders(configDir)).toEqual([
      { cwd: '/work/my-app', lastUsedAt: '2026-11-01T08:00:00.000Z' },
    ]);
  });

  it('falls back to the folder name when no session says where it ran', async () => {
    await session('-work-site', 'empty.jsonl', [{ type: 'summary' }], '2026-11-02T08:00:00.000Z');
    await mkdir(path.join(configDir, 'projects', 'C--Users-me-code'), { recursive: true });
    await mkdir(path.join(configDir, 'projects', 'not-encoded'), { recursive: true });
    const found = await discoverClaudeFolders(configDir);
    expect(found).toHaveLength(2);
    expect(found).toContainEqual({ cwd: '/work/site', lastUsedAt: '2026-11-02T08:00:00.000Z' });
    expect(found).toContainEqual({ cwd: 'C:\\Users\\me\\code', lastUsedAt: null });
  });

  it('finds nothing in a config directory without projects', async () => {
    expect(await discoverClaudeFolders(path.join(configDir, 'missing'))).toEqual([]);
  });
});

describe('decodeClaudeProjectName', () => {
  it('decodes POSIX and Windows names and leaves others alone', () => {
    expect(decodeClaudeProjectName('-home-me-wow')).toBe('/home/me/wow');
    expect(decodeClaudeProjectName('D--src-wow')).toBe('D:\\src\\wow');
    expect(decodeClaudeProjectName('wow')).toBeUndefined();
  });
});
