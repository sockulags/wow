import type { ProviderKind, ProviderModel } from '@wow/contracts';
import { createStore } from 'zustand';
import type { AppCommand } from '@/app/commands';
import { permissionOptions } from './model';
import {
  effortChoices,
  modelChoiceText,
  modelChoices,
  type ModelDefaults,
  type ThreadSettingsValue,
} from './thread-settings';

// The composer bar on screen, so the palette reaches it (agent workbench spec 6): its lists and
// the same apply its own picks use. The bar whose composer had the focus last is in front.

export interface ActiveModelBar {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly models: readonly ProviderModel[];
  readonly value: ThreadSettingsValue;
  readonly defaults: ModelDefaults | undefined;
  // The mode cannot be changed here (the Assistant view's "Read only").
  readonly modeLocked: boolean;
  apply(changes: Partial<ThreadSettingsValue>): void;
  openModels(): void;
  openEfforts(): void;
}

interface ModelBarsState {
  readonly bars: readonly ActiveModelBar[];
}

export const modelBarStore = createStore<ModelBarsState>(() => ({ bars: [] }));

export function showModelBar(bar: ActiveModelBar): () => void {
  modelBarStore.setState((state) => ({
    bars: [...state.bars.filter((entry) => entry.id !== bar.id), bar],
  }));
  return () =>
    modelBarStore.setState((state) => ({ bars: state.bars.filter((entry) => entry !== bar) }));
}

// Puts a registered bar in front, when its composer takes the focus.
export function frontModelBar(id: string): void {
  modelBarStore.setState((state) => {
    const bar = state.bars.find((entry) => entry.id === id);
    if (!bar || state.bars.at(-1) === bar) return state;
    return { bars: [...state.bars.filter((entry) => entry !== bar), bar] };
  });
}

export const activeModelBar = (state: ModelBarsState): ActiveModelBar | undefined =>
  state.bars.at(-1);

const current = (on: boolean) => (on ? 'Current' : 'Composer');

export function modelBarCommands(bar: ActiveModelBar | undefined): AppCommand[] {
  if (!bar) return [];
  const { value, kind } = bar;
  const models = modelChoices(bar.models, value.model, bar.defaults).map((choice): AppCommand => ({
    id: `modelBar.model.${choice.id}`,
    title: `Model: ${modelChoiceText(choice)}`,
    group: 'Chat',
    keywords: ['model', choice.id, choice.description],
    detail: current(choice.id === value.model),
    run: () => bar.apply({ model: choice.id }),
  }));
  const efforts = effortChoices(kind, bar.models, value.model, value.effort, bar.defaults).map(
    (choice): AppCommand => ({
      id: `modelBar.effort.${choice.id}`,
      title: `Effort: ${choice.label}${choice.isDefault ? ' (default)' : ''}`,
      group: 'Chat',
      keywords: ['effort', 'reasoning', 'thinking', choice.id],
      detail: current(choice.id === value.effort),
      run: () => bar.apply({ effort: choice.id }),
    }),
  );
  const modes = bar.modeLocked
    ? []
    : permissionOptions(kind, value.permissionMode).map((mode): AppCommand => ({
        id: `modelBar.mode.${mode.id}`,
        title: `Permission mode: ${mode.label}`,
        group: 'Chat',
        keywords: ['permission', 'mode', mode.short ?? mode.id, mode.id],
        detail: current(mode.id === value.permissionMode),
        run: () => bar.apply({ permissionMode: mode.id }),
      }));
  return [
    {
      id: 'modelBar.chooseModel',
      title: 'Choose model…',
      group: 'Chat',
      keywords: ['model', 'composer', 'bar'],
      detail: 'Composer',
      run: () => bar.openModels(),
    },
    {
      id: 'modelBar.chooseEffort',
      title: 'Choose effort…',
      group: 'Chat',
      keywords: ['effort', 'composer', 'bar'],
      detail: 'Composer',
      run: () => bar.openEfforts(),
    },
    ...models,
    ...efforts,
    ...modes,
  ];
}
