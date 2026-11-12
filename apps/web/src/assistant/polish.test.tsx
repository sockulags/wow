import type {
  AssistantChange,
  AssistantProposal,
  ProviderInstance,
  Thread,
  ThreadItem,
} from '@wow/contracts';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Connection, ConnectionState } from '@wow/client-runtime';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { createTestRuntime, renderApp } from '@/test/render';
import { waitingText } from './model';

// Agent workbench U13 in the Assistant view: wow's tool calls without duplicate rows and in
// words (spec 82), and the waiting proposal's line above the composer (spec 96).

const at = '2026-11-12T08:00:00.000Z';

const thread: Thread = {
  id: 'assistant',
  kind: 'assistant',
  projectId: null,
  cwd: '/home/me/.wow/assistant',
  branch: null,
  providerInstanceId: 'claude-work',
  providerSessionId: null,
  title: 'Assistant',
  model: 'opus',
  effort: 'high',
  permissionMode: 'default',
  state: 'idle',
  pinned: false,
  runId: null,
  stepId: null,
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
  threadId: 'assistant',
  turnId: 'assistant:turn:0',
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
  const connection: Connection = {
    state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
    request: (method, params) => {
      if (method === 'dispatch') {
        sent.push((params as { command: unknown }).command);
        return Promise.resolve({ commandId: 'c', seqs: [1], duplicate: false });
      }
      return Promise.resolve(method === 'assistant.open' ? { thread: null, problem: null } : []);
    },
    subscribe(topic, _params, onData) {
      const topics: Readonly<Record<string, unknown[]>> = {
        assistantThread: [thread],
        providerInstances: [instance],
        threadItems: conversation,
        assistantChanges: [change],
        assistantProposals: proposals,
      };
      onData(topics[topic] ?? []);
      return () => undefined;
    },
    retry: () => undefined,
    close: () => undefined,
  };
  return { connection, sent };
}

describe("wow's tool calls in the Assistant view (spec 82)", () => {
  it('draw no row of their own above a change row, a proposal, a secret field or a question card, and other tools read in words', async () => {
    const { connection } = assistantConnection([proposal('assistant-p1', 'Always allow')]);
    await renderApp('/assistant', { ...createTestRuntime(), connection });
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

describe('a waiting proposal above the composer (spec 96)', () => {
  it('names the oldest with Yes, No and Show', async () => {
    const user = userEvent.setup();
    const { connection, sent } = assistantConnection([
      proposal('assistant-p1', 'Always allow `pnpm test` in Tea'),
      proposal('assistant-p2', 'Change Paused'),
    ]);
    await renderApp('/assistant', { ...createTestRuntime(), connection });
    const line = await screen.findByRole('status', { name: 'Waiting proposal' });
    expect(within(line).getByTestId('assistant-waiting-text').textContent).toBe(
      '2 proposals wait: Always allow `pnpm test` in Tea',
    );

    await user.click(within(line).getByRole('button', { name: 'Show' }));
    expect(document.activeElement).toBe(
      screen.getByRole('region', { name: 'Proposal: Always allow `pnpm test` in Tea' }),
    );

    await user.click(within(line).getByRole('button', { name: 'Yes' }));
    await user.click(within(line).getByRole('button', { name: 'No' }));
    await act(() => Promise.resolve());
    expect(sent).toEqual([
      { type: 'assistant.proposal.accept', proposalId: 'assistant-p1' },
      { type: 'assistant.proposal.decline', proposalId: 'assistant-p1' },
    ]);
  });

  it('is not there while nothing waits, and says one proposal in the singular', () => {
    expect(waitingText([])).toBeUndefined();
    expect(waitingText([proposal('p', 'Run scripts in HTML files')])).toBe(
      '1 proposal waits: Run scripts in HTML files',
    );
  });
});
