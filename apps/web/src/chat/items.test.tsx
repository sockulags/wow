import type { ThreadItem } from '@wow/contracts';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConversationItem, type ItemContext } from './items';

const context: ItemContext = {
  cwd: '/work/demo',
  permissionLabel: 'Ask',
  turnEnded: true,
  at: undefined,
  awaitingApproval: false,
  formatAt: (iso) => iso,
};

const id = (last: number) => `00000000-0000-4000-8000-00000000000${last}`;

function assistant(text: string, streaming: boolean): ThreadItem {
  return {
    id: id(1),
    threadId: id(2),
    turnId: id(3),
    index: 0,
    kind: 'assistant_text',
    payload: { text },
    streaming,
  };
}

const show = (item: ThreadItem) =>
  render(
    <ul>
      <ConversationItem item={item} approvals={[]} questions={[]} context={context} />
    </ul>,
  );

describe('assistant message in the thread (review loop spec 1, 3)', () => {
  it('renders an assistant message as markdown', async () => {
    show(
      assistant(
        '## Done\n\n| Check | Result |\n| --- | --- |\n| tests | passed |\n\n```bash\npnpm test\n```',
        false,
      ),
    );
    const row = within(screen.getByTestId('item-assistant_text'));
    expect(await row.findByRole('heading', { name: 'Done' })).toBeTruthy();
    expect(row.getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['tests', 'passed']);
    expect(row.getByTestId('markdown').querySelector('.wow-code')?.textContent).toBe('pnpm test');
  });

  it('keeps an unfinished table of a streaming message as plain text', async () => {
    show(assistant('Checks so far:\n\n| Check | Result |\n| --- | --- |\n| tests |', true));
    const row = within(screen.getByTestId('item-assistant_text'));
    expect(await row.findByText('Checks so far:')).toBeTruthy();
    expect(row.queryByRole('table')).toBeNull();
    expect(row.getByTestId('markdown-pending').textContent).toBe(
      '| Check | Result |\n| --- | --- |\n| tests |',
    );
  });
});
