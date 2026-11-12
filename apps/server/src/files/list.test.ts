import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listFolderFiles } from './list.js';

// The thread folder's files for "Open file…" and `@` (agent workbench spec 18).

let folder: string;
const git = { timeoutMs: 10_000, stopWaitMs: 5_000 };

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'wow-list-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const write = async (relative: string, text = '') => {
  await mkdir(path.dirname(path.join(folder, relative)), { recursive: true });
  await writeFile(path.join(folder, relative), text);
};

const runGit = (...args: string[]) =>
  execFileSync('git', ['-C', folder, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Invented',
      GIT_AUTHOR_EMAIL: 'invented@example.invalid',
      GIT_COMMITTER_NAME: 'Invented',
      GIT_COMMITTER_EMAIL: 'invented@example.invalid',
    },
  });

const fakeChild = () => {
  const stdout = new EventEmitter();
  return Object.assign(new EventEmitter(), {
    pid: 42,
    stdout: Object.assign(stdout, { setEncoding: () => stdout }),
    kill: vi.fn<() => boolean>(() => true),
  });
};

describe('listFolderFiles', () => {
  it('lists tracked and untracked files Git does not ignore @agent-workbench-18', async () => {
    runGit('init', '-q');
    await write('.gitignore', 'dist/\n*.log\n');
    await write('src/timer.ts', 'export {};\n');
    await write('README.md', '# Invented\n');
    runGit('add', '.');
    runGit('commit', '-q', '-m', 'Invented start');
    // Changed after the commit: still listed once.
    await write('README.md', '# Invented, changed\n');
    await write('src/new file.ts', 'export {};\n');
    await write('dist/bundle.js', '');
    await write('debug.log', '');
    const listed = await listFolderFiles({ folder, limit: 100, git });
    expect(listed.source).toBe('git');
    expect(listed.truncated).toBe(false);
    expect(listed.files.toSorted()).toEqual([
      '.gitignore',
      'README.md',
      'src/new file.ts',
      'src/timer.ts',
    ]);
  });

  it('leaves out tracked files deleted from disk and submodule folders', async () => {
    runGit('init', '-q');
    await write('kept.txt');
    await write('gone.txt');
    // A submodule's entry in the index is its folder.
    await write('vendor/lib/inner.txt');
    execFileSync('git', ['-C', path.join(folder, 'vendor/lib'), 'init', '-q']);
    runGit('-C', path.join(folder, 'vendor/lib'), 'add', '.');
    runGit('-C', path.join(folder, 'vendor/lib'), 'commit', '-q', '-m', 'Invented inner');
    runGit('add', 'kept.txt', 'gone.txt', 'vendor/lib');
    runGit('commit', '-q', '-m', 'Invented start');
    await rm(path.join(folder, 'gone.txt'));
    const listed = await listFolderFiles({ folder, limit: 100, git });
    expect(listed).toEqual({ source: 'git', truncated: false, files: ['kept.txt'] });
  });

  // A process the test drives stands in for a git that lists two files and then hangs.
  it('keeps what git listed when it runs out of time, without walking', async () => {
    await write('a.txt');
    await write('b.txt');
    await write('ignored/walked.txt');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stdout = new EventEmitter();
      const child = Object.assign(new EventEmitter(), {
        stdout: Object.assign(stdout, { setEncoding: () => stdout }),
        kill: vi.fn<() => boolean>(() => true),
      });
      const listing = listFolderFiles({
        folder,
        limit: 100,
        git: { timeoutMs: 500, stopWaitMs: 5_000 },
        start: () => child,
      });
      stdout.emit('data', 'a.txt\0b.txt\0');
      vi.advanceTimersByTime(500);
      expect(child.kill).toHaveBeenCalled();
      child.emit('close', null);
      expect(await listing).toEqual({ source: 'git', truncated: true, files: ['a.txt', 'b.txt'] });
    } finally {
      vi.useRealTimers();
    }
  });

  // On Windows a git that is still running holds the folder, so a folder removed right after
  // the answer could not go; one that never closes must not hold the answer for ever.
  it('answers once a git stopped for running out of time is gone, or after the wait', async () => {
    await write('a.txt');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const stop = vi.fn<(child: { pid?: number | undefined }) => void>();
      const answers: string[] = [];
      const gone = fakeChild();
      const goneListing = listFolderFiles({
        folder,
        limit: 100,
        git: { timeoutMs: 500, stopWaitMs: 2_000, stop },
        start: () => gone,
      }).then((result) => answers.push('gone') && result);
      const stuck = fakeChild();
      const stuckListing = listFolderFiles({
        folder,
        limit: 100,
        git: { timeoutMs: 500, stopWaitMs: 2_000, stop },
        start: () => stuck,
      }).then((result) => answers.push('stuck') && result);
      gone.stdout.emit('data', 'a.txt\0');
      vi.advanceTimersByTime(500);
      expect(stop).toHaveBeenCalledTimes(2);
      expect(stop.mock.calls[0]?.[0]).toBe(gone);
      expect(stop.mock.calls[1]?.[0]).toBe(stuck);
      await new Promise((resolve) => setImmediate(resolve));
      expect(answers).toEqual([]);
      gone.emit('close', null);
      expect(await goneListing).toEqual({ source: 'git', truncated: true, files: ['a.txt'] });
      expect(answers).toEqual(['gone']);
      vi.advanceTimersByTime(2_000);
      expect(await stuckListing).toEqual({ source: 'git', truncated: true, files: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops at the limit inside Git', async () => {
    runGit('init', '-q');
    for (let index = 0; index < 5; index += 1) await write(`file-${index}.txt`);
    const listed = await listFolderFiles({ folder, limit: 3, git });
    expect(listed).toMatchObject({ source: 'git', truncated: true });
    expect(listed.files).toHaveLength(3);
  });

  it('walks a folder outside Git, nearest files first, without hidden folders', async () => {
    await write('README.md');
    await write('src/timer.ts');
    await write('src/deep/inner.ts');
    await write('.cache/state.json');
    await write('node_modules/pkg/index.js');
    const listed = await listFolderFiles({ folder, limit: 100, git });
    expect(listed).toEqual({
      source: 'walk',
      truncated: false,
      files: ['README.md', 'src/timer.ts', 'src/deep/inner.ts'],
    });
    expect(await listFolderFiles({ folder, limit: 2, git })).toEqual({
      source: 'walk',
      truncated: true,
      files: ['README.md', 'src/timer.ts'],
    });
  });

  it('walks when git is not there', async () => {
    await write('a.txt');
    const listed = await listFolderFiles({
      folder,
      limit: 10,
      git: { ...git, git: path.join(folder, 'no-such-git') },
    });
    expect(listed).toEqual({ source: 'walk', truncated: false, files: ['a.txt'] });
  });
});
