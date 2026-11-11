import { describe, expect, it } from 'vitest';
import { jiraKeyIn } from './jira.js';
import { jiraToMarkdown } from './jira-wiki.js';

// A ticket description in Jira wiki markup shows readable, with markup not run (U11).

describe('jiraToMarkdown', () => {
  it('turns headings, emphasis, monospace and links into markdown', () => {
    expect(
      jiraToMarkdown(
        'h1. Kettle\nThe *whistle* is _late_ and -broken-, see {{whistle.ts}} and [the notes|https://wiki.example.invalid/notes].',
      ),
    ).toBe(
      '# Kettle\nThe **whistle** is *late* and ~~broken~~, see `whistle.ts` and [the notes](https://wiki.example.invalid/notes).',
    );
  });

  it('nests bullet and numbered lists by depth', () => {
    expect(jiraToMarkdown('* Fill\n** Cold water\n# First\n## Then\n- Dash')).toBe(
      '- Fill\n  - Cold water\n1. First\n   1. Then\n- Dash',
    );
  });

  it('keeps code blocks as written, with a fence longer than any inside', () => {
    expect(jiraToMarkdown('{code:title=a.ts|language=ts}\nconst a = "```";\n{code}')).toBe(
      '````ts\nconst a = "```";\n````',
    );
    expect(jiraToMarkdown('{noformat}*not bold*{noformat}')).toBe('```\n*not bold*\n```');
  });

  it('turns tables into GFM tables, with a header row when Jira has none', () => {
    expect(jiraToMarkdown('||Step||Result||\n|Fill|ok|\n|Boil|late|')).toBe(
      '| Step | Result |\n| --- | --- |\n| Fill | ok |\n| Boil | late |',
    );
    expect(jiraToMarkdown('Before\n|a|b|')).toBe('Before\n\n|   |   |\n| --- | --- |\n| a | b |');
  });

  it('quotes bq. lines and {quote} blocks', () => {
    expect(jiraToMarkdown('bq. Said once\n{quote}\nSaid twice\n{quote}')).toBe(
      '> Said once\n> Said twice',
    );
  });

  it('drops colours and panels and shows pictures by name without loading them', () => {
    expect(
      jiraToMarkdown('{panel:title=Note}\n{color:red}Hot{color} !steam.png|thumbnail!\n{panel}'),
    ).toBe('Hot [picture: steam.png]');
  });

  it('keeps only web and mail links as links', () => {
    expect(
      jiraToMarkdown('[run|javascript:alert(1)] [mail|mailto:a@example.invalid] [~mira]'),
    ).toBe('run [mail](mailto:a@example.invalid) @mira');
    expect(jiraToMarkdown('[https://jira.example.invalid/x]')).toBe(
      '<https://jira.example.invalid/x>',
    );
  });

  it('leaves HTML as text for the renderer, which never runs it', () => {
    expect(jiraToMarkdown('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  });

  it('reads long runs of [ and {{ in steps that grow with the length, not its square', () => {
    const size = 200_000;
    for (const wiki of [
      '['.repeat(size),
      '{{'.repeat(size / 2),
      `${'[a'.repeat(size / 2)}]`,
      `${'{{a'.repeat(size / 3)}}}`,
    ]) {
      const meter = { steps: 0 };
      const markdown = jiraToMarkdown(wiki, meter);
      expect(markdown.length).toBeGreaterThan(0);
      expect(meter.steps).toBeLessThanOrEqual(4 * wiki.length);
    }
    // Long runs of colour and citation openers, which never close.
    expect(jiraToMarkdown('{color:'.repeat(30_000)).length).toBeGreaterThan(0);
    expect(jiraToMarkdown('??a '.repeat(50_000)).length).toBeGreaterThan(0);
  });

  it('turns a link with an empty label into one link, and a nested bracket into text', () => {
    expect(jiraToMarkdown('[|https://jira.example.invalid/x]')).toBe(
      '[https://jira.example.invalid/x](https://jira.example.invalid/x)',
    );
    expect(jiraToMarkdown('[see [notes|https://wiki.example.invalid/n]]')).toBe(
      '[see [notes](https://wiki.example.invalid/n)]',
    );
  });

  it('answers an empty description with an empty text', () => {
    expect(jiraToMarkdown('')).toBe('');
  });
});

describe('jiraKeyIn', () => {
  it('finds the project key in a title or branch, in any case', () => {
    expect(jiraKeyIn('ABC-12 Fix it', 'ABC')).toBe('ABC-12');
    expect(jiraKeyIn('abc-12-fix', 'ABC')).toBe('ABC-12');
    expect(jiraKeyIn('feature/abc-7_whistle', 'abc')).toBe('ABC-7');
  });

  it('ignores other projects, longer words, longer numbers and keys that are not keys', () => {
    expect(jiraKeyIn('DEF-4 Fix it', 'ABC')).toBeUndefined();
    expect(jiraKeyIn('xabc-12', 'ABC')).toBeUndefined();
    expect(jiraKeyIn('ABC-0', 'ABC')).toBeUndefined();
    expect(jiraKeyIn('ABC-12', 'A.C')).toBeUndefined();
    expect(jiraKeyIn('ABC-12', '')).toBeUndefined();
  });
});
