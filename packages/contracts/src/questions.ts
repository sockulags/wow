import { z } from 'zod';

// The question card (intent 2026-11-questions-and-models, spec 1 to 5): one shape for a question
// a provider's agent asks and one the assistant asks, and one shape for the answer. Every
// question also takes typed text, shown as a last choice "Other".

export const QuestionOption = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
  // The asker recommends it: the card lists it first and marks it.
  recommended: z.boolean().optional(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

// What the user answered to one question: the labels of the picked choices, in the order the
// card lists them, and the typed text ('' when none).
export const QuestionReply = z.object({
  picked: z.array(z.string().min(1)),
  text: z.string(),
});
export type QuestionReply = z.infer<typeof QuestionReply>;

export const isEmptyReply = (reply: QuestionReply): boolean =>
  reply.picked.length === 0 && reply.text.trim() === '';

// The answer as one line, for a provider that takes text and for the conversation: the picked
// labels, then the typed text.
export const replyText = (reply: QuestionReply): string =>
  [...reply.picked, reply.text.trim()].filter((part) => part !== '').join(', ');

// Claude Code and Codex mark a recommended choice by ending its label with "(Recommended)".
// The label stays as the provider wrote it, because the answer has to name it exactly.
const recommendedSuffix = /\s*\(recommended\)\s*$/i;

export const markRecommended = (option: QuestionOption): QuestionOption =>
  recommendedSuffix.test(option.label) ? { ...option, recommended: true } : option;

// The label without the provider's "(Recommended)", for the card, which marks it on its own.
export const shownLabel = (label: string): string =>
  label.replace(recommendedSuffix, '').trim() || label;

// The choices in the order the card shows them: recommended ones first, otherwise as asked.
export const cardOrder = <T extends QuestionOption>(options: readonly T[]): T[] => [
  ...options.filter((option) => option.recommended === true),
  ...options.filter((option) => option.recommended !== true),
];

// Why an answer cannot be sent for a question, or null when it can.
export function replyProblem(
  question: { readonly options: readonly QuestionOption[]; readonly multiSelect: boolean },
  reply: QuestionReply,
): string | null {
  if (isEmptyReply(reply)) return 'Pick a choice or type an answer.';
  const labels = new Set(question.options.map((option) => option.label));
  const unknown = reply.picked.find((label) => !labels.has(label));
  if (unknown !== undefined) return `"${unknown}" is not one of the choices.`;
  if (new Set(reply.picked).size !== reply.picked.length) return 'A choice is picked twice.';
  if (!question.multiSelect && reply.picked.length > 1) return 'Only one choice can be picked.';
  return null;
}

// A question the assistant asks with its tool (spec 9): the same parts a provider's question
// has.
export const AskedQuestion = z
  .object({
    question: z.string().trim().min(1),
    // A word or two, shown as a chip above the question.
    header: z.string().trim().min(1),
    options: z.array(QuestionOption.strict()),
    multiSelect: z.boolean().default(false),
  })
  .strict();
export type AskedQuestion = z.infer<typeof AskedQuestion>;
