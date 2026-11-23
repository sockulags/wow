import { describe, expect, it } from 'vitest';
import { textFileBlock } from './text-files';

// A text file in a message (chat overview spec 35). All invented.

const file = (text: string, name: string, type = 'text/plain') => new File([text], name, { type });

describe('a text file in a message (spec 35)', () => {
  it('goes in as a block named by the file, fenced past any backticks inside', async () => {
    expect(await textFileBlock(file('ok\n1 failed\n', 'build.log'), 1000)).toBe(
      '```build.log\nok\n1 failed\n```',
    );
    expect(await textFileBlock(file('use ```ts here', 'notes.md'), 1000)).toBe(
      '````notes.md\nuse ```ts here\n````',
    );
  });

  it('refuses a PDF, a file over the limit and one that is not text', async () => {
    expect(await textFileBlock(file('%PDF', 'spec.pdf', 'application/pdf'), 1000)).toMatchObject({
      refused: expect.stringContaining('is a PDF'),
    });
    expect(await textFileBlock(file('x'.repeat(2000), 'big.log'), 1000)).toMatchObject({
      refused: expect.stringContaining('can be up to 1,000'),
    });
    expect(await textFileBlock(file('a\0b', 'tool.bin', ''), 1000)).toMatchObject({
      refused: expect.stringContaining('not a text file'),
    });
  });
});
