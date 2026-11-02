import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverCodexFolders } from './discover.js';

// Invented CODEX_HOME directories: `sessions/YYYY/MM/DD/rollout-*.jsonl`.

let codexHome: string;

beforeEach(async () => {
  codexHome = await mkdtemp(path.join(tmpdir(), 'wow-codex-discover-'));
});

afterEach(async () => {
  await rm(codexHome, { recursive: true, force: true });
});

async function rollout(day: string, name: string, lines: unknown[], modified: string) {
  const dir = path.join(codexHome, 'sessions', ...day.split('-'));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-${name}.jsonl`);
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n'));
  await utimes(file, new Date(modified), new Date(modified));
}

describe('discoverCodexFolders', () => {
  it('reads the cwd from session metadata, old and new layouts, newest time per folder', async () => {
    await rollout(
      '2026-10-30',
      'a',
      [{ type: 'session_meta', payload: { id: 'a', cwd: '/work/api' } }],
      '2026-10-30T09:00:00.000Z',
    );
    await rollout(
      '2026-11-01',
      'b',
      [{ type: 'session_meta', payload: { id: 'b', cwd: '/work/api' } }],
      '2026-11-01T09:00:00.000Z',
    );
    await rollout(
      '2026-09-01',
      'c',
      [{ id: 'c', timestamp: '2026-09-01T09:00:00.000Z', cwd: '/work/legacy' }],
      '2026-09-01T09:00:00.000Z',
    );
    await rollout('2026-09-02', 'd', [{ type: 'event_msg', payload: {} }], '2026-09-02T09:00:00Z');
    const found = await discoverCodexFolders(codexHome);
    expect(found).toHaveLength(2);
    expect(found).toContainEqual({ cwd: '/work/api', lastUsedAt: '2026-11-01T09:00:00.000Z' });
    expect(found).toContainEqual({ cwd: '/work/legacy', lastUsedAt: '2026-09-01T09:00:00.000Z' });
  });

  it('finds nothing without a sessions folder', async () => {
    expect(await discoverCodexFolders(codexHome)).toEqual([]);
  });
});
