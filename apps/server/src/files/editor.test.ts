import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandWords, editorArgs, findEditorPath, planEditor, startEditor } from './editor.js';

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'wow-editor-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const target = { path: '/work/tea timer/src/bell.ts', line: 12 };

describe('the editor command', () => {
  it('splits the setting into words, keeping quoted words and backslashes', () => {
    expect(commandWords('code --goto {path}:{line}')).toEqual(['code', '--goto', '{path}:{line}']);
    expect(commandWords('"C:\\Program Files\\Ed\\ed.exe"  -n  \'\'')).toEqual([
      'C:\\Program Files\\Ed\\ed.exe',
      '-n',
      '',
    ]);
  });

  it('fills in the path and line, and puts the path last when the command names none', () => {
    expect(editorArgs('code --goto {path}:{line}', target)).toEqual({
      file: 'code',
      args: ['--goto', '/work/tea timer/src/bell.ts:12'],
    });
    expect(editorArgs('subl', target)).toEqual({
      file: 'subl',
      args: ['/work/tea timer/src/bell.ts'],
    });
  });

  it('starts a program without a shell unless the setting says so @agent-workbench-81', async () => {
    const plain = await planEditor({
      command: 'code --goto {path}:{line}',
      shell: false,
      target,
      platform: 'linux',
      env: {},
    });
    expect(plain).toEqual({
      file: 'code',
      args: ['--goto', '/work/tea timer/src/bell.ts:12'],
      shell: false,
    });
    const shell = await planEditor({
      command: 'code --goto {path}:{line} || true',
      shell: true,
      target,
      platform: 'linux',
      env: {},
    });
    expect(shell).toMatchObject({
      shell: true,
      line: "code --goto '/work/tea timer/src/bell.ts':12 || true",
    });
  });

  it('runs a Windows .cmd such as code the Windows way, through cmd.exe', async () => {
    const bin = path.join(folder, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'code.cmd'), '@echo off\r\n');
    const launch = await planEditor({
      command: 'code --goto {path}:{line}',
      shell: false,
      target: { path: 'C:\\work\\tea timer\\bell.ts', line: 3 },
      platform: 'win32',
      env: { PATH: bin, PATHEXT: '.EXE;.CMD' },
    });
    const file = path.join(bin, 'code.cmd');
    expect(launch).toEqual({
      file,
      args: ['--goto', 'C:\\work\\tea timer\\bell.ts:3'],
      shell: true,
      line: `${file.includes(' ') ? `"${file}"` : file} --goto "C:\\work\\tea timer\\bell.ts:3"`,
    });
  });

  it('starts the program and lets it run on its own', async () => {
    const out = path.join(folder, 'args.json');
    const script = path.join(folder, 'editor.mjs');
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    const { exited } = await startEditor({
      file: process.execPath,
      args: [script, '/work/tea timer/bell.ts', '12'],
      shell: false,
    });
    expect(await exited).toBe(0);
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(['/work/tea timer/bell.ts', '12']);
    await expect(
      startEditor({ file: path.join(folder, 'no-such-editor'), args: [], shell: false }),
    ).rejects.toThrow(/ENOENT/);
  });

  it('opens only what is inside the folders and there', async () => {
    await mkdir(path.join(folder, 'app', 'src'), { recursive: true });
    await writeFile(path.join(folder, 'app', 'src', 'bell.ts'), 'export {};\n');
    const roots = [path.join(folder, 'app')];
    expect(await findEditorPath(roots, 'src/bell.ts', "the thread's folder")).toEqual({
      found: path.join(folder, 'app', 'src', 'bell.ts'),
    });
    expect(await findEditorPath(roots, '.', "the thread's folder")).toEqual({
      found: path.join(folder, 'app'),
    });
    expect(await findEditorPath(roots, '../x.ts', "the thread's folder")).toMatchObject({
      refused: 'outside',
    });
    expect(await findEditorPath(roots, 'src/gone.ts', "the thread's folder")).toMatchObject({
      refused: 'missing',
    });
  });
});
