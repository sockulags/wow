import type { ProviderInstance, Skill, Thread, ThreadItem, Turn } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type Connection,
  type ConnectionState,
} from '@wow/client-runtime';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { createLayoutStore, RuntimeProvider } from '@/app/runtime';
import { activeSkillComposer, skillComposerStore } from './composer-store';
import { createDraftStore } from './draft';
import { ThreadConversation } from './thread-view';

// wow skills U3: the thread's own paths with skills. The composer itself is in composer.test.tsx.

const skills: Skill[] = [
  {
    id: 'yours/tidy-notes',
    name: 'tidy-notes',
    description: 'Tidy the notes of a run',
    dir: '/skills/tidy-notes',
    source: 'yours',
    manualOnly: false,
    invocations: { claude: '/tidy-notes', codex: '$tidy-notes' },
    text: 'Do tidy-notes.',
  },
];

const thread: Thread = {
  id: 'thread-1',
  projectId: null,
  cwd: '/work/kettle',
  branch: null,
  providerInstanceId: 'claude',
  providerSessionId: null,
  title: 'Kettle',
  model: 'opus',
  effort: 'high',
  permissionMode: 'default',
  state: 'idle',
  pinned: false,
  runId: null,
  stepId: null,
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
};

const instance: ProviderInstance = {
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

// A turn that failed after a message sent with a chip, so Retry is offered.
const failedTurn: Turn = {
  id: 'turn-1',
  threadId: thread.id,
  index: 0,
  state: 'failed',
  startedAt: '2026-11-02T08:01:00.000Z',
  endedAt: '2026-11-02T08:02:00.000Z',
  usage: null,
};
const failedItems: ThreadItem[] = [
  {
    id: 'item-1',
    threadId: thread.id,
    turnId: 'turn-1',
    index: 0,
    kind: 'user',
    payload: {
      text: 'tidy the kettle notes',
      skills: [{ name: 'tidy-notes', source: 'yours', text: 'Do tidy-notes.' }],
    },
    streaming: false,
  },
  {
    id: 'item-2',
    threadId: thread.id,
    turnId: 'turn-1',
    index: 1,
    kind: 'error',
    payload: { message: 'The agent stopped' },
    streaming: false,
  },
];

function setup({
  assistant = false,
  failed = false,
  shown = thread,
  topics: extra = {},
}: {
  assistant?: boolean;
  failed?: boolean;
  shown?: Thread;
  topics?: Record<string, unknown>;
} = {}) {
  const request = vi.fn<(method: string, params: unknown) => Promise<unknown>>(() =>
    Promise.resolve({
      commandId: '00000000-0000-4000-8000-000000000000',
      seqs: [],
      duplicate: false,
    }),
  );
  const topics: Record<string, unknown> = {
    skills,
    turns: failed ? [failedTurn] : [],
    threadItems: failed ? failedItems : [],
    ...extra,
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
      <ThreadConversation
        thread={shown}
        instance={instance}
        {...(assistant ? { extras: { placeholder: 'Message' } } : {})}
      />
    </RuntimeProvider>,
  );
  const box = screen.getByRole('combobox', { name: /message/i });
  const sent = () =>
    request.mock.calls
      .filter(([method]) => method === 'dispatch')
      .map(([, params]) => (params as { command: unknown }).command);
  return { box, sent, user: userEvent.setup() };
}

const list = () => screen.queryByRole('listbox', { name: 'Skills' });

describe('the thread sends skills (wow skills spec 18, 20)', () => {
  it('sends picked chips with the message in an existing thread', async () => {
    const { box, sent, user } = setup();
    await user.type(box, '/tidy');
    expect(list()).not.toBeNull();
    await user.keyboard('{Enter}');
    await user.type(box, 'the notes{Enter}');
    expect(sent()).toContainEqual({
      type: 'thread.sendMessage',
      threadId: thread.id,
      text: 'the notes',
      skills: [{ name: 'tidy-notes', source: 'yours' }],
    });
  });

  it('resends the text and the skills on Retry', async () => {
    const { sent, user } = setup({ failed: true });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(sent()).toContainEqual({
      type: 'thread.sendMessage',
      threadId: thread.id,
      text: 'tidy the kettle notes',
      skills: [{ name: 'tidy-notes', source: 'yours' }],
    });
  });

  it("opens no skill list in the Assistant view's conversation", async () => {
    const { box, user } = setup({ assistant: true });
    await user.type(box, '/tidy');
    expect(list()).toBeNull();
    expect(activeSkillComposer(skillComposerStore.getState())).toBeUndefined();
  });
});

describe("a step's thread and a waiting question (wow skills spec 14, 18)", () => {
  it('sends the step its message again as the step sent it on Retry', async () => {
    const { sent, user } = setup({
      failed: true,
      shown: { ...thread, runId: 'run-1', stepId: 'build' },
    });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(sent()).toEqual([{ type: 'thread.retry', threadId: thread.id }]);
  });

  it("names a plugin skill's sent chip by its own name, with the plugins mark", () => {
    setup({
      topics: {
        threadItems: [
          {
            ...failedItems[0],
            payload: {
              text: 'brew',
              skills: [{ name: 'kettle:brew', source: 'user-claude', invocation: '/kettle:brew' }],
            },
          },
        ],
      },
    });
    expect(screen.getByRole('button', { name: 'brew, Plugins skill' }).textContent).toBe('brew');
  });

  it('refuses an answer with a chip and sends nothing', async () => {
    const running: Turn = { ...failedTurn, state: 'running', endedAt: null };
    const { box, sent, user } = setup({
      topics: {
        turns: [running],
        threadItems: [
          {
            id: 'ask-1',
            threadId: thread.id,
            turnId: running.id,
            index: 0,
            kind: 'question',
            payload: {
              questionId: 'question-1',
              question: 'Which kettle?',
              options: [{ label: 'Blue' }],
              multiSelect: false,
            },
            streaming: false,
          },
        ],
        questions: [
          {
            id: 'question-1',
            threadId: thread.id,
            itemId: 'ask-1',
            request: null,
            answer: null,
            answeredAt: null,
          },
        ],
      },
    });
    await user.type(box, '/tidy');
    await user.keyboard('{Enter}');
    await user.type(box, 'the blue one{Enter}');
    await screen.findByText('An answer takes no skills. Remove the chip, or answer on the card.');
    expect(sent()).toEqual([]);
  });
});

const said = (
  id: string,
  turnId: string,
  index: number,
  kind: 'user' | 'assistant_text',
): ThreadItem => ({
  id,
  threadId: thread.id,
  turnId,
  index,
  kind,
  payload: { text: `${kind} ${id}` },
  streaming: false,
});

describe('a turn stopped before this change (agent workbench spec 48, 89)', () => {
  // The line reads the turn's stored state and end time, which a turn stored before already
  // has: it was stopped, so it says so. No item, divider or marker is added to it.
  it('ends with the stopped line, and only the last turn carries Resume', () => {
    const stopped: Turn = { ...failedTurn, state: 'interrupted' };
    const later: Turn = {
      ...failedTurn,
      id: 'turn-2',
      index: 1,
      state: 'completed',
      startedAt: '2026-11-02T08:03:00.000Z',
      endedAt: '2026-11-02T08:04:00.000Z',
    };
    setup({
      topics: {
        turns: [stopped, later],
        threadItems: [
          said('a', 'turn-1', 0, 'user'),
          said('b', 'turn-1', 1, 'assistant_text'),
          said('c', 'turn-2', 2, 'user'),
          said('d', 'turn-2', 3, 'assistant_text'),
        ],
      },
    });
    const line = screen.getByTestId('turn-stopped');
    expect(line.textContent).toMatch(/^Stopped by you · /);
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });
});
