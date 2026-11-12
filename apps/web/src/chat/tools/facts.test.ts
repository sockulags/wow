import { describe, expect, it } from 'vitest';
import { otherFolder, shownPath, type ToolPayload } from './facts';

// Windows-shaped paths, as Claude Code and Codex report them on the target platform. The
// folders are invented.

const command = (cwd: string): ToolPayload => ({
  name: 'Bash',
  input: {},
  output: '',
  status: 'ok',
  kind: 'command',
  command: 'dir',
  cwd,
});

describe('paths against the thread folder', () => {
  it('shows a path inside the folder relative to it, whatever the separator or drive case', () => {
    expect(shownPath('C:\\Users\\me\\repo\\README.md', 'C:\\Users\\me\\repo')).toBe('README.md');
    expect(shownPath('C:/Users/me/repo/README.md', 'C:\\Users\\me\\repo')).toBe('README.md');
    expect(shownPath('c:\\Users\\me\\repo\\src\\a.ts', 'C:\\Users\\me\\repo\\')).toBe('src\\a.ts');
    expect(shownPath('/work/repo/a.ts', '/work/repo')).toBe('a.ts');
  });

  it('keeps a path outside the folder whole', () => {
    expect(shownPath('C:\\Users\\me\\repo2\\a.ts', 'C:\\Users\\me\\repo')).toBe(
      'C:\\Users\\me\\repo2\\a.ts',
    );
    expect(shownPath('D:\\repo\\a.ts', 'C:\\repo')).toBe('D:\\repo\\a.ts');
    expect(shownPath('/Work/repo/a.ts', '/work/repo')).toBe('/Work/repo/a.ts');
  });

  it('names a command folder only when it differs from the thread folder', () => {
    expect(otherFolder(command('c:\\Users\\me\\repo'), 'C:\\Users\\me\\repo')).toBeUndefined();
    expect(otherFolder(command('C:/Users/me/repo/'), 'C:\\Users\\me\\repo')).toBeUndefined();
    expect(otherFolder(command('C:\\Users\\me\\other'), 'C:\\Users\\me\\repo')).toBe(
      'C:\\Users\\me\\other',
    );
  });

  it('reads a verbatim path as the same place as its plain form', () => {
    expect(otherFolder(command('\\\\?\\C:\\work\\demo'), 'C:\\work\\demo')).toBeUndefined();
    expect(otherFolder(command('C:\\work\\demo'), '\\\\?\\c:\\work\\demo\\')).toBeUndefined();
    expect(
      otherFolder(command('\\\\?\\UNC\\host\\share\\demo'), '\\\\host\\share\\demo'),
    ).toBeUndefined();
    expect(otherFolder(command('\\\\?\\C:\\work\\other'), 'C:\\work\\demo')).toBe(
      '\\\\?\\C:\\work\\other',
    );
    expect(shownPath('\\\\?\\C:\\work\\demo\\src\\a.ts', 'C:\\work\\demo')).toBe('src\\a.ts');
    expect(shownPath('C:\\work\\demo\\README.md', '\\\\?\\C:\\work\\demo')).toBe('README.md');
    expect(shownPath('\\\\?\\UNC\\host\\share\\demo\\a.ts', '\\\\host\\share\\demo')).toBe('a.ts');
  });
});
