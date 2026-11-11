import {
  TextItemPayload,
  assistantThreadId,
  type AskQuestionsRequest,
  type QuestionReply,
  type ThreadItem,
  type Turn,
} from '@wow/contracts';
import type { ReactNode } from 'react';
import { useDispatch } from '@/chat/data';
import { QuestionCard, type CardQuestion, type HoldControls } from '@/chat/question-card';
import type { Held } from './model';

// The assistant's questions (questions spec 9, 10): the card under the tool call that asked
// them. They are answered by the user's next message, which the card sends; any other message
// first, and they can no longer be answered. A typed answer that looks like a secret is held
// the way a typed message is.

export type AskState =
  | { readonly kind: 'open'; readonly waiting: boolean }
  | { readonly kind: 'answered'; readonly replies: readonly QuestionReply[] }
  | { readonly kind: 'closed'; readonly stopped?: boolean };

// What the conversation says about one ask: the user message that answered it, else whether a
// message came after it, else whether the assistant's turn still runs.
export function askState(
  item: ThreadItem,
  items: readonly ThreadItem[],
  turns: readonly Turn[],
): AskState {
  const later = items.filter((entry) => entry.kind === 'user' && entry.index > item.index);
  for (const entry of later) {
    const payload = TextItemPayload.safeParse(entry.payload);
    if (payload.success && payload.data.answers?.askItemId === item.id) {
      return { kind: 'answered', replies: payload.data.answers.replies };
    }
  }
  if (later.length > 0) return { kind: 'closed' };
  const turn = turns.find((entry) => entry.id === item.turnId);
  // A stopped turn's questions take no answer (spec 5).
  if (turn?.state === 'interrupted') return { kind: 'closed', stopped: true };
  return { kind: 'open', waiting: turn?.state === 'running' };
}

export function AssistantQuestions({
  item,
  request,
  state,
  check,
  renderHold,
}: {
  item: ThreadItem;
  request: AskQuestionsRequest;
  state: AskState;
  check(replies: ReadonlyMap<string, QuestionReply>): Held | null;
  renderHold(held: Held, controls: HoldControls): ReactNode;
}) {
  const send = useDispatch();
  const questions: CardQuestion[] = request.questions.map((question, index) => ({
    key: String(index),
    question: question.question,
    header: question.header,
    options: question.options,
    multiSelect: question.multiSelect,
    status:
      state.kind === 'answered'
        ? { kind: 'answered', reply: state.replies[index] ?? { picked: [], text: '' } }
        : state.kind === 'closed'
          ? { kind: 'closed' }
          : { kind: 'open' },
  }));
  return (
    <QuestionCard
      id={item.id}
      questions={questions}
      closedReason={
        state.kind === 'closed' && state.stopped
          ? 'the turn was stopped before an answer was sent.'
          : 'a message was sent before an answer.'
      }
      waitReason={
        state.kind === 'open' && state.waiting
          ? 'Answer when the assistant has finished its turn.'
          : undefined
      }
      onSend={(replies) =>
        send({
          type: 'thread.answerQuestions',
          threadId: assistantThreadId,
          itemId: item.id,
          replies: request.questions.map(
            (_, index) => replies.get(String(index)) ?? { picked: [], text: '' },
          ),
        })
      }
      check={check}
      renderHold={renderHold}
    />
  );
}
