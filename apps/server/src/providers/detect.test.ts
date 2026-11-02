import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectProviders } from './detect.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-detect-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(relative: string, mode = 0o755): Promise<string> {
  const full = path.join(dir, relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, '');
  await chmod(full, mode);
  return full;
}

describe('detectProviders', () => {
  // Windows has no executable bit, so the non-executable file only exists elsewhere.
  it.skipIf(process.platform === 'win32')(
    'finds the first executable on PATH and the default config directories',
    async () => {
      await file('first/claude', 0o644);
      const claude = await file('second/claude');
      await mkdir(path.join(dir, 'second', 'codex'));
      const result = await detectProviders({
        platform: 'linux',
        env: {
          PATH: [path.join(dir, 'missing'), path.join(dir, 'first'), path.join(dir, 'second')].join(
            ':',
          ),
          HOME: '/home/me',
        },
      });
      expect(result).toEqual([
        { kind: 'claude', binaryPath: claude, configDir: path.join('/home/me', '.claude') },
        { kind: 'codex', binaryPath: null, configDir: path.join('/home/me', '.codex') },
      ]);
    },
  );

  it('uses PATHEXT on Windows and the config directory variables', async () => {
    const codex = await file('bin/codex.cmd', 0o644);
    const result = await detectProviders({
      platform: 'win32',
      env: {
        Path: path.join(dir, 'bin'),
        PATHEXT: '.EXE;.CMD',
        USERPROFILE: 'C:\\Users\\me',
        CLAUDE_CONFIG_DIR: 'D:\\claude-work',
        CODEX_HOME: 'D:\\codex',
      },
    });
    expect(result).toEqual([
      { kind: 'claude', binaryPath: null, configDir: 'D:\\claude-work' },
      { kind: 'codex', binaryPath: codex, configDir: 'D:\\codex' },
    ]);
  });
});
