import {
  defaultSecretPatterns,
  type AskQuestionsRequest,
  type Command,
  type Thread,
  type ThreadItem,
  type Turn,
} from '@wow/contracts';
import { type Connection, type ConnectionState } from '@wow/client-runtime';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand';
import { RuntimeProvider } from '@/app/runtime';
import { ChatQuestions } from '@/chat/items';
import { ThreadConversation } from '@/chat/thread-view';
import type { QuestionHold } from '@/chat/question-card';
import { createTestRuntime } from '@/test/render';
import { HeldLine } from './assistant-view';
import { holdMessage, type Held } from './model';
import { AssistantQuestions, askState } from './questions';

// The assistant's questions in the Assistant view (questions-and-models plan U1, spec 9, 10).
// The view against a server is in e2e/questions.spec.ts. Invented values.

const githubToken = 'ghp_abcdefghijklmnopqrstuvwxyz012345';

const request: AskQuestionsRequest = {
  questions: [
    {
      question: 'Which repository should the reviews read?',
      header: 'Repository',
      options: [{ label: 'tea-timer', recommended: true }, { label: 'kettle' }],
      multiSelect: false,
    },
  ],
};

const item = (id: string, index: number, kind: ThreadItem['kind'], payload: unknown, turn = 0) =>
  ({
    id,
    threadId: 'assistant',
    turnId: `assistant:turn:${turn}`,
    index,
    kind,
    payload,
    streaming: false,
  }) satisfies ThreadItem;

const ask = item('ask', 1, 'tool_call', {
  name: 'mcp__wow__ask_questions',
  input: request,
  output: '{"outcome":"asked"}',
  status: 'ok',
});

const turn = (index: number, state: Turn['state']): Turn => ({
  id: `assistant:turn:${index}`,
  threadId: 'assistant',
  index,
  state,
  startedAt: '2026-11-10T08:00:00.000Z',
  endedAt: state === 'running' ? null : '2026-11-10T08:00:01.000Z',
  usage: null,
});

describe('where the assistant asked (spec 9)', () => {
  it('is open after its turn, answered by the message that answers it, closed by any other message', () => {
    expect(askState(ask, [ask], [turn(0, 'running')])).toEqual({ kind: 'open', waiting: true });
    expect(askState(ask, [ask], [turn(0, 'completed')])).toEqual({ kind: 'open', waiting: false });
    const replies = [{ picked: ['kettle'], text: '' }];
    const answer = item(
      'answer',
      2,
      'user',
      { text: 'Repository: kettle', answers: { askItemId: 'ask', replies } },
      1,
    );
    expect(askState(ask, [ask, answer], [turn(0, 'completed'), turn(1, 'running')])).toEqual({
      kind: 'answered',
      replies,
    });
    const other = item('other', 2, 'user', { text: 'Never mind' }, 1);
    expect(askState(ask, [ask, other], [turn(0, 'completed')])).toEqual({ kind: 'closed' });
    // A stopped turn's questions take no answer (spec 5).
    expect(askState(ask, [ask], [turn(0, 'interrupted')])).toEqual({
      kind: 'closed',
      stopped: true,
    });
  });
});

describe('a typed answer that looks like a secret (spec 10)', () => {
  it('is held with the same choices as a typed message, and Send anyway sends it', async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    const runtime = createTestRuntime();
    render(
      <RuntimeProvider
        runtime={{
          ...runtime,
          connection: {
            request: (method: string, params: unknown) => {
              sent.push({ method, params });
              return Promise.resolve({ seqs: [] });
            },
            subscribe: () => () => undefined,
          } as never,
        }}
      >
        <AssistantQuestions
          item={ask}
          request={request}
          state={{ kind: 'open', waiting: false }}
          check={(replies) => {
            for (const reply of replies.values()) {
              const held = holdMessage(reply.text, defaultSecretPatterns, []);
              if (held) return held;
            }
            return null;
          }}
          renderHold={(held, controls) => (
            <HeldLine
              held={held}
              onPut={undefined}
              onSend={controls.sendAnyway}
              onDismiss={controls.dismiss}
            />
          )}
        />
      </RuntimeProvider>,
    );
    await user.type(screen.getByRole('textbox', { name: 'Other' }), `use ${githubToken}{Enter}`);
    expect(screen.getByTestId('held-message').textContent).toContain('Send anyway');
    expect(sent).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByTestId('held-message')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Send answer' }));
    await user.click(screen.getByRole('button', { name: 'Send anyway' }));
    expect(JSON.stringify(sent)).toContain('"type":"thread.answerQuestions"');
    expect(JSON.stringify(sent)).toContain(`"text":"use ${githubToken}"`);
  });

  it("is held the same way on an agent's question card in the Assistant conversation", async () => {
    const user = userEvent.setup();
    const sent: unknown[] = [];
    const runtime = createTestRuntime();
    const hold: QuestionHold<Held> = {
      check: (replies) => {
        for (const reply of replies.values()) {
          const held = holdMessage(reply.text, defaultSecretPatterns, []);
          if (held) return held;
        }
        return null;
      },
      render: (held, controls) => (
        <HeldLine
          held={held}
          onPut={undefined}
          onSend={controls.sendAnyway}
          onDismiss={controls.dismiss}
        />
      ),
    };
    const asked = item(
      'provider-question',
      1,
      'question',
      {
        questionId: 'assistant:q1',
        question: 'Which kettle?',
        options: [{ label: 'Glass kettle' }],
        multiSelect: false,
      },
      0,
    );
    render(
      <RuntimeProvider
        runtime={{
          ...runtime,
          connection: {
            request: (method: string, params: unknown) => {
              sent.push({ method, params });
              return Promise.resolve({ seqs: [] });
            },
            subscribe: () => () => undefined,
          } as never,
        }}
      >
        <ChatQuestions
          items={[asked]}
          questions={[
            {
              id: 'assistant:q1',
              threadId: 'assistant',
              itemId: 'provider-question',
              request: {},
              answer: null,
              answeredAt: null,
            },
          ]}
          turnEnded={false}
          hold={hold}
        />
      </RuntimeProvider>,
    );
    await user.type(screen.getByRole('textbox', { name: 'Other' }), `use ${githubToken}{Enter}`);
    expect(screen.getByTestId('held-message').textContent).toContain('Send anyway');
    expect(sent).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Send anyway' }));
    expect(JSON.stringify(sent)).toContain('"type":"question.answer"');
  });

  it('is held on a lone agent question drawn in the Assistant conversation', async () => {
    const user = userEvent.setup();
    const sent: Command[] = [];
    const asked = item('lone-question', 1, 'question', {
      questionId: 'assistant:q2',
      question: 'Which kettle?',
      options: [{ label: 'Glass kettle' }],
      multiSelect: false,
    });
    const thread: Thread = {
      id: 'assistant',
      projectId: null,
      cwd: '/home/tea/assistant',
      branch: null,
      providerInstanceId: 'claude-home',
      providerSessionId: null,
      title: 'Assistant',
      model: '',
      effort: '',
      permissionMode: 'default',
      state: 'needs_you',
      pinned: false,
      runId: null,
      stepId: null,
      createdAt: '2026-11-10T08:00:00.000Z',
      updatedAt: '2026-11-10T08:00:00.000Z',
    };
    const topics: Readonly<Record<string, unknown[]>> = {
      turns: [turn(0, 'running')],
      threadItems: [asked],
      questions: [
        {
          id: 'assistant:q2',
          threadId: 'assistant',
          itemId: 'lone-question',
          request: {},
          answer: null,
          answeredAt: null,
        },
      ],
    };
    const connection: Connection = {
      state: createStore<ConnectionState>(() => ({ status: 'open', attempts: 0 })),
      request(method, params) {
        if (method !== 'dispatch') return Promise.resolve([]);
        const { command, commandId } = params as { command: Command; commandId: string };
        sent.push(command);
        return Promise.resolve({ commandId, seqs: [sent.length], duplicate: false });
      },
      subscribe(topic, _params, onData) {
        onData(topics[topic] ?? []);
        return () => undefined;
      },
      retry: () => undefined,
      close: () => undefined,
    };
    const hold: QuestionHold<Held> = {
      check: (replies) => {
        for (const reply of replies.values()) {
          const held = holdMessage(reply.text, defaultSecretPatterns, []);
          if (held) return held;
        }
        return null;
      },
      render: (held, controls) => (
        <HeldLine
          held={held}
          onPut={undefined}
          onSend={controls.sendAnyway}
          onDismiss={controls.dismiss}
        />
      ),
    };
    render(
      <RuntimeProvider runtime={{ ...createTestRuntime(), connection }}>
        <ThreadConversation thread={thread} instance={undefined} extras={{ questionHold: hold }} />
      </RuntimeProvider>,
    );
    await user.type(
      await screen.findByRole('textbox', { name: 'Other' }),
      `use ${githubToken}{Enter}`,
    );
    expect(screen.getByTestId('held-message').textContent).toContain('Send anyway');
    expect(sent).toEqual([]);
  });
});
