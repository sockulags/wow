import { type AskQuestionsRequest, type ThreadItem, type Turn } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { askState } from './questions';

// The assistant's questions in the Assistant view (questions-and-models plan U1, spec 9, 10).
// The view against a server is in e2e/questions.spec.ts. Invented values.

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
