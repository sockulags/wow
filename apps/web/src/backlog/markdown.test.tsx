import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownPreview, parseMarkdown } from './markdown';

describe('markdown preview (D-12)', () => {
  it('splits a body into blocks', () => {
    expect(
      parseMarkdown('## Why\n\nNeeds **keys**.\n\n- one\n  - nested\n- two\n\n```\ncode\n```'),
    ).toEqual([
      { type: 'heading', level: 2, text: 'Why' },
      { type: 'paragraph', text: 'Needs **keys**.' },
      {
        type: 'list',
        ordered: false,
        items: [
          { text: 'one', depth: 0 },
          { text: 'nested', depth: 1 },
          { text: 'two', depth: 0 },
        ],
      },
      { type: 'code', language: '', text: 'code' },
    ]);
  });

  it('renders emphasis and links as elements, and refuses script links', () => {
    render(
      <MarkdownPreview
        markdown={'A **bold** and *soft* [link](https://x.test) [bad](javascript:alert(1)) `c`'}
      />,
    );
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('soft').tagName).toBe('EM');
    expect(screen.getByRole('link', { name: 'link' }).getAttribute('href')).toBe('https://x.test');
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    expect(screen.getByText('c').tagName).toBe('CODE');
  });

  it('says when nothing is written', () => {
    render(<MarkdownPreview markdown="  " />);
    expect(screen.getByText('Nothing written yet.')).toBeTruthy();
  });
});
