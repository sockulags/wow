import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyFolder, reportFolderHolders } from './folder-holders';

const failing = vi.hoisted(() => ({
  rename: new Set<string>(),
  rm: new Set<string>(),
  refuse: (target: string): never => {
    throw Object.assign(new Error(`EBUSY: resource busy or locked, '${target}'`), {
      code: 'EBUSY',
    });
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    renameSync: (from: fs.PathLike, to: fs.PathLike) =>
      failing.rename.has(String(from)) ? failing.refuse(String(from)) : actual.renameSync(from, to),
    rmSync: (target: fs.PathLike, options?: fs.RmOptions) =>
      failing.rm.has(String(target))
        ? failing.refuse(String(target))
        : actual.rmSync(target, options),
  };
});

let root = '';
let written = '';

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'wow-holders-'));
  written = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
    written += String(text);
    return true;
  });
});

afterEach(() => {
  failing.rename.clear();
  failing.rm.clear();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('emptyFolder', () => {
  it('names the possible holders before it gives up on a folder it cannot empty', () => {
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    failing.rm.add(path.join(repo, '.git'));

    expect(() => emptyFolder(repo, 'win32')).toThrow(/EBUSY/);
    expect(written).toContain(`[e2e] ${repo} is held (EBUSY while emptying it)`);
    expect(written).toContain('processes that may hold it');
  });

  it('empties the folder and leaves it in place', () => {
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    writeFileSync(path.join(repo, 'src', 'a.ts'), 'a');

    emptyFolder(repo, 'win32');
    expect(readdirSync(repo)).toEqual([]);
    expect(written).toBe('');
  });
});

describe('reportFolderHolders', () => {
  it('goes on with a new folder when the probe cannot be renamed back', () => {
    const repo = path.join(root, 'repo');
    mkdirSync(repo);
    failing.rename.add(`${repo}.probe`);

    expect(() => reportFolderHolders(repo, 'win32')).not.toThrow();
    expect(existsSync(repo)).toBe(true);
    expect(written).toContain(`while renaming ${repo}.probe back to ${repo}`);
  });

  it('removes a probe folder an earlier run left before it probes', () => {
    const repo = path.join(root, 'repo');
    mkdirSync(repo);
    mkdirSync(`${repo}.probe`);
    writeFileSync(path.join(`${repo}.probe`, 'left.txt'), 'left');

    reportFolderHolders(repo, 'win32');
    expect(written).toBe('');
    expect(existsSync(repo)).toBe(true);
    expect(existsSync(`${repo}.probe`)).toBe(false);
  });

  it('says which step found the folder held', () => {
    const repo = path.join(root, 'repo');
    mkdirSync(repo);
    failing.rename.add(repo);

    reportFolderHolders(repo, 'win32');
    expect(written).toContain(`[e2e] ${repo} is held (EBUSY while renaming it to ${repo}.probe)`);
    expect(existsSync(repo)).toBe(true);
  });
});
