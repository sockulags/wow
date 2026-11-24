import { describe, expect, it } from 'vitest';
import { unpushedSummary } from './working-copy';

// The words for what a working copy holds that is not pushed. All invented.

describe('working copy words', () => {
  it('says what is unpushed in one line', () => {
    expect(
      unpushedSummary({
        uncommittedFiles: 1,
        unpushedCommits: 0,
        newestSubject: null,
        branch: null,
      }),
    ).toBe('1 file not committed (on no branch)');
    expect(
      unpushedSummary({
        uncommittedFiles: 0,
        unpushedCommits: 3,
        newestSubject: 'x',
        branch: 'agent/u1',
      }),
    ).toBe('3 commits not pushed (on agent/u1)');
    expect(
      unpushedSummary({
        uncommittedFiles: 0,
        ignoredFiles: 2,
        unpushedCommits: 0,
        newestSubject: null,
        branch: null,
      }),
    ).toBe('2 ignored files (on no branch)');
  });
});
