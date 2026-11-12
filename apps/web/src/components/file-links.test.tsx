import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadMarkdown } from '../test/markdown';
import { FileLinkContext, filePathOf, isFilePath } from './file-links';
import { Markdown } from './markdown';

beforeAll(loadMarkdown);

// Agent workbench spec 15: paths in chat messages are file links.

describe('isFilePath', () => {
  it.each([
    'src/timer.ts',
    'README.md',
    'docs/',
    '../outside.txt',
    './a.json',
    '/home/me/demo/src/timer.ts',
    'C:\\work\\demo\\a.ts',
    'apps/web/src/panel',
    'docs/été/notes.md',
    'Résumé.md',
    'src/$id.tsx',
  ])('reads %s as a path', (text) => {
    expect(isFilePath(text)).toBe(true);
  });

  it.each([
    ['src/timer.ts:42', 'src/timer.ts'],
    ['src/timer.ts:42:7', 'src/timer.ts'],
    ['docs/spec.md#rules', 'docs/spec.md'],
    ['C:\\work\\a.ts:3', 'C:\\work\\a.ts'],
    ['README.md', 'README.md'],
    ['README.md:3', 'README.md'],
    ['main.rs:12:4', 'main.rs'],
  ])('opens %s as the bare path %s', (text, path) => {
    expect(filePathOf(text)).toBe(path);
  });

  it.each([
    'pnpm test',
    'https://example.test/a.md',
    'mailto:me@example.invalid',
    'javascript:alert(1)',
    '1.5',
    '1.5:3',
    '#rules',
    'localhost:3000',
    'example.com:8080',
    'api.internal:443',
    'user@host.com:22',
    '--force',
    'ringTwice',
    'a b.ts',
    ' src/a.ts',
    '..',
    '/',
    '',
  ])('does not read %j as a path', (text) => {
    expect(isFilePath(text)).toBe(false);
  });
});

describe('file links in markdown @agent-workbench-15', () => {
  const text =
    'The timer is in `src/timer.ts`, as the [spec](docs/spec.md) says. Outside: `../outside.txt` and [up](../outside.txt). Run `pnpm test`; see [the site](https://example.test). It rings at `src/timer.ts:42`, by [the rules](docs/spec.md#rules).';

  it('makes inline code paths and relative links open the file', async () => {
    const user = userEvent.setup();
    const open = vi.fn<(path: string) => void>();
    render(
      <FileLinkContext value={{ open }}>
        <Markdown text={text} />
      </FileLinkContext>,
    );
    const links = await screen.findAllByTestId('file-link');
    expect(links.map((link) => link.textContent)).toEqual([
      'src/timer.ts',
      'spec',
      '../outside.txt',
      'up',
      'src/timer.ts:42',
      'the rules',
    ]);
    await user.click(links[0] as HTMLElement);
    // Enter opens it too, as a button does.
    (links[1] as HTMLElement).focus();
    await user.keyboard('{Enter}');
    await user.click(links[2] as HTMLElement);
    await user.click(links[4] as HTMLElement);
    await user.click(links[5] as HTMLElement);
    expect(open.mock.calls).toEqual([
      ['src/timer.ts'],
      ['docs/spec.md'],
      ['../outside.txt'],
      ['src/timer.ts'],
      ['docs/spec.md'],
    ]);
    expect(screen.getByText('pnpm test', { selector: 'code' }).closest('button')).toBeNull();
    expect(screen.getByRole('link', { name: 'the site' }).getAttribute('href')).toBe(
      'https://example.test',
    );
  });

  it('gives a code block whose label is a path Open file @agent-workbench-32', async () => {
    const user = userEvent.setup();
    const open = vi.fn<(path: string) => void>();
    const blocks = [
      '```ts src/timer.ts',
      'export const minutes = 5;',
      '```',
      '',
      '```ts:src/bell.ts',
      'ring();',
      '```',
      '',
      '```js title="scripts/build.mjs"',
      'build();',
      '```',
      '',
      '```bash',
      'pnpm test',
      '```',
    ].join('\n');
    render(
      <FileLinkContext value={{ open }}>
        <Markdown text={blocks} />
      </FileLinkContext>,
    );
    const buttons = await screen.findAllByRole('button', { name: /^Open file/ });
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Open file src/timer.ts',
      'Open file src/bell.ts',
      'Open file scripts/build.mjs',
    ]);
    for (const button of buttons) await user.click(button);
    expect(open.mock.calls).toEqual([['src/timer.ts'], ['src/bell.ts'], ['scripts/build.mjs']]);
    expect(screen.getAllByRole('button', { name: 'Copy code' })).toHaveLength(4);
  });

  it('offers no Open file on a labelled code block where no thread opens files', async () => {
    render(<Markdown text={'```ts src/timer.ts\nexport const minutes = 5;\n```'} />);
    expect(await screen.findByRole('button', { name: 'Copy code' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Open file/ })).toBeNull();
  });

  it('keeps paths as text where no thread opens files (the Assistant view)', async () => {
    render(<Markdown text={text} />);
    expect(await screen.findByText('src/timer.ts', { selector: 'code' })).toBeTruthy();
    expect(screen.queryAllByTestId('file-link')).toEqual([]);
    expect(screen.queryByRole('link', { name: 'spec' })).toBeNull();
    expect(screen.getByText('spec').tagName).toBe('SPAN');
  });
});
