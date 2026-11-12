import type { SentImage, SkillRef } from '@wow/contracts';
import { createStore } from 'zustand';

// The composer on screen that takes skills, so the palette reaches it: open its skill list,
// remove a chip (wow skills spec 16, 17) and take a queued message back (agent workbench spec
// 52). The Assistant view's composer takes no skills and is never here (spec 20).

export interface ActiveSkillComposer {
  readonly id: string;
  // The thread whose draft it holds; absent for a composer that keeps none.
  readonly draftKey?: string | undefined;
  // The picked skills' names, in the order they are sent.
  readonly chips: readonly string[];
  openSkills(): void;
  removeSkill(index: number): void;
  putBack(
    text: string,
    skills: readonly SkillRef[],
    images?: readonly SentImage[],
    files?: readonly string[],
  ): void;
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

// A thread's own composer, so text taken off its queue goes back into its box and no other.
export const threadSkillComposer = (
  state: SkillComposersState,
  threadId: string | undefined,
): ActiveSkillComposer | undefined =>
  threadId === undefined
    ? undefined
    : state.composers.findLast((composer) => composer.draftKey === threadId);
