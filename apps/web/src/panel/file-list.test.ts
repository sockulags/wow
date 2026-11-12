import { describe, expect, it } from 'vitest';
import { fileListNote, fileScore, filterFiles } from './file-list';

// Agent workbench spec 18: the thread folder's files, fuzzy filtered as the user types.

const files = [
  'README.md',
  'src/timer.ts',
  'src/timer.test.ts',
  'src/tea/kettle.ts',
  'docs/timing.md',
  'apps/web/src/main.tsx',
];

describe('fuzzy file filter @agent-workbench-18', () => {
  it('matches the letters in order, the file name before the folders', () => {
    expect(filterFiles(files, 'ti', 10)).toEqual([
      'src/timer.ts',
      'docs/timing.md',
      'src/timer.test.ts',
    ]);
    expect(filterFiles(files, 'tmr', 10)).toEqual(['src/timer.ts', 'src/timer.test.ts']);
    // Across folders when the name alone does not hold the letters.
    expect(filterFiles(files, 'srckettle', 10)).toEqual(['src/tea/kettle.ts']);
    expect(filterFiles(files, 'web/main', 10)).toEqual(['apps/web/src/main.tsx']);
    expect(filterFiles(files, 'zzz', 10)).toEqual([]);
  });

  it('lists every file, shortest first, before anything is typed, and stops at the shown count', () => {
    expect(filterFiles(files, '', 3)).toEqual(['README.md', 'src/timer.ts', 'docs/timing.md']);
    expect(fileScore('src/timer.ts', 'TIMER')).toBeDefined();
  });

  it('says why a list is short', () => {
    expect(fileListNote({ status: 'loading' }, 0, 50)).toBe('Listing the files…');
    expect(fileListNote({ status: 'failed', message: 'No thread t1' }, 0, 50)).toBe('No thread t1');
    const done = { status: 'done', files, truncated: false } as const;
    expect(fileListNote(done, 0, 50)).toBe('No matching files.');
    expect(fileListNote(done, 3, 50)).toBeUndefined();
    expect(fileListNote(done, 3, 3)).toBe('Showing the first 3 matches; type more to narrow them.');
    expect(fileListNote({ ...done, truncated: true }, 3, 50)).toBe(
      'The folder has more files than the "Files listed" setting lets through.',
    );
    expect(fileListNote({ ...done, files: [] }, 0, 50)).toBe('No files in this folder.');
  });
});
