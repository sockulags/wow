import type { ProviderKind, SettingKey, SettingValue } from '@wow/contracts';
import {
  settingValue,
  type Connection,
  type ConnectionState,
  type SettingsState,
  type SettingsStore,
} from '@wow/client-runtime';
import { createContext, useContext, type ReactNode } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import type { DraftStore } from '@/chat/draft';

// The provider dialog that is open: the editor for a new or existing instance, or the first-run
// wizard. Palette commands open them from anywhere.
export type ProviderDialog =
  | { readonly type: 'create'; readonly kind: ProviderKind }
  | { readonly type: 'edit'; readonly providerInstanceId: string }
  | { readonly type: 'wizard' };

// The card dialog: a new card for a time range (from a click, a drag or the palette), or an
// existing card. Times are ISO instants.
export type CardDialog =
  | { readonly type: 'create'; readonly start: string; readonly end: string }
  | { readonly type: 'edit'; readonly cardId: string };

// UI-only state: which panels and dialogs are open. Everything else comes from the server (or,
// without one, from the in-memory settings source).
export interface LayoutState {
  readonly sidebarOpen: boolean;
  readonly rightPanelOpen: boolean;
  readonly paletteOpen: boolean;
  readonly providerDialog: ProviderDialog | undefined;
  readonly cardDialog: CardDialog | undefined;
}

export type LayoutStore = StoreApi<LayoutState>;

export const createLayoutStore = (): LayoutStore =>
  createStore<LayoutState>(() => ({
    sidebarOpen: true,
    rightPanelOpen: false,
    paletteOpen: false,
    providerDialog: undefined,
    cardDialog: undefined,
  }));

export interface Runtime {
  readonly settings: SettingsStore;
  readonly layout: LayoutStore;
  readonly draft: DraftStore;
  // Absent when the web app runs without a server (development, tests).
  readonly connection: Connection | undefined;
}

const RuntimeContext = createContext<Runtime | undefined>(undefined);

export function RuntimeProvider({ runtime, children }: { runtime: Runtime; children: ReactNode }) {
  return <RuntimeContext value={runtime}>{children}</RuntimeContext>;
}

export function useRuntime(): Runtime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('useRuntime needs a RuntimeProvider');
  return runtime;
}

export function useSetting<K extends SettingKey>(key: K): SettingValue<K> {
  const { settings } = useRuntime();
  return useStore(settings, (state: SettingsState) => settingValue(state.values, key));
}

export function useLayout<T>(selector: (state: LayoutState) => T): T {
  return useStore(useRuntime().layout, selector);
}

const offline: StoreApi<ConnectionState> = createStore<ConnectionState>(() => ({
  status: 'closed',
  attempts: 0,
}));

export function useConnectionState(): ConnectionState & { readonly configured: boolean } {
  const { connection } = useRuntime();
  const state = useStore(connection?.state ?? offline);
  return { ...state, configured: connection !== undefined };
}
