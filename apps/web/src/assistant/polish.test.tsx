import type {
  AssistantChange,
  AssistantProposal,
  ProviderInstance,
  Thread,
  ThreadItem,
} from '@wow/contracts';
import { act, screen, within } from '@testing-library/react';
import type { Connection, ConnectionState } from '@wow/client-runtime';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { createTestRuntime, renderApp } from '@/test/render';
import type * as ModelModule from './model';
import { askOf } from './model';

// The real reading of a tool call's ask, counted: the view reads the conversation's tool calls
// again only when what they are read from changed.
vi.mock('./model', async (importOriginal) => {
  const real = await importOriginal<typeof ModelModule>();
  return { ...real, askOf: vi.fn<typeof real.askOf>(real.askOf) };
});

// Agent workbench U13 in the Assistant view: wow's tool calls without duplicate rows and in
// words (spec 82), and the waiting proposal's line above the composer (spec 96).

const at = '2026-11-12T08:00:00.000Z';

const thread: Thread = {
  id: 'main-1',
  kind: 'chat',
  projectId: null,
  cwd: '/home/me/.wow/threads/main-1',
  branch: null,
  providerInstanceId: 'claude-work',
  providerSessionId: null,
  title: 'Assistant',
  model: 'opus',
  effort: 'high',
  permissionMode: 'default',
  state: 'idle',
  pinned: false,
  createdAt: at,
  updatedAt: at,
};

const instance: ProviderInstance = {
  id: 'claude-work',
  kind: 'claude',
  name: 'Claude at work',
  binaryPath: 'claude',
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: null,
  defaultEffort: null,
  defaultPermissionMode: null,
  status: 'ready',
  account: 'ada@example.com',
  version: '2.1.0',
  statusMessage: null,
  update: null,
  updateRun: null,
};

let index = 0;
const toolCall = (name: string, input: unknown, output: unknown): ThreadItem => ({
  id: `item-${++index}`,
  threadId: 'main-1',
  turnId: 'main-1:turn:0',
  index,
  kind: 'tool_call',
  payload: { name, input, output: JSON.stringify(output), status: 'ok' },
  streaming: false,
});

const change: AssistantChange = {
  id: 'assistant-c1',
  at,
  commandType: 'setting.set',
  what: 'Work hours',
  from: 'From Outlook',
  to: '08:00–16:00, Mon–Fri',
  place: { label: 'Settings → Calendar', path: '/settings/calendar' },
  target: { kind: 'setting', id: 'calendar.workHours:global' },
  state: 'applied',
  undoneAt: null,
};

const proposal = (id: string, title: string): AssistantProposal => ({
  id,
  at,
  commandType: 'setting.set',
  title,
  lines: [{ what: 'Always allow', from: null, to: 'Run commands starting with `pnpm test`' }],
  place: { label: 'Settings → Approvals', path: '/settings/approvals' },
  state: 'pending',
  answeredAt: null,
  reason: null,
});

const items = (): ThreadItem[] => [
  toolCall('mcp__wow__read_workflows', {}, []),
  toolCall(
    'mcp__wow__set_setting',
    { key: 'calendar.workHours' },
    { outcome: 'changed', change: { id: 'assistant-c1' } },
  ),
  toolCall(
    'mcp__wow__propose_always_allow_rule',
    { projectId: 'tea', rule: { kind: 'command', prefix: 'pnpm test' } },
    { outcome: 'proposed', proposal: { id: 'assistant-p1' } },
  ),
  toolCall(
    'mcp__wow__show_secret_field',
    { key: 'trackers.gitlab.token' },
    { outcome: 'shown', secret: 'not set' },
  ),
  toolCall(
    'mcp__wow__ask_questions',
    {
      questions: [
        {
          question: 'When should it run?',
          header: 'Time',
          options: [{ label: '08:30' }, { label: '09:00' }],
          multiSelect: false,
        },
      ],
    },
    { outcome: 'asked' },
  ),
  toolCall('wow/diagnose_setup', {}, { outcome: 'diagnosed', problems: [] }),
];

function assistantConnection(proposals: AssistantProposal[]) {
  const sent: unknown[] = [];
  const conversation = items();
  const listeners = new Map<string, (rows: unknown[]) => void>();
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: (method, params) => {
      if (method === 'dispatch') {
        sent.push((params as { command: unknown }).command);
        return Promise.resolve({ commandId: 'c', seqs: [1], duplicate: false });
      }
      return Promise.resolve([]);
    },
    subscribe(topic, _params, onData) {
      const topics: Readonly<Record<string, unknown[]>> = {
        threads: [thread],
        providerInstances: [instance],
        threadItems: conversation,
        assistantChanges: [change],
        assistantProposals: proposals,
      };
      listeners.set(topic, onData);
      onData(topics[topic] ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  const push = (topic: string, rows: unknown[]) => act(() => listeners.get(topic)?.(rows));
  return { connection, sent, push };
}

describe("wow's tool calls in a main thread (spec 82; orchestrator threads spec 24)", () => {
  it('draw no row of their own above a change row, a proposal, a secret field or a question card, and other tools read in words', async () => {
    const { connection } = assistantConnection([proposal('assistant-p1', 'Always allow')]);
    await renderApp('/chat/main-1', { ...createTestRuntime(), connection });
    const conversation = await screen.findByRole('list', { name: 'Conversation' });
    expect(
      await within(conversation).findByRole('region', { name: 'Change: Work hours' }),
    ).toBeTruthy();
    expect(
      within(conversation).getByRole('region', { name: 'Proposal: Always allow' }),
    ).toBeTruthy();
    expect(within(conversation).getByTestId('question-card')).toBeTruthy();
    expect(conversation.textContent).not.toMatch(/mcp__wow__|wow\//);
    expect(
      within(conversation)
        .getAllByTestId('tool-words')
        .map((row) => row.textContent),
    ).toEqual(['Read your workflows', 'Checked what does not work']);
  });
});

describe('a main thread across renders', () => {
  it('reads its tool calls again only when what they are read from changed', async () => {
    const { connection, push } = assistantConnection([proposal('assistant-p1', 'Always allow')]);
    await renderApp('/chat/main-1', { ...createTestRuntime(), connection });
    const conversation = await screen.findByRole('list', { name: 'Conversation' });
    await within(conversation).findByRole('region', { name: 'Change: Work hours' });
    const reads = vi.mocked(askOf).mock.calls.length;
    // A render for something the tool calls are not read from: the same conversation.
    await push('threads', [{ ...thread }]);
    expect(vi.mocked(askOf).mock.calls.length).toBe(reads);
  });
});
