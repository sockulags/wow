import type {
  AssistantChange,
  AssistantProposal,
  Command,
  ProviderInstance,
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
import { createDraftStore } from '@/chat/draft';
import { givenFolder, ownThreadFolder } from '@/chat/new-thread';
import { ThreadConversation } from '@/chat/thread-view';

// The app tools in a main thread (orchestrator threads spec 24): what a call of wow's tools made
// is drawn right after it, in the thread whose agent called it. All invented.

const main: Thread = {
  id: 'main',
  projectId: null,
  cwd: '/home/wow/.wow/threads/main',
  branch: null,
  providerInstanceId: 'claude',
  providerSessionId: 'session-1',
  title: 'Plan the week',
  model: 'sonnet',
  effort: 'high',
  permissionMode: 'default',
  state: 'idle',
  pinned: false,
  createdAt: '2026-11-24T08:00:00.000Z',
  updatedAt: '2026-11-24T08:00:00.000Z',
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

const turn: Turn = {
  id: 'main:turn:0',
  threadId: 'main',
  index: 0,
  state: 'completed',
  startedAt: '2026-11-24T08:00:00.000Z',
  endedAt: '2026-11-24T08:00:30.000Z',
  usage: null,
  resumable: true,
  restorable: true,
};

const call = (index: number, name: string, output: unknown): ThreadItem => ({
  id: `main:call:${index}`,
  threadId: 'main',
  turnId: turn.id,
  index,
  kind: 'tool_call',
  payload: { name: `mcp__wow__${name}`, input: {}, output: JSON.stringify(output), status: 'ok' },
  streaming: false,
});

const change: AssistantChange = {
  id: 'assistant-card',
  at: '2026-11-24T08:00:10.000Z',
  commandType: 'card.create',
  what: 'Card',
  from: null,
  to: 'Steep the tea',
  place: { label: 'Calendar', path: '/calendar' },
  target: { kind: 'card', id: 'card-1' },
  state: 'applied',
  undoneAt: null,
};

const proposal: AssistantProposal = {
  id: 'assistant-rule',
  at: '2026-11-24T08:00:20.000Z',
  commandType: 'setting.set',
  title: 'Always allow pnpm test in Tea',
  lines: [{ what: 'Always allow', from: null, to: 'pnpm test' }],
  place: { label: 'Settings → Approvals', path: '/settings/approvals' },
  state: 'pending',
  answeredAt: null,
  reason: null,
};

function setup(thread: Thread = main) {
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>(() =>
    Promise.resolve({
      commandId: '00000000-0000-4000-8000-000000000000',
      seqs: [],
      duplicate: false,
    }),
  );
  const items = [
    {
      ...call(1, 'create_card', { outcome: 'changed', change: { id: change.id } }),
      threadId: thread.id,
    },
    {
      ...call(2, 'propose_always_allow_rule', {
        outcome: 'proposed',
        proposal: { id: proposal.id },
      }),
      threadId: thread.id,
    },
  ];
  const topics: Record<string, unknown> = {
    turns: [{ ...turn, threadId: thread.id }],
    threadItems: items,
    approvals: [],
    questions: [],
    threads: [thread],
    assistantChanges: [change],
    assistantProposals: [proposal],
  };
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: request as Connection['request'],
    subscribe(topic, _params, onData) {
      onData(topics[topic] ?? []);
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
      <ThreadConversation thread={thread} instance={claude} />
    </RuntimeProvider>,
  );
  const dispatched = () =>
    request.mock.calls.flatMap(([method, params]) =>
      method === 'dispatch' ? [(params as { command: Command }).command] : [],
    );
  return { dispatched };
}

describe("a main thread's app tool rows (spec 24)", () => {
  it('draws the change row and the proposal after their calls, and Yes accepts the proposal', async () => {
    const user = userEvent.setup();
    const { dispatched } = setup();
    const conversation = await screen.findByRole('list', { name: 'Conversation' });
    expect(conversation.textContent).toContain('Steep the tea');
    expect(conversation.textContent).toContain('Always allow pnpm test in Tea');
    await user.click(within(conversation).getByRole('button', { name: /^Yes/ }));
    expect(dispatched()).toContainEqual({
      type: 'assistant.proposal.accept',
      proposalId: 'assistant-rule',
    });
  });

  it("draws none of them in a helper's thread", async () => {
    setup({ ...main, id: 'helper', parentThreadId: 'main', startedBy: 'helper' });
    const conversation = await screen.findByRole('list', { name: 'Conversation' });
    expect(conversation.textContent).not.toContain('Always allow pnpm test in Tea');
  });
});

describe('a new thread after one without a project (spec 1)', () => {
  it('does not carry over a folder wow gave the last thread, but one the user chose', () => {
    expect(ownThreadFolder({ id: 'bare', cwd: '/home/ada/.wow/threads/bare' })).toBe(true);
    expect(ownThreadFolder({ id: 'bare', cwd: String.raw`C:\Users\ada\.wow\threads\bare` })).toBe(
      true,
    );
    expect(ownThreadFolder({ id: 'other', cwd: '/home/ada/.wow/threads/bare' })).toBe(false);
    expect(ownThreadFolder({ id: 'chosen', cwd: '/home/ada/tea' })).toBe(false);
  });

  it("does not carry over a bare thread's folder from its helper or its fork either", () => {
    const bare = { id: 'bare', cwd: '/home/ada/.wow/threads/bare' };
    const helper = { id: 'helper', cwd: '/home/ada/.wow/threads/bare' };
    const fork = { id: 'fork', cwd: String.raw`\home\ada\.wow\threads\bare` };
    const chosen = { id: 'chosen', cwd: '/home/ada/tea' };
    const threads = [bare, helper, fork, chosen];
    expect(givenFolder(helper.cwd, threads)).toBe(true);
    expect(givenFolder(fork.cwd, threads)).toBe(true);
    expect(givenFolder(chosen.cwd, threads)).toBe(false);
  });
});
