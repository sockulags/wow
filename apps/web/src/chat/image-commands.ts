import { createStore } from 'zustand';
import type { AppCommand } from '@/app/commands';

// The composer on screen that takes images (agent workbench spec 53), so the palette reaches it:
// add an image from a file, show one full size, take one off. The Assistant view's composer takes
// no images and is never here (spec 61).

export interface ActiveImageComposer {
  readonly id: string;
  // The added images' labels, in the order they are sent.
  readonly images: readonly string[];
  addFromFile(): void;
  showImage(index: number): void;
  removeImage(index: number): void;
}

interface ImageComposersState {
  readonly composers: readonly ActiveImageComposer[];
}

export const imageComposerStore = createStore<ImageComposersState>(() => ({ composers: [] }));

export function showImageComposer(composer: ActiveImageComposer): () => void {
  imageComposerStore.setState((state) => ({
    composers: [...state.composers.filter((entry) => entry.id !== composer.id), composer],
  }));
  return () =>
    imageComposerStore.setState((state) => ({
      composers: state.composers.filter((entry) => entry !== composer),
    }));
}

export const activeImageComposer = (state: ImageComposersState): ActiveImageComposer | undefined =>
  state.composers.at(-1);

export function imageComposerCommands(composer: ActiveImageComposer | undefined): AppCommand[] {
  if (!composer) return [];
  return [
    {
      id: 'composer.addImage',
      title: 'Add an image to the message…',
      group: 'Chat',
      keywords: ['image', 'picture', 'screenshot', 'attach', 'composer', 'message'],
      detail: 'Composer',
      run: () => composer.addFromFile(),
    },
    ...composer.images.flatMap((label, index): AppCommand[] => [
      {
        id: `composer.showImage.${index}`,
        title: `Show ${label} full size`,
        group: 'Chat',
        keywords: ['image', 'picture', 'composer', 'open', label],
        detail: 'Composer',
        run: () => composer.showImage(index),
      },
      {
        id: `composer.removeImage.${index}`,
        title: `Remove ${label} from the message`,
        group: 'Chat',
        keywords: ['image', 'picture', 'composer', 'remove', label],
        detail: 'Composer',
        run: () => composer.removeImage(index),
      },
    ]),
  ];
}
