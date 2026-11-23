import type {
  Approval,
  Command,
  ProviderInstance,
  Question,
  Thread,
  ThreadItem,
  Turn,
} from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore } from 'zustand';
import { describe, expect, it, vi } from 'vitest';
import { createLayoutStore, RuntimeProvider } from '@/app/runtime';
import { createDraftStore } from './draft';
import { gateRowText } from './helpers';
import { ThreadConversation } from './thread-view';

// Gates in the main thread (orchestrator threads spec 14 to 18): a helper's approval or question
// drawn at the end of the main thread's conversation, read from the helper's own thread and
// answered with the same commands. All invented.

const main: Thread = {
  id: 'main',
  projectId: 'tea',
  cwd: '/home/wow/tea',
  branch: null,
  providerInstanceId: 'claude',
  providerSessionId: 'session-1',
  title: 'Ship the timer',
  model: 'sonnet',
  effort: 'high',
  permissionMode: 'default',
  state: 'idle',
  pinned: false,
  runId: null,
  stepId: null,
  createdAt: '2026-11-23T08:00:00.000Z',
  updatedAt: '2026-11-23T08:00:00.000Z',
};

const deep: Thread = {
  ...main,
  id: 'deep',
  title: 'Approve the release',
  // The helper works in a copy of its own, in a mode of its own.
  cwd: '/home/wow/workspaces/tea-deep',
  permissionMode: 'acceptEdits',
  state: 'needs_you',
  startedBy: 'helper',
  parentThreadId: 'first',
};

const asker: Thread = {
  ...main,
  id: 'asker',
  title: 'Pick the port',
  providerInstanceId: 'codex',
  state: 'needs_you',
  startedBy: 'helper',
  parentThreadId: 'main',
};

const claude: ProviderInstance = {
  id: 'claude',
  kind: 'claude',
  name: 'Claude',
  binaryPath: 'claude',
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: 'sonnet',
  defaultEffort: null,
  defaultPermissionMode: null,
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
};

// A helper's request waits while the turn that asked runs.
const turn = (threadId: string, state: Turn['state'] = 'completed'): Turn => ({
  id: `${threadId}:turn:0`,
  threadId,
  index: 0,
  state,
  startedAt: '2026-11-23T08:00:00.000Z',
  endedAt: state === 'running' ? null : '2026-11-23T08:00:30.000Z',
  usage: null,
  resumable: true,
  restorable: true,
});

const item = (
  threadId: string,
  index: number,
  kind: ThreadItem['kind'],
  payload: unknown,
): ThreadItem => ({
  id: `${threadId}:${kind}:${index}`,
  threadId,
  turnId: `${threadId}:turn:0`,
  index,
  kind,
  payload,
  streaming: false,
});

const approvalCard = item('main', 2, 'gate_card', {
  fromThreadId: 'deep',
  kind: 'approval',
  requestId: 'deep-approval',
  itemId: 'deep:approval:1',
  title: 'Approve the release',
  instanceName: 'Claude',
  providerKind: 'claude',
  depth: 2,
  parentTitle: 'Plan the deploy',
  at: '2026-11-23T08:01:00.000Z',
});

const questionCard = item('main', 3, 'gate_card', {
  fromThreadId: 'asker',
  kind: 'question',
  requestId: 'asker-port',
  itemId: 'asker:question:1',
  title: 'Pick the port',
  instanceName: 'Codex at work',
  providerKind: 'codex',
  depth: 1,
  at: '2026-11-23T08:02:00.000Z',
});

const pending: Approval = {
  id: 'deep-approval',
  threadId: 'deep',
  itemId: 'deep:approval:1',
  kind: 'command',
  request: { command: 'pnpm test' },
  decision: null,
  decidedAt: null,
};

const port: Question = {
  id: 'asker-port',
  threadId: 'asker',
  itemId: 'asker:question:1',
  request: { question: 'Which port?' },
  answer: null,
  answeredAt: null,
};

function setup(
  options: { approval?: Approval; question?: Question; helperTurn?: Turn['state'] } = {},
) {
  const helperTurn = options.helperTurn ?? 'running';
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>(() =>
    Promise.resolve({
      commandId: '00000000-0000-4000-8000-000000000000',
      seqs: [],
      duplicate: false,
    }),
  );
  // Thread-scoped topics answer for the thread asked about.
  const scoped: Record<string, Record<string, unknown>> = {
    main: {
      turns: [turn('main')],
      threadItems: [
        item('main', 1, 'user', { text: 'Ship it with helpers' }),
        approvalCard,
        questionCard,
      ],
      approvals: [],
      questions: [],
    },
    deep: {
      turns: [turn('deep', helperTurn)],
      threadItems: [
        item('deep', 1, 'approval', {
          approvalId: 'deep-approval',
          kind: 'command',
          summary: 'pnpm test',
        }),
      ],
      approvals: [options.approval ?? pending],
      questions: [],
    },
    asker: {
      turns: [turn('asker', helperTurn)],
      threadItems: [
        item('asker', 1, 'question', {
          questionId: 'asker-port',
          question: 'Which port?',
          options: [{ label: '4317' }, { label: '8080' }],
          multiSelect: false,
        }),
      ],
      approvals: [],
      questions: [options.question ?? port],
    },
  };
  const global: Record<string, unknown> = {
    threads: [main, deep, asker],
    providerInstances: [claude, { ...claude, id: 'codex', kind: 'codex', name: 'Codex at work' }],
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: request as Connection['request'],
    subscribe(topic, params, onData) {
      const threadId = params?.threadId;
      onData((threadId === undefined ? global[topic] : scoped[threadId]?.[topic]) ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  render(
    <RuntimeProvider
      runtime={{
        connection,
        layout: createLayoutStore(),
        draft: createDraftStore(),
        settings: createSettingsStore(createMemorySettingsSource(undefined, {})),
      }}
    >
      <ThreadConversation thread={main} instance={claude} />
    </RuntimeProvider>,
  );
  const dispatched = () =>
    request.mock.calls.flatMap(([method, params]) =>
      method === 'dispatch' ? [(params as { command: Command }).command] : [],
    );
  return { dispatched };
}

describe('gate cards in the main thread (spec 14 to 18)', () => {
  it("draws a depth 2 helper's approval at the end with who asks, and Allow answers it there", async () => {
    const user = userEvent.setup();
    const { dispatched } = setup();
    const card = await screen.findByRole('listitem', {
      name: 'Approve the release · Claude Code · depth 2 · Helper of Plan the deploy asks you',
    });
    expect(within(card).getByRole('region', { name: 'Approval request' }).textContent).toContain(
      'pnpm test',
    );
    // The cards wait after everything else in the conversation.
    const conversation = screen.getByRole('list', { name: 'Conversation' });
    const cards = within(conversation).getAllByTestId('gate-card');
    expect(cards.at(0)).toBe(card);
    expect([...conversation.children].slice(-2)).toEqual(cards);
    expect(within(conversation).getAllByTestId('gate-card-line')[0]?.textContent).toContain(
      'the card waits at the end',
    );
    await user.click(within(card).getByRole('button', { name: /Allow once/ }));
    expect(dispatched()).toContainEqual(
      expect.objectContaining({
        type: 'approval.answer',
        approvalId: 'deep-approval',
        decision: 'allowOnce',
      }),
    );
  });

  it("draws a helper's question with its choices and sends the answer as the helper's own", async () => {
    const user = userEvent.setup();
    const { dispatched } = setup();
    const card = await screen.findByRole('listitem', {
      name: 'Pick the port · Codex · depth 1 asks you',
    });
    expect(card.textContent).toContain('Which port?');
    await user.click(within(card).getByRole('radio', { name: /8080/ }));
    await user.click(within(card).getByRole('button', { name: /Send/ }));
    expect(dispatched()).toContainEqual({
      type: 'question.answer',
      answers: [{ questionId: 'asker-port', reply: { picked: ['8080'], text: '' } }],
    });
  });

  it('says "Answered in <helper>" in its place once answered anywhere, and draws no card', async () => {
    setup({
      approval: { ...pending, decision: 'allowOnce', decidedAt: '2026-11-23T08:03:00.000Z' },
      question: { ...port, answer: '4317', answeredAt: '2026-11-23T08:03:00.000Z' },
    });
    const lines = await screen.findAllByTestId('gate-card-line');
    expect(lines.map((line) => line.textContent)).toEqual([
      'Answered in Approve the release: Allowed once',
      'Answered in Pick the port: 4317',
    ]);
    expect(screen.queryAllByTestId('gate-card')).toEqual([]);
  });

  it("shows the helper's own folder and mode, and takes neither the focus nor the keys", async () => {
    const user = userEvent.setup();
    const { dispatched } = setup();
    const card = await screen.findByRole('listitem', {
      name: 'Approve the release · Claude Code · depth 2 · Helper of Plan the deploy asks you',
    });
    const where = within(card).getByTestId('approval-context').textContent ?? '';
    expect(where).toContain('/home/wow/workspaces/tea-deep');
    expect(where).toContain('Accept edits');
    expect(where).not.toContain('/home/wow/tea ');
    expect(card.contains(document.activeElement)).toBe(false);
    // Typing outside a field, as the approval keys would be pressed, answers nothing here.
    await user.keyboard('asy');
    expect(dispatched().filter((command) => command.type === 'approval.answer')).toEqual([]);
  });

  it('draws no card for a request whose turn ended without an answer, and says so', async () => {
    setup({ helperTurn: 'interrupted' });
    const lines = await screen.findAllByTestId('gate-card-line');
    expect(lines.map((line) => line.textContent)).toEqual([
      'Approve the release · Claude Code · depth 2 · Helper of Plan the deploy asked you; its turn ended without an answer.',
      'Pick the port · Codex · depth 1 asked you; its turn ended without an answer.',
    ]);
    expect(screen.queryAllByTestId('gate-card')).toEqual([]);
  });

  it('names who asks for Ctrl+F and the Markdown export', () => {
    expect(gateRowText(approvalCard.payload as Parameters<typeof gateRowText>[0])).toBe(
      'Approve the release · Claude Code · depth 2 · Helper of Plan the deploy asks you for an approval',
    );
  });
});
