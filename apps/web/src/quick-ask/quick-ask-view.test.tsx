import type { Command } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { outbox, type Outbox } from '@/test/outbox';
import { renderApp } from '@/test/render';

// The quick ask window (chief of staff spec 31), against a fake server.

interface Sent {
  readonly method: string;
  readonly params: unknown;
}

function fake(box: Outbox<Sent>): Runtime {
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request(method, params) {
      box.record({ method, params });
      const { commandId } = params as { commandId: string };
      return Promise.resolve({ commandId, seqs: [box.sent.length], duplicate: false });
    },
    subscribe(_topic, _params, onData) {
      onData([]);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  return {
    connection,
    layout: createLayoutStore(),
    draft: createDraftStore(),
    settings: createSettingsStore(createMemorySettingsSource()),
  };
}

afterEach(() => {
  delete window.wowDesktop;
});

describe('the quick ask', () => {
  it('shows alone, sends the text to the assistant on Enter and hides on Escape', async () => {
    const hideQuickAsk = vi.fn<() => Promise<unknown>>(() => Promise.resolve());
    window.wowDesktop = { hideQuickAsk };
    const box = outbox<Sent>();
    await renderApp('/quick-ask', fake(box));
    expect(screen.queryByRole('navigation')).toBeNull();
    const user = userEvent.setup();
    await user.type(
      screen.getByRole('textbox', { name: 'Message to the assistant' }),
      'What waits for me?{Enter}',
    );
    const sent = box.sent
      .filter((entry) => entry.method === 'dispatch')
      .map((entry) => (entry.params as { command: Command }).command);
    expect(sent).toEqual([
      { type: 'thread.sendMessage', threadId: 'assistant', text: 'What waits for me?' },
    ]);
    await user.keyboard('{Escape}');
    expect(hideQuickAsk).toHaveBeenCalledOnce();
  });
});
