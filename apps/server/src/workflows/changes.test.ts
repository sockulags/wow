import type { RunDiffFile } from '@wow/contracts';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addedPatch,
  readRunBase,
  readThreadDiff,
  snapshotChanges,
  type ChangesOptions,
} from './changes.js';

// A thread's Changes (agent workbench spec 34, 35) against temporary repositories with invented
// files.

const options: ChangesOptions = {
  git: { timeoutMs: 20_000, stopWaitMs: 5_000 },
  maxFileBytes: 20_000,
  maxFiles: 100,
  maxHashBytes: 1_000_000,
};

let root: string;
const ceiling = process.env['GIT_CEILING_DIRECTORIES'];

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-changes-'));
  // The temporary folder must never be read as part of a repository around it.
  process.env['GIT_CEILING_DIRECTORIES'] = root;
});
afterAll(async () => {
  if (ceiling === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
  else process.env['GIT_CEILING_DIRECTORIES'] = ceiling;
  await rm(root, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.name=Invented',
      '-c',
      'user.email=invented@example.invalid',
      '-c',
      'commit.gpgsign=false',
      // The tests decide line endings themselves, whatever this machine's git is set to.
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    { stdio: 'pipe', encoding: 'utf8' },
  );

const lines = (count: number, word: string) =>
  Array.from({ length: count }, (_, index) => `${word} ${index + 1}\n`).join('');

async function write(repo: string, relative: string, content: string | Uint8Array) {
  const file = path.join(repo, ...relative.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

// A repository with one commit holding the given files; answers its folder and that commit.
async function repository(name: string, files: Record<string, string | Uint8Array>) {
  const repo = path.join(root, name);
  await mkdir(repo);
  git(repo, 'init', '-q', '-b', 'main');
  for (const [relative, content] of Object.entries(files)) await write(repo, relative, content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Invented start');
  return { repo, base: git(repo, 'rev-parse', 'HEAD').trim() };
}

const diffOf = (repo: string, base: string | null, asked?: string, limits = options) =>
  readThreadDiff({
    folder: repo,
    baseSha: base,
    baseFiles: [],
    mark: null,
    path: asked,
    options: limits,
  });

const row = (file: RunDiffFile | undefined) =>
  file && [file.path, file.status, file.added, file.removed, file.oldPath];

describe('the base of a thread', () => {
  it('is the commit the folder is on, with what already differed from it', async () => {
    const { repo, base } = await repository('base', { 'kept.txt': 'one\n', 'dirty.txt': 'a\n' });
    await write(repo, 'dirty.txt', 'a\nb\n');
    const found = await readRunBase(repo, options);
    expect(found?.baseSha).toBe(base);
    expect(found?.files).toEqual([
      { path: 'dirty.txt', hash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
  });

  it('is not there for a folder that is not a repository, has no commit, or without git', async () => {
    const plain = path.join(root, 'plain-base');
    await mkdir(plain);
    expect(await readRunBase(plain, options)).toBeUndefined();
    const empty = path.join(root, 'empty-base');
    await mkdir(empty);
    git(empty, 'init', '-q');
    expect(await readRunBase(empty, options)).toBeUndefined();
    const { repo } = await repository('base-no-git', { 'a.txt': 'a\n' });
    const noGit = {
      ...options,
      git: { timeoutMs: 20_000, stopWaitMs: 5_000, git: path.join(root, 'no-such-git') },
    };
    expect(await readRunBase(repo, noGit)).toBeUndefined();
  });
});

describe('the changes of a thread', () => {
  it('lists committed, uncommitted, untracked, renamed and deleted files with their line changes (spec 11)', async () => {
    const { repo, base } = await repository('statuses', {
      '.gitignore': '*.log\n',
      'committed.txt': lines(5, 'row'),
      'uncommitted.txt': lines(5, 'row'),
      'docs/old-name.md': lines(30, 'paragraph'),
      'gone.txt': lines(4, 'row'),
      'same.txt': 'never touched\n',
    });
    await write(repo, 'committed.txt', `${lines(5, 'row')}row 6\nrow 7\n`);
    git(repo, 'commit', '-q', '-am', 'Invented later commit');
    await write(repo, 'uncommitted.txt', lines(5, 'row').replace('row 3\n', 'row three\n'));
    await write(repo, 'notes/new.md', '# New\n\nTwo lines of text.\n');
    await write(repo, 'build.log', 'ignored by git\n');
    git(repo, 'mv', 'docs/old-name.md', 'docs/new-name.md');
    await rm(path.join(repo, 'gone.txt'));

    const diff = await diffOf(repo, base);
    expect(diff).toMatchObject({ status: 'ok', baseSha: base, omitted: 0, patch: null });
    expect(diff.files.map(row)).toEqual([
      ['committed.txt', 'modified', 2, 0, null],
      ['docs/new-name.md', 'renamed', 0, 0, 'docs/old-name.md'],
      ['gone.txt', 'deleted', 0, 4, null],
      ['notes/new.md', 'added', 3, 0, null],
      ['uncommitted.txt', 'modified', 1, 1, null],
    ]);
    expect(diff.files.every((file) => file.content === 'text')).toBe(true);
    // A deleted file's size is the one it had in the base.
    expect(diff.files.find((file) => file.path === 'gone.txt')?.size).toBe(lines(4, 'row').length);
  });

  it('answers one file with its diff from the first hunk on', async () => {
    const { repo, base } = await repository('patches', {
      'edited.txt': lines(3, 'row'),
      'moved.txt': lines(30, 'paragraph'),
    });
    await write(repo, 'edited.txt', 'row 1\nrow two\nrow 3\n');
    await write(repo, 'fresh.txt', 'first\nsecond');
    git(repo, 'mv', 'moved.txt', 'moved-here.txt');

    const edited = await diffOf(repo, base, 'edited.txt');
    expect(edited.files.map(row)).toEqual([['edited.txt', 'modified', 1, 1, null]]);
    expect(edited.patch).toBe('@@ -1,3 +1,3 @@\n row 1\n-row 2\n+row two\n row 3\n');

    expect((await diffOf(repo, base, 'fresh.txt')).patch).toBe(
      '@@ -0,0 +1,2 @@\n+first\n+second\n\\ No newline at end of file\n',
    );
    // Renamed without a changed line: listed as one file, with nothing to show.
    const moved = await diffOf(repo, base, 'moved-here.txt');
    expect(moved.files.map(row)).toEqual([['moved-here.txt', 'renamed', 0, 0, 'moved.txt']]);
    expect(moved.patch).toBe('');
    // A path that is not among the changes answers with no file rather than reading it.
    expect(await diffOf(repo, base, '../outside.txt')).toMatchObject({
      status: 'ok',
      files: [],
      patch: null,
    });
  });

  it('shows a binary or oversize file with its status and size only (spec 12)', async () => {
    const binary = Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0xff, 0, 1, 2, 3]);
    const { repo, base } = await repository('unshown', {
      'archive.bin': binary,
      'big.txt': lines(10, 'row'),
    });
    await write(repo, 'archive.bin', Uint8Array.from([...binary, 9, 9]));
    await write(repo, 'new.bin', binary);
    await write(repo, 'big.txt', lines(3000, 'a long row of invented text'));
    await write(repo, 'big-new.txt', lines(3000, 'a long row of invented text'));

    const diff = await diffOf(repo, base);
    expect(
      diff.files.map((file) => [file.path, file.status, file.content, file.added, file.size]),
    ).toEqual([
      ['archive.bin', 'modified', 'binary', null, 12],
      ['big-new.txt', 'added', 'tooLarge', null, lines(3000, 'a long row of invented text').length],
      ['big.txt', 'modified', 'tooLarge', null, lines(3000, 'a long row of invented text').length],
      ['new.bin', 'added', 'binary', null, 10],
    ]);
    for (const file of diff.files) {
      expect((await diffOf(repo, base, file.path)).patch).toBeNull();
    }
    // The limit is the setting: with a larger one the same file shows its lines.
    const roomy = await diffOf(repo, base, 'big.txt', { ...options, maxFileBytes: 1_000_000 });
    expect(roomy.files[0]).toMatchObject({ content: 'text', added: 3000, removed: 10 });
    expect(roomy.patch?.startsWith('@@ ')).toBe(true);
  });

  it('counts only the changed line of a file whose line endings the repository converts', async () => {
    const { repo, base } = await repository('crlf', {
      '.gitattributes': '* text=auto\n',
      'windows.txt': lines(40, 'row'),
    });
    // What an editor on Windows leaves: every line ends with CRLF, and one line is different.
    const edited = lines(40, 'row').replace('row 20\n', 'row twenty\n').replaceAll('\n', '\r\n');
    await write(repo, 'windows.txt', edited);

    const diff = await diffOf(repo, base, 'windows.txt');
    expect(diff.files.map(row)).toEqual([['windows.txt', 'modified', 1, 1, null]]);
    expect(diff.patch).toContain('-row 20\n+row twenty\n');
    // The same file with only its line endings changed is not a change at all.
    await write(repo, 'windows.txt', lines(40, 'row').replaceAll('\n', '\r\n'));
    expect((await diffOf(repo, base)).files).toEqual([]);
  });

  it('leaves out files past the list limit and says how many', async () => {
    const { repo, base } = await repository('many', { 'a.txt': 'a\n' });
    for (const name of ['b', 'c', 'd', 'e']) await write(repo, `${name}.txt`, `${name}\n`);
    const diff = await diffOf(repo, base, undefined, { ...options, maxFiles: 3 });
    expect(diff.files.map((file) => file.path)).toEqual(['b.txt', 'c.txt', 'd.txt']);
    expect(diff.omitted).toBe(1);
  });

  it.skipIf(process.platform === 'win32')(
    'does not read through a new link that points out of the folder',
    async () => {
      const { repo, base } = await repository('links', { 'a.txt': 'a\n' });
      const outside = path.join(root, 'outside-secret.txt');
      await writeFile(outside, 'not for the diff\n');
      await symlink(outside, path.join(repo, 'link.txt'));
      const diff = await diffOf(repo, base, 'link.txt');
      expect(diff.files[0]).toMatchObject({ path: 'link.txt', status: 'added', content: 'binary' });
      expect(diff.patch).toBeNull();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not follow a tracked folder that was replaced by a link, for size or hash',
    async () => {
      const { repo, base } = await repository('folder-link', { 'src/a.txt': 'a\n' });
      const outside = path.join(root, 'outside-folder');
      await mkdir(outside);
      await writeFile(path.join(outside, 'a.txt'), 'outside the folder, longer\n');
      await rm(path.join(repo, 'src'), { recursive: true });
      await symlink(outside, path.join(repo, 'src'), 'dir');
      const hashes = await snapshotChanges(repo, base, options);
      expect(hashes?.find((entry) => entry.path === 'src/a.txt')).toEqual({
        path: 'src/a.txt',
        hash: null,
      });
      const diff = await diffOf(repo, base);
      expect(diff.files.find((file) => file.path === 'src/a.txt')).toMatchObject({
        status: 'deleted',
        size: 2,
      });
    },
  );

  it('changes nothing in the folder or the repository', async () => {
    const { repo, base } = await repository('untouched', { 'a.txt': 'a\n' });
    await write(repo, 'a.txt', 'b\n');
    await write(repo, 'new.txt', 'new\n');
    const state = () =>
      [git(repo, 'status', '--porcelain'), git(repo, 'count-objects', '-v')].join('\n');
    const index = () => readFile(path.join(repo, '.git', 'index'));
    const before = { state: state(), index: await index() };
    await readRunBase(repo, options);
    await snapshotChanges(repo, base, options);
    await diffOf(repo, base);
    await diffOf(repo, base, 'new.txt');
    expect(state()).toBe(before.state);
    expect((await index()).equals(before.index)).toBe(true);
  });

  it('says why there is nothing to compare (spec 13)', async () => {
    const plain = path.join(root, 'plain');
    await mkdir(plain);
    expect(await diffOf(plain, null)).toMatchObject({ status: 'noRepository', files: [] });
    // Also for a run that recorded a base while the folder still was a repository.
    expect(await diffOf(plain, 'a'.repeat(40))).toMatchObject({ status: 'noRepository' });
    expect(await diffOf(path.join(root, 'gone'), null)).toMatchObject({ status: 'folderMissing' });

    const { repo, base } = await repository('reasons', { 'a.txt': 'a\n' });
    expect(await diffOf(repo, null)).toMatchObject({ status: 'noBase', baseSha: null });
    expect(await diffOf(repo, 'a'.repeat(40))).toMatchObject({ status: 'baseMissing' });
    const noGit = {
      ...options,
      git: { timeoutMs: 20_000, stopWaitMs: 5_000, git: path.join(root, 'no-such-git') },
    };
    expect(await diffOf(repo, base, undefined, noGit)).toMatchObject({
      status: 'gitUnavailable',
      files: [],
    });
  });
});

describe('what changed in a turn', () => {
  it('does not read a file larger than diff.maxHashBytes, and still sees it change', async () => {
    const { repo, base } = await repository('big-hash', { 'a.txt': 'a\n' });
    const content = 'x'.repeat(100);
    await write(repo, 'big.bin', content);
    const small = { ...options, maxHashBytes: 50 };
    const first = (await snapshotChanges(repo, base, small))?.[0]?.hash;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(createHash('sha256').update(content).digest('hex'));
    const later = new Date('2026-11-02T09:00:00.000Z');
    await utimes(path.join(repo, 'big.bin'), later, later);
    const second = (await snapshotChanges(repo, base, small))?.[0]?.hash;
    expect(second).not.toBe(first);
    // Under the limit the content itself is hashed.
    expect((await snapshotChanges(repo, base, options))?.[0]?.hash).toBe(
      createHash('sha256').update(content).digest('hex'),
    );
  });

  it('writes a new file as added lines', () => {
    expect(addedPatch('')).toBe('');
    expect(addedPatch('only\n')).toBe('@@ -0,0 +1 @@\n+only\n');
  });
});
