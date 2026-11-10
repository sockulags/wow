import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { candidatePaths, isInside, readViewerFile } from './read.js';

// The viewer's file reads (review loop spec 6 and 8) against invented files in a temporary
// folder: `project` is the folder a run may read, `outside` sits next to it.

let base: string;
let project: string;
let outside: string;

const pngChunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  // The viewer only looks at the signature, so the checksum can stay empty.
  return Buffer.concat([head, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
};

// A valid one-pixel PNG, built here so no binary fixture is checked in.
function onePixelPng(): Buffer {
  const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

beforeEach(async () => {
  // The temporary folder is itself behind a link on some systems; start from its real path.
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'wow-files-')));
  project = path.join(base, 'project');
  outside = path.join(base, 'outside');
  await mkdir(path.join(project, 'review'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'invented secret\n');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const read = (requested: string, maxBytes = 10_000, roots = [project]) =>
  readViewerFile({ roots, path: requested, maxBytes });

describe('reading one file of each kind', () => {
  it('reads a markdown file as markdown', async () => {
    await writeFile(path.join(project, 'review', 'notes.md'), '# Notes\n\n| a | b |\n');
    expect(await read('review/notes.md')).toEqual({
      kind: 'markdown',
      absolutePath: path.join(project, 'review', 'notes.md'),
      size: 19,
      text: '# Notes\n\n| a | b |\n',
    });
  });

  it('reads a PNG as an image, told by its first bytes and not its name', async () => {
    const png = onePixelPng();
    await writeFile(path.join(project, 'review', 'screen.dat'), png);
    expect(await read('review/screen.dat')).toEqual({
      kind: 'image',
      absolutePath: path.join(project, 'review', 'screen.dat'),
      size: png.byteLength,
      mediaType: 'image/png',
      base64: png.toString('base64'),
    });
  });

  it('reads an SVG file as an image', async () => {
    await writeFile(path.join(project, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(await read('logo.svg')).toMatchObject({ kind: 'image', mediaType: 'image/svg+xml' });
  });

  it('reads an HTML file as html', async () => {
    await writeFile(path.join(project, 'review', 'report.HTML'), '<h1>Report</h1>');
    expect(await read('review/report.HTML')).toMatchObject({
      kind: 'html',
      text: '<h1>Report</h1>',
    });
  });

  it('reads any other text as text', async () => {
    await writeFile(path.join(project, 'review', 'build.log'), 'ok 12 tests\n');
    expect(await read('review/build.log')).toMatchObject({ kind: 'text', text: 'ok 12 tests\n' });
  });

  it('reads UTF-16 text with a byte order mark, as Windows tools write it', async () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('räksmörgås', 'utf16le')]);
    await writeFile(path.join(project, 'out.txt'), bytes);
    expect(await read('out.txt')).toMatchObject({ kind: 'text', text: 'räksmörgås' });
  });

  it('reads a full path inside the folder, and a file exactly at the size limit', async () => {
    await writeFile(path.join(project, 'exact.txt'), 'x'.repeat(100));
    expect(await read(path.join(project, 'exact.txt'), 100)).toMatchObject({
      kind: 'text',
      size: 100,
    });
  });

  it('looks in the working folder first and then in the project folder', async () => {
    const workingCopy = path.join(base, 'working-copy');
    await mkdir(workingCopy);
    await writeFile(path.join(workingCopy, 'both.txt'), 'from the working copy');
    await writeFile(path.join(project, 'both.txt'), 'from the project');
    await writeFile(path.join(project, 'only.txt'), 'only in the project');
    const roots = [workingCopy, project];
    expect(await read('both.txt', 10_000, roots)).toMatchObject({ text: 'from the working copy' });
    expect(await read('only.txt', 10_000, roots)).toMatchObject({ text: 'only in the project' });
  });
});

describe('refusing to read', () => {
  it('refuses ../outside without touching it', async () => {
    expect(await read('../outside/secret.txt')).toMatchObject({
      kind: 'refused',
      reason: 'outside',
    });
    expect(await read('review/../../outside/secret.txt')).toMatchObject({ reason: 'outside' });
  });

  it('refuses a full path outside the folders', async () => {
    const result = await read(path.join(outside, 'secret.txt'));
    expect(result).toMatchObject({ kind: 'refused', reason: 'outside' });
    expect(JSON.stringify(result)).not.toContain('invented secret');
  });

  it('refuses a folder whose name only starts like the project folder', async () => {
    await mkdir(`${project}-other`);
    await writeFile(path.join(`${project}-other`, 'a.txt'), 'invented');
    expect(await read(path.join(`${project}-other`, 'a.txt'))).toMatchObject({
      reason: 'outside',
    });
  });

  // Creating a link needs a privilege on Windows that CI runners and most users do not have.
  it.skipIf(process.platform === 'win32')(
    'refuses a symbolic link that points outside, to a file or through a folder',
    async () => {
      await symlink(path.join(outside, 'secret.txt'), path.join(project, 'link.txt'));
      await symlink(outside, path.join(project, 'linked-folder'));
      const direct = await read('link.txt');
      expect(direct).toMatchObject({ kind: 'refused', reason: 'outside' });
      expect(JSON.stringify(direct)).not.toContain('invented secret');
      expect(await read('linked-folder/secret.txt')).toMatchObject({ reason: 'outside' });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reads through a symbolic link that stays inside',
    async () => {
      await writeFile(path.join(project, 'real.txt'), 'inside');
      await symlink(path.join(project, 'real.txt'), path.join(project, 'alias.txt'));
      expect(await read('alias.txt')).toMatchObject({
        kind: 'text',
        text: 'inside',
        absolutePath: path.join(project, 'real.txt'),
      });
    },
  );

  it('refuses a missing file', async () => {
    expect(await read('review/nothing.md')).toEqual({
      kind: 'refused',
      reason: 'missing',
      message: 'There is no file review/nothing.md.',
    });
  });

  it('refuses a folder', async () => {
    expect(await read('review')).toMatchObject({ kind: 'refused', reason: 'not_a_file' });
    expect(await read('.')).toMatchObject({ kind: 'refused', reason: 'not_a_file' });
  });

  it('refuses a binary file that is not an image', async () => {
    await writeFile(path.join(project, 'data.bin'), Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0xff]));
    expect(await read('data.bin')).toMatchObject({ kind: 'refused', reason: 'binary' });
    // Text with a NUL byte in it is not text either.
    await writeFile(path.join(project, 'nul.txt'), Buffer.from('abc\0def'));
    expect(await read('nul.txt')).toMatchObject({ kind: 'refused', reason: 'binary' });
  });

  it('refuses a file over the size limit and says both sizes', async () => {
    await writeFile(path.join(project, 'big.txt'), 'x'.repeat(2501));
    expect(await read('big.txt', 2500)).toEqual({
      kind: 'refused',
      reason: 'too_large',
      message:
        'big.txt is 2.5 KB, more than the 2.5 KB the viewer reads. The "Largest file shown" setting changes that.',
    });
  });
});

describe('containment', () => {
  it('follows this platform', () => {
    expect(isInside(project, path.join(project, 'a', 'b.txt'))).toBe(true);
    expect(isInside(project, project)).toBe(true);
    expect(isInside(project, path.join(project, '..b.txt'))).toBe(true);
    expect(isInside(project, path.join(project, '..', 'outside'))).toBe(false);
    expect(candidatePaths([project], path.join('..', 'outside'))).toEqual([]);
    expect(candidatePaths([project], path.join('a', '..', 'b.txt'))).toEqual([
      path.join(project, 'b.txt'),
    ]);
  });

  // Windows rules, checked on every platform: case, both separators, drives and UNC shares.
  it('follows Windows case, separators and drives', () => {
    const win = path.win32;
    const root = 'C:\\Work\\Demo';
    expect(isInside(root, 'c:\\work\\demo\\Intents\\spec.md', win)).toBe(true);
    expect(isInside(root, 'C:\\Work\\Demo', win)).toBe(true);
    expect(isInside(root, 'C:\\Work\\Demo2\\spec.md', win)).toBe(false);
    expect(isInside(root, 'C:\\Work\\secret.txt', win)).toBe(false);
    expect(isInside(root, 'D:\\Work\\Demo\\spec.md', win)).toBe(false);
    expect(isInside(root, '\\\\server\\share\\Work\\Demo\\spec.md', win)).toBe(false);
    expect(candidatePaths([root], 'intents/x/spec.md', win)).toEqual([
      'C:\\Work\\Demo\\intents\\x\\spec.md',
    ]);
    expect(candidatePaths([root], 'intents\\..\\..\\secret.txt', win)).toEqual([]);
    expect(candidatePaths([root], '..\\Demo2\\spec.md', win)).toEqual([]);
    expect(candidatePaths([root], 'D:\\Work\\Demo\\spec.md', win)).toEqual([]);
    expect(candidatePaths([root], 'c:/work/demo/a.md', win)).toEqual(['c:\\work\\demo\\a.md']);
    // A path relative to the current folder of another drive never lands in the folder.
    expect(candidatePaths([root], 'D:spec.md', win)).toEqual([]);
  });

  // The same rules against the real file system of a Windows machine (CI runs windows-latest).
  it.runIf(process.platform === 'win32')(
    'reads a file on Windows whatever the case or separators of the request',
    async () => {
      await writeFile(path.join(project, 'review', 'Notes.md'), '# Notes\n');
      expect(await read('REVIEW/notes.md')).toMatchObject({ kind: 'markdown' });
      expect(await read('review\\Notes.md')).toMatchObject({ kind: 'markdown' });
      expect(await read(path.join(project.toUpperCase(), 'review', 'Notes.md'))).toMatchObject({
        kind: 'markdown',
      });
      expect(await read('..\\outside\\secret.txt')).toMatchObject({ reason: 'outside' });
      expect(await read(path.join(outside.toUpperCase(), 'secret.txt'))).toMatchObject({
        reason: 'outside',
      });
    },
  );
});
