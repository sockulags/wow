import { createStore } from 'zustand';

// The composer on screen that takes skills, so the palette reaches it: open its skill list and
// remove a chip (wow skills spec 16, 17). The Assistant view's composer takes no skills and is
// never here (spec 20).

export interface ActiveSkillComposer {
  readonly id: string;
  // The picked skills' names, in the order they are sent.
  readonly chips: readonly string[];
  openSkills(): void;
  removeSkill(index: number): void;
}

interface SkillComposersState {
  readonly composers: readonly ActiveSkillComposer[];
}

export const skillComposerStore = createStore<SkillComposersState>(() => ({ composers: [] }));

export function showSkillComposer(composer: ActiveSkillComposer): () => void {
  skillComposerStore.setState((state) => ({
    composers: [...state.composers.filter((entry) => entry.id !== composer.id), composer],
  }));
  return () =>
    skillComposerStore.setState((state) => ({
      composers: state.composers.filter((entry) => entry !== composer),
    }));
}

export const activeSkillComposer = (state: SkillComposersState): ActiveSkillComposer | undefined =>
  state.composers.at(-1);
