import { AskQuestionsRequest, assistantAskTool, assistantToolOf } from './assistant.js';
import { ToolCallItemPayload, type ThreadItem } from './projections.js';
import { replyText, type QuestionReply } from './questions.js';

// The questions the assistant asked with its tool (questions spec 9), read from the tool call
// in its thread: only a call the server answered with "asked" counts, so the server and the
// Assistant view agree on what can be answered.
export function askedQuestionsOf(item: ThreadItem): AskQuestionsRequest | null {
  if (item.kind !== 'tool_call') return null;
  const payload = ToolCallItemPayload.safeParse(item.payload);
  if (!payload.success || payload.data.status !== 'ok') return null;
  if (assistantToolOf(payload.data.name) !== assistantAskTool) return null;
  let output: unknown;
  try {
    output = JSON.parse(payload.data.output);
  } catch {
    return null;
  }
  if (
    typeof output !== 'object' ||
    output === null ||
    (output as { outcome?: unknown }).outcome !== 'asked'
  ) {
    return null;
  }
  return AskQuestionsRequest.safeParse(payload.data.input).data ?? null;
}

// The answer as the user's message: one line per question.
export const askAnswerText = (
  request: AskQuestionsRequest,
  replies: readonly QuestionReply[],
): string =>
  request.questions
    .map((question, index) => {
      const reply = replies[index];
      return `${question.header}: ${reply ? replyText(reply) : ''}`;
    })
    .join('\n');

// What the assistant reads: the questions it asked and the answers, marked as coming from the
// card.
export const askAnswerPrompt = (
  request: AskQuestionsRequest,
  replies: readonly QuestionReply[],
): string =>
  [
    `[From wow] The user answered your questions (${assistantAskTool}) on the card:`,
    ...request.questions.map((question, index) => {
      const reply = replies[index] ?? { picked: [], text: '' };
      const picked = reply.picked.length > 0 ? `picked ${reply.picked.join(', ')}` : '';
      const typed = reply.text.trim() === '' ? '' : `typed "${reply.text.trim()}"`;
      return `- ${question.question} (${question.header}): ${[picked, typed].filter(Boolean).join('; ')}`;
    }),
  ].join('\n');
