import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listFolderFiles } from './list.js';

// The thread folder's files for "Open file…" and `@` (agent workbench spec 18).

let folder: string;
const git = { timeoutMs: 10_000 };

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

  // A script stands in for a git that lists two files and then hangs.
  it.skipIf(process.platform === 'win32')(
    'keeps what git listed when it runs out of time, without walking',
    async () => {
      await write('a.txt');
      await write('b.txt');
      await write('ignored/walked.txt');
      const slowGit = path.join(folder, 'slow-git');
      await writeFile(slowGit, "#!/bin/sh\nprintf 'a.txt\\0b.txt\\0'\nexec sleep 30\n");
      await chmod(slowGit, 0o755);
      const listed = await listFolderFiles({
        folder,
        limit: 100,
        git: { timeoutMs: 500, git: slowGit },
      });
      expect(listed).toEqual({ source: 'git', truncated: true, files: ['a.txt', 'b.txt'] });
    },
  );

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
