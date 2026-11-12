import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
