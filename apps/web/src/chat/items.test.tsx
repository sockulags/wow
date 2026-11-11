import type { ThreadItem } from '@wow/contracts';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadMarkdown } from '../test/markdown';
import { ConversationItem, ToolCallGroup, type ItemContext } from './items';

beforeAll(loadMarkdown);

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

const call = (last: number, name: string, status: 'running' | 'ok' | 'error'): ThreadItem => ({
  id: id(last),
  threadId: id(2),
  turnId: id(3),
  index: last,
  kind: 'tool_call',
  payload: { name, input: { file_path: `/work/demo/${name}.ts` }, output: `out ${name}`, status },
  streaming: false,
});
const group = (items: ThreadItem[], running = false) => (
  <ol>
    <ToolCallGroup items={items} contextOf={() => ({ ...context, turnEnded: !running })} />
  </ol>
);

describe('a run of tool calls is one row', () => {
  it('shows the latest call and the count, and lists every call when opened', async () => {
    const view = render(group([call(4, 'Read', 'ok'), call(5, 'Grep', 'running')], true));
    const row = within(screen.getByTestId('item-tool_group'));
    const summary = screen.getByTestId('item-tool_group').querySelector('summary');
    expect(summary?.textContent).toContain('Grep');
    expect(summary?.textContent).toContain('/work/demo/Grep.ts');
    expect(summary?.textContent).toContain('running');
    expect(row.getByTestId('tool-group-count').textContent).toBe('2 tool calls');
    expect(row.queryByTestId('tool-group-failed')).toBeNull();
    expect(row.queryAllByTestId('item-tool_call')).toHaveLength(0);

    // The running turn adds a call: the row follows it.
    view.rerender(
      group([call(4, 'Read', 'ok'), call(5, 'Grep', 'ok'), call(6, 'Edit', 'running')], true),
    );
    expect(summary?.textContent).toContain('Edit');
    expect(row.getByTestId('tool-group-count').textContent).toBe('3 tool calls');

    const details = summary?.parentElement as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    const calls = await row.findAllByTestId('item-tool_call');
    expect(calls.map((entry) => entry.querySelector('summary')?.textContent)).toEqual([
      expect.stringContaining('Read'),
      expect.stringContaining('Grep'),
      expect.stringContaining('Edit'),
    ]);
  });

  it('says that a call failed without being opened', () => {
    render(group([call(4, 'Bash', 'error'), call(5, 'Read', 'ok')]));
    const row = screen.getByTestId('item-tool_group');
    expect(row.dataset['failed']).toBe('true');
    expect(within(row).getByTestId('tool-group-failed').textContent).toBe('1 failed');
  });
});
