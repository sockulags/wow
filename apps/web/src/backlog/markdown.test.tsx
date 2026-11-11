import { render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadMarkdown } from '../test/markdown';
import { MarkdownPreview } from './markdown';

beforeAll(loadMarkdown);

describe('backlog body (review loop spec 5)', () => {
  it('renders a backlog item body through the shared renderer', async () => {
    render(
      <MarkdownPreview
        markdown={
          '## Why\n\nNeeds **keys** and a [link](https://x.test) [bad](javascript:alert(1)).\n\n| Step | Owner |\n| --- | --- |\n| Login | Kim |'
        }
      />,
    );
    const preview = within(screen.getByTestId('markdown-preview'));
    // The shared component marks its root; the table shows the GFM renderer is the one in use.
    expect(preview.getByTestId('markdown')).toBeTruthy();
    expect(await preview.findByRole('heading', { name: 'Why' })).toBeTruthy();
    expect(preview.getByText('keys').tagName).toBe('STRONG');
    expect(preview.getByRole('table')).toBeTruthy();
    expect(preview.getByRole('link', { name: 'link' }).getAttribute('href')).toBe('https://x.test');
    expect(preview.queryByRole('link', { name: 'bad' })).toBeNull();
  });

  it('says when nothing is written', () => {
    render(<MarkdownPreview markdown="  " />);
    expect(screen.getByText('Nothing written yet.')).toBeTruthy();
  });
});
