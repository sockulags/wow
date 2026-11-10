import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown, safeHref, splitUnfinished } from './markdown';

const message = [
  '# Result',
  '',
  'Changed `login.ts` and **two** tests.',
  '',
  '- one',
  '  - nested',
  '- two',
  '',
  '| File | Lines |',
  '| --- | ---: |',
  '| login.ts | 12 |',
  '',
  'See [the docs](https://docs.example.test/login).',
  '',
  '```ts',
  'const answer = 42;',
  '```',
].join('\n');

describe('markdown renderer (review loop spec 1 to 4)', () => {
  it('renders a heading, a nested list, a table, a link and fenced code, with code highlighted', async () => {
    const { container } = render(<Markdown text={message} />);
    expect((await screen.findByRole('heading', { name: 'Result' })).tagName).toBe('H3');
    expect(screen.getByText('login.ts', { selector: 'code' })).toBeTruthy();
    expect(screen.getByText('two', { selector: 'strong' })).toBeTruthy();

    const [outer, inner] = screen.getAllByRole('list');
    expect(outer && within(outer).getAllByRole('listitem')).toHaveLength(3);
    expect(inner && within(inner).getByRole('listitem').textContent).toBe('nested');
    expect(outer && inner && outer.contains(inner)).toBe(true);

    const table = within(screen.getByRole('table'));
    expect(table.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'File',
      'Lines',
    ]);
    expect(table.getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['login.ts', '12']);

    // Shiki wraps each token; the keyword is its own span once highlighting is done.
    expect(await screen.findByText('const', { selector: '.wow-code .shiki span' })).toBeTruthy();
    expect(container.querySelector('.wow-code')?.textContent).toBe('const answer = 42;');
  });

  it('opens an https link outside the app and shows javascript: and file: links as text', async () => {
    render(
      <Markdown
        text={
          '[docs](https://docs.example.test) [run](javascript:alert(1)) [disk](file:///c:/secret.txt) [mail](mailto:someone@example.test)'
        }
      />,
    );
    const link = await screen.findByRole('link', { name: 'docs' });
    expect(link.getAttribute('href')).toBe('https://docs.example.test');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    expect(screen.getByRole('link', { name: 'mail' })).toBeTruthy();
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(screen.getByText('run').tagName).toBe('SPAN');
    expect(screen.getByText('disk').tagName).toBe('SPAN');
  });

  it('allows only http, https and mailto addresses', () => {
    expect(safeHref('HTTPS://x.test')).toBe('HTTPS://x.test');
    expect(safeHref('http://x.test')).toBe('http://x.test');
    expect(safeHref('mailto:a@x.test')).toBe('mailto:a@x.test');
    for (const href of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', '/chat'])
      expect(safeHref(href)).toBeUndefined();
    expect(safeHref(undefined)).toBeUndefined();
  });

  it('shows raw HTML as text and never as elements', async () => {
    const { container } = render(
      <Markdown
        text={
          'Before <b onclick="alert(1)">bold</b> after\n\n<script>window.hacked = true</script>\n\n<img src="https://x.test/p.png" onerror="alert(1)">'
        }
      />,
    );
    expect(await screen.findByText(/Before <b onclick="alert\(1\)">bold<\/b> after/)).toBeTruthy();
    const shown = screen.getByTestId('markdown').textContent;
    expect(shown).toContain('<script>window.hacked = true</script>');
    expect(shown).toContain('<img src="https://x.test/p.png" onerror="alert(1)">');
    expect(container.querySelector('b, script, img, [onclick], [onerror]')).toBeNull();
    expect('hacked' in window).toBe(false);
  });

  it('shows a picture as its link, so nothing is fetched', async () => {
    const { container } = render(<Markdown text="![Chart](https://x.test/chart.png)" />);
    expect((await screen.findByRole('link', { name: 'Chart' })).getAttribute('href')).toBe(
      'https://x.test/chart.png',
    );
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('a streaming message (review loop spec 3)', () => {
  const table = 'Files:\n\n| File | Lines |\n| --- | --- |\n| login.ts | 12 |';

  it('shows an unfinished table as plain text until it is complete', async () => {
    const { rerender } = render(<Markdown text={table} streaming />);
    expect(await screen.findByText('Files:')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByTestId('markdown-pending').textContent).toBe(
      '| File | Lines |\n| --- | --- |\n| login.ts | 12 |',
    );

    rerender(<Markdown text={`${table}\n\nDone.`} streaming />);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.queryByTestId('markdown-pending')).toBeNull();
  });

  it('shows the table once the turn has ended', async () => {
    render(<Markdown text={table} />);
    expect(await screen.findByRole('table')).toBeTruthy();
  });

  it('shows an unfinished diagram fence as plain text until it closes', async () => {
    const open = 'Flow:\n\n```mermaid\nflowchart LR\n  a --> b';
    const { container } = render(<Markdown text={open} streaming />);
    expect(await screen.findByText('Flow:')).toBeTruthy();
    expect(screen.getByTestId('markdown-pending').textContent).toBe(
      '```mermaid\nflowchart LR\n  a --> b',
    );
    expect(container.querySelector('.wow-code, figure')).toBeNull();
  });

  it('splits the text at the unfinished part', () => {
    expect(splitUnfinished('One\n\n```ts\nconst a = 1;\n```\n\nTwo')).toEqual({
      done: 'One\n\n```ts\nconst a = 1;\n```\n\nTwo',
      pending: '',
    });
    expect(splitUnfinished('One\n\n```ts\nconst a = 1;')).toEqual({
      done: 'One\n',
      pending: '```ts\nconst a = 1;',
    });
    // A longer fence is not closed by a shorter one, and a tilde fence not by backticks.
    expect(splitUnfinished('````md\n```\n').pending).toBe('````md\n```\n');
    expect(splitUnfinished('~~~\n```\n').pending).toBe('~~~\n```\n');
    // A table inside a closed fence is code, and a pipe in prose is not a table.
    expect(splitUnfinished('```\n| a |\n| - |\n```').pending).toBe('');
    expect(splitUnfinished('a | b').pending).toBe('');
    // The header row alone is still a paragraph; the delimiter row makes it a table.
    expect(splitUnfinished('| a | b |\n| -').pending).toBe('| a | b |\n| -');
    expect(splitUnfinished('Intro\n| a | b |\n|---|---|').pending).toBe('| a | b |\n|---|---|');
    // Inside a nested list item, under a wide list marker, right after a marker, or in a quote.
    expect(splitUnfinished('- a\n  - b\n\n    ```mermaid\n    flowchart LR\n      a -->')).toEqual({
      done: '- a\n  - b\n',
      pending: '    ```mermaid\n    flowchart LR\n      a -->',
    });
    expect(splitUnfinished('10. a\n\n    ```ts\n    const a = 1;').pending).toBe(
      '    ```ts\n    const a = 1;',
    );
    expect(splitUnfinished('- ```mermaid\n  flowchart LR').pending).toBe(
      '- ```mermaid\n  flowchart LR',
    );
    expect(splitUnfinished('> Note\n>\n> ```mermaid\n> flowchart LR\n>   a -->')).toEqual({
      done: '> Note\n>',
      pending: '> ```mermaid\n> flowchart LR\n>   a -->',
    });
    expect(splitUnfinished('> | a | b |\n> | - | - |').pending).toBe('> | a | b |\n> | - | - |');
    // Closed in place, they are done.
    expect(splitUnfinished('- a\n\n    ```ts\n    x\n    ```\n- b').pending).toBe('');
    expect(splitUnfinished('> ```ts\n> x\n> ```\n> end').pending).toBe('');
  });
});
