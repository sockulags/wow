import type { Command, Decision } from '@wow/contracts';
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
import { renderWithRuntime } from '@/test/render';
import { DecisionQueue } from './queue';

// The decision queue (chief of staff spec 16 to 19), against a fake server. Invented rows.

const decision = (extra: Partial<Decision>): Decision => ({
  id: 'gate:run-1:s1',
  kind: 'gate',
  at: '2026-11-10T08:00:00.000Z',
  title: 'deliver-work waits for your review',
  where: 'Delivery · Tea',
  path: '/workflows/runs/run-1',
  threadId: null,
  runId: 'run-1',
  proposalId: null,
  approvalId: null,
  questionId: null,
  cardId: null,
  holdsTurn: false,
  cardStart: null,
  fixed: ['Artifacts: notes.md'],
  brief: null,
  briefPending: false,
  ...extra,
});

const rows: Decision[] = [
  decision({
    id: 'approval:a1',
    kind: 'approval',
    title: 'Run pnpm test',
    approvalId: 'a1',
    threadId: 't1',
    holdsTurn: true,
    fixed: ['The agent asks to run a command.'],
  }),
  decision({
    brief: {
      text: 'The spec is written and checked.',
      recommendation: 'Approve it.',
      at: '2026-11-10T08:01:00.000Z',
    },
  }),
  decision({ id: 'failedRun:run-2', kind: 'failedRun', title: 'Delivery failed', runId: 'run-2' }),
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
    subscribe(topic, _params, onData) {
      onData(topic === 'decisions' ? rows : []);
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

const sent = (box: Outbox<Sent>): Command[] =>
  box.sent
    .filter((entry) => entry.method === 'dispatch')
    .map((entry) => (entry.params as { command: Command }).command);

describe('the decision queue', () => {
  it('shows the rows in the server order with their briefs and answers them', async () => {
    const box = outbox<Sent>();
    renderWithRuntime(<DecisionQueue />, fake(box));
    const items = await screen.findAllByTestId('decision');
    expect(items.map((item) => item.dataset['kind'])).toEqual(['approval', 'gate', 'failedRun']);
    expect(within(items[1] as HTMLElement).getByTestId('decision-brief').textContent).toContain(
      'Recommends: Approve it.',
    );
    const user = userEvent.setup();
    await user.click(within(items[0] as HTMLElement).getByRole('button', { name: 'Deny' }));
    await user.click(within(items[1] as HTMLElement).getByRole('button', { name: 'Approve' }));
    await user.click(within(items[2] as HTMLElement).getByRole('button', { name: 'Dismiss' }));
    expect(sent(box)).toEqual([
      { type: 'approval.answer', approvalId: 'a1', decision: 'deny' },
      { type: 'workflowRun.continue', runId: 'run-1' },
      { type: 'decision.dismiss', decisionId: 'failedRun:run-2' },
    ]);
  });

  it('answers with the gate key while a row has the keyboard', async () => {
    const box = outbox<Sent>();
    renderWithRuntime(<DecisionQueue />, fake(box));
    const items = await screen.findAllByTestId('decision');
    (items[1] as HTMLElement).focus();
    await userEvent.setup().keyboard('{Control>}{Enter}{/Control}');
    expect(sent(box)).toEqual([{ type: 'workflowRun.continue', runId: 'run-1' }]);
  });
});
