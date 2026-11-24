import type { RunDiffFile } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { emptyReason, lineChanges, parsePatch } from './changes';

// The words and diff rows a thread's Changes shares (review loop spec 11 to 13). All invented.

const file = (path: string, overrides: Partial<RunDiffFile> = {}): RunDiffFile => ({
  path,
  oldPath: null,
  status: 'modified',
  content: 'text',
  added: 2,
  removed: 1,
  size: 300,
  changedBy: [],
  ...overrides,
});

describe('Changes model', () => {
  it('reads a unified diff into numbered rows', () => {
    expect(parsePatch('')).toEqual([]);
    expect(
      parsePatch(
        '@@ -7 +7,2 @@ function ring()\n-old\n+new\n+more\n\\ No newline at end of file\n',
      ),
    ).toEqual([
      { kind: 'hunk', text: '@@ -7 +7,2 @@ function ring()' },
      { kind: 'remove', text: 'old', oldNumber: 7 },
      { kind: 'add', text: 'new', newNumber: 7 },
      { kind: 'add', text: 'more', newNumber: 8 },
      { kind: 'note', text: 'No newline at end of file' },
    ]);
  });

  it('words what stands in for lines and why nothing is compared', () => {
    expect(lineChanges(file('a', { content: 'binary', size: null }))).toBe('Binary file');
    expect(emptyReason('failed', 'fatal: bad object').description).toBe('fatal: bad object');
    expect(emptyReason('baseMissing', null).title).toBe('The starting commit is gone');
    expect(emptyReason('folderMissing', null).title).toBe('Folder missing');
  });
});
