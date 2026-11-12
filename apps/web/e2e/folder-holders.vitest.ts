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

// No real wmic or tasklist runs: on the Windows runner they can take longer than the test timeout.
const holders = vi.hoisted(() => ({ wmic: undefined as string | undefined }));

vi.mock('node:child_process', () => ({
  execFileSync: (command: string) => {
    if (command === 'wmic' && holders.wmic !== undefined) return holders.wmic;
    throw new Error(`${command} is not available`);
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
  holders.wmic = [
    'Node,CommandLine,Name,ParentProcessId,ProcessId',
    `INVENTED-HOST,node.exe watch.js ${path.join(root, 'repo')},node.exe,10,11`,
    'INVENTED-HOST,notepad.exe,notepad.exe,10,12',
  ].join('\r\n');
  vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
    written += String(text);
    return true;
  });
});

afterEach(() => {
  failing.rename.clear();
  failing.rm.clear();
  holders.wmic = undefined;
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
    expect(written).toContain(`node.exe watch.js ${repo},node.exe,10,11`);
    expect(written).not.toContain('notepad.exe');
  });

  it('falls back to saying no lookup could run when wmic and tasklist are missing', () => {
    const repo = path.join(root, 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    failing.rm.add(path.join(repo, '.git'));
    holders.wmic = undefined;

    expect(() => emptyFolder(repo, 'win32')).toThrow(/EBUSY/);
    expect(written).toContain('neither wmic nor tasklist could run');
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
    expect(written).toContain(
      `[e2e] ${repo} is held (EBUSY while renaming ${repo}.probe back to ${repo})`,
    );
    expect(written).toContain(`node.exe watch.js ${repo},node.exe,10,11`);
  });

  it('looks up holders of the folder when a leftover probe cannot be removed', () => {
    const repo = path.join(root, 'repo');
    mkdirSync(repo);
    failing.rm.add(`${repo}.probe`);

    reportFolderHolders(repo, 'win32');
    expect(written).toContain(
      `[e2e] ${repo} is held (EBUSY while removing the probe ${repo}.probe an earlier run left)`,
    );
    expect(written).toContain(`node.exe watch.js ${repo},node.exe,10,11`);
    expect(existsSync(repo)).toBe(true);
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
    expect(written).toContain(`node.exe watch.js ${repo},node.exe,10,11`);
    expect(existsSync(repo)).toBe(true);
  });
});
