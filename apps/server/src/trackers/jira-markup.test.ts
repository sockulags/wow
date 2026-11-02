import { describe, expect, it } from 'vitest';
import { inlineToJira, jiraLabel, markdownToJira } from './jira-markup.js';

describe('markdown to Jira wiki markup', () => {
  it('converts emphasis, code and links inline', () => {
    expect(inlineToJira('**bold**, *italic*, __also bold__, ~~gone~~')).toBe(
      '*bold*, _italic_, *also bold*, -gone-',
    );
    expect(inlineToJira('Run `pnpm **test**` now')).toBe('Run {{pnpm **test**}} now');
    expect(inlineToJira('See [the spec](https://example.test/spec) and <https://x.test>')).toBe(
      'See [the spec|https://example.test/spec] and [https://x.test]',
    );
    expect(inlineToJira('![shot](https://example.test/a.png)')).toBe(
      '!https://example.test/a.png!',
    );
    expect(inlineToJira('a * b * c and 2*3')).toBe('a * b * c and 2*3');
  });

  it('converts headings, lists, quotes, rules and code blocks', () => {
    const markdown = [
      '## Why',
      '',
      'The search panel needs **keyboard** access.',
      '',
      '- Ctrl+F opens it',
      '  - from anywhere',
      '- Esc closes it',
      '',
      '1. first',
      '2. second',
      '',
      '> quoted *line*',
      '',
      '---',
      '```ts',
      'const a = **b**;',
      '```',
    ].join('\n');
    expect(markdownToJira(markdown)).toBe(
      [
        'h2. Why',
        '',
        'The search panel needs *keyboard* access.',
        '',
        '* Ctrl+F opens it',
        '** from anywhere',
        '* Esc closes it',
        '',
        '# first',
        '# second',
        '',
        'bq. quoted _line_',
        '',
        '----',
        '{code:ts}',
        'const a = **b**;',
        '{code}',
      ].join('\n'),
    );
  });

  it('converts tables with a header row', () => {
    expect(markdownToJira('| Key | Action |\n|---|---|\n| Esc | `close` |')).toBe(
      '||Key||Action||\n|Esc|{{close}}|',
    );
  });

  it('leaves plain text alone', () => {
    expect(markdownToJira('Just a line.\nAnother one.')).toBe('Just a line.\nAnother one.');
  });

  it('makes tags into single-word labels', () => {
    expect(jiraLabel('  needs  review ')).toBe('needs-review');
  });
});
