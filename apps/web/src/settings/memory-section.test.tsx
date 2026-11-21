import type { AssistantNote, Command } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, type Runtime } from '@/app/runtime';
import { createDraftStore } from '@/chat/draft';
import { outbox, type Outbox } from '@/test/outbox';
import { renderApp } from '@/test/render';

// Settings → Assistant → Memory (chief of staff spec 30), against a fake server. The notes are
// invented.

const notes: AssistantNote[] = [
  {
    id: 'n1',
    text: 'Never plan anything before nine.',
    addedAt: '2026-11-20T08:00:00.000Z',
    by: 'assistant',
  },
  {
    id: 'n2',
    text: 'Tea matters most.',
    addedAt: '2026-11-20T09:00:00.000Z',
    until: '2026-11-27',
    by: 'you',
  },
];

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
    settings: createSettingsStore(
      createMemorySettingsSource(undefined, {
        'providers.offerSetup': false,
        'assistant.notes': notes,
      }),
    ),
  };
}

const commandsSent = (box: Outbox<Sent>): Command[] =>
  box.sent
    .filter((entry) => entry.method === 'dispatch')
    .map((entry) => (entry.params as { command: Command }).command);

describe('Memory', () => {
  it('lists every note with who wrote it and until when, and removes one', async () => {
    const box = outbox<Sent>();
    await renderApp('/settings/assistant', fake(box));
    const section = within(await screen.findByRole('region', { name: 'Memory' }));
    const rows = section.getAllByTestId('assistant-note');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Kept by the assistant');
    expect(rows[1]?.textContent).toContain('Added by you');
    expect(rows[1]?.textContent).toContain('until 2026-11-27');

    const user = userEvent.setup();
    await user.click(
      within(rows[0] as HTMLElement).getByRole('button', { name: 'Remove the note' }),
    );
    expect(commandsSent(box).at(-1)).toMatchObject({
      type: 'setting.set',
      key: 'assistant.notes',
      value: [{ id: 'n2' }],
    });
  });

  it('adds a note of yours', async () => {
    const box = outbox<Sent>();
    await renderApp('/settings/assistant', fake(box));
    const section = within(await screen.findByRole('region', { name: 'Memory' }));
    const user = userEvent.setup();
    await user.type(section.getByRole('textbox', { name: 'New note' }), 'Lunch at noon{Enter}');
    const sent = commandsSent(box).at(-1) as Extract<Command, { type: 'setting.set' }>;
    expect(sent.value).toHaveLength(3);
    expect((sent.value as AssistantNote[])[2]).toMatchObject({ text: 'Lunch at noon', by: 'you' });
  });
});
