import type { AppCommand } from '@/app/commands';
import type { ActiveQuestionCard } from './question-store';

// Palette commands for the question card that waits on screen (questions spec 4): go to it,
// pick each choice, write in "Other" and send. They act on the card's own state, as its keys do.
export function questionCommands(card: ActiveQuestionCard | undefined): AppCommand[] {
  if (!card) return [];
  const several = card.questions.length > 1;
  const prefix = (header: string | undefined, index: number) =>
    several ? `${header ?? `Question ${index + 1}`}: ` : '';
  return [
    {
      id: 'question.focus',
      title: 'Question: go to the card',
      group: 'Chat',
      keywords: ['question', 'answer', 'ask', 'choice'],
      keybinding: 'keybindings.questionFocus',
      detail: 'Question',
      needsYou: true,
      run: () => card.focus(),
    },
    ...card.questions.flatMap((question, index): AppCommand[] => [
      ...question.labels.map((label, choice): AppCommand => ({
        id: `question.pick.${index}.${choice}`,
        title: `Question: ${prefix(question.header, index)}pick ${label}`,
        group: 'Chat',
        keywords: ['question', 'answer', 'choice', question.question],
        detail: 'Question',
        run: () => card.pick(index, choice),
      })),
      {
        id: `question.write.${index}`,
        title: `Question: ${prefix(question.header, index)}type your own answer`,
        group: 'Chat',
        keywords: ['question', 'answer', 'other', 'text', question.question],
        detail: 'Question',
        run: () => card.write(index),
      },
    ]),
    {
      id: 'question.send',
      title: several ? 'Question: send the answers' : 'Question: send the answer',
      group: 'Chat',
      keywords: ['question', 'answer', 'submit', 'reply'],
      detail: 'Question',
      run: () => card.send(),
    },
  ];
}
