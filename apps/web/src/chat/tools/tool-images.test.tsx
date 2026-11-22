import type { ThreadItem } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore } from 'zustand';
import { describe, expect, it } from 'vitest';
import { createLayoutStore, RuntimeProvider } from '@/app/runtime';
import { createDraftStore } from '../draft';
import { ConversationItem, type ItemContext } from '../items';
import { picturesText, type ToolPayload } from './facts';

// Pictures in tool rows (chat overview spec 33, 34). All invented.

const payload: ToolPayload = {
  name: 'browser_screenshot',
  input: {},
  output: 'Took 3 screenshots',
  status: 'ok',
  kind: 'mcp',
  server: 'browser',
  tool: 'screenshot',
  images: [
    { id: 'a.png', mediaType: 'image/png' },
    { id: 'b.png', mediaType: 'image/png' },
    { id: 'c.png', mediaType: 'image/png' },
  ],
  imagesOmitted: { count: 1, reason: 'too large' },
};

const item: ThreadItem = {
  id: 'bell:turn:0:tool',
  threadId: 'bell',
  turnId: 'bell:turn:0',
  index: 1,
  kind: 'tool_call',
  payload,
  streaming: false,
};

const context: ItemContext = {
  itemId: item.id,
  cwd: '/work/tea',
  permissionLabel: 'Ask',
  turnEnded: true,
  at: undefined,
  awaitingApproval: false,
  formatAt: (iso) => iso,
};

function show() {
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: (() =>
      Promise.resolve({ mediaType: 'image/png', base64: 'iVBORw0K' })) as Connection['request'],
    subscribe: () => () => undefined,
    retry: () => undefined,
    close: () => undefined,
  };
  render(
    <RuntimeProvider
      runtime={{
        connection,
        layout: createLayoutStore(),
        draft: createDraftStore(),
        settings: createSettingsStore(
          createMemorySettingsSource(undefined, { 'chat.toolImagesShown': 2 }),
        ),
      }}
    >
      <ol>
        <ConversationItem item={item} approvals={[]} questions={[]} context={context} />
      </ol>
    </RuntimeProvider>,
  );
}

describe('pictures in tool rows (spec 33, 34)', () => {
  it('shows the first pictures under the closed row, +N more for the rest and what was left out', async () => {
    const user = userEvent.setup();
    show();
    const pictures = screen.getByTestId('tool-images');
    expect(within(pictures).getAllByTestId('tool-image')).toHaveLength(2);
    expect(screen.getByTestId('tool-images-omitted').textContent).toBe(
      '1 picture not shown (too large)',
    );
    await user.click(within(pictures).getByRole('button', { name: '+1 more' }));
    // Opened, the row shows every picture.
    expect(screen.getAllByTestId('tool-image')).toHaveLength(3);
    await user.click(
      screen.getByRole('button', { name: "Show picture 1 of the tool's result full size" }),
    );
    expect(await screen.findByTestId('image-full-size')).toBeTruthy();
  });

  it('names the pictures for find and the export', () => {
    expect(picturesText(payload)).toBe('3 pictures');
    expect(picturesText({ ...payload, images: [] })).toBe('');
  });
});
