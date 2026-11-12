import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadMarkdown } from '../test/markdown';
import { FileLinkContext, isFilePath } from './file-links';
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
  ])('reads %s as a path', (text) => {
    expect(isFilePath(text)).toBe(true);
  });

  it.each([
    'pnpm test',
    'https://example.test/a.md',
    'mailto:me@example.invalid',
    'javascript:alert(1)',
    '1.5',
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
    'The timer is in `src/timer.ts`, as the [spec](docs/spec.md) says. Outside: `../outside.txt` and [up](../outside.txt). Run `pnpm test`; see [the site](https://example.test).';

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
    ]);
    await user.click(links[0] as HTMLElement);
    // Enter opens it too, as a button does.
    (links[1] as HTMLElement).focus();
    await user.keyboard('{Enter}');
    await user.click(links[2] as HTMLElement);
    expect(open.mock.calls).toEqual([['src/timer.ts'], ['docs/spec.md'], ['../outside.txt']]);
    expect(screen.getByText('pnpm test', { selector: 'code' }).closest('button')).toBeNull();
    expect(screen.getByRole('link', { name: 'the site' }).getAttribute('href')).toBe(
      'https://example.test',
    );
  });

  it('keeps paths as text where no thread opens files (the Assistant view)', async () => {
    render(<Markdown text={text} />);
    expect(await screen.findByText('src/timer.ts', { selector: 'code' })).toBeTruthy();
    expect(screen.queryAllByTestId('file-link')).toEqual([]);
    expect(screen.queryByRole('link', { name: 'spec' })).toBeNull();
    expect(screen.getByText('spec').tagName).toBe('SPAN');
  });
});
