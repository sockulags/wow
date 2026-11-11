import { createStore } from 'zustand';

// The question cards that wait for an answer on screen, so the palette and the keybinding reach
// them (questions spec 4). A card adds itself while it can be answered and leaves when it is
// answered, closed or gone; the newest is the one the commands act on.

export interface ActiveQuestion {
  readonly header: string | undefined;
  readonly question: string;
  readonly labels: readonly string[];
}

export interface ActiveQuestionCard {
  readonly id: string;
  // The questions that can still be answered, in the card's order.
  readonly questions: readonly ActiveQuestion[];
  pick(question: number, choice: number): void;
  write(question: number): void;
  send(): void;
  focus(): void;
}

interface QuestionCardsState {
  readonly cards: readonly ActiveQuestionCard[];
}

export const questionStore = createStore<QuestionCardsState>(() => ({ cards: [] }));

export function showQuestionCard(card: ActiveQuestionCard): () => void {
  questionStore.setState((state) => ({
    cards: [...state.cards.filter((entry) => entry.id !== card.id), card],
  }));
  return () =>
    questionStore.setState((state) => ({
      cards: state.cards.filter((entry) => entry !== card),
    }));
}

export const activeQuestionCard = (state: QuestionCardsState): ActiveQuestionCard | undefined =>
  state.cards.at(-1);
