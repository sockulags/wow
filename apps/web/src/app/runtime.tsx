import type { ProviderKind, SettingKey, SettingValue, UpdateState } from '@wow/contracts';
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
import type { UpdatesClient } from './updates';

// The provider dialog that is open: the editor for a new or existing instance, or the first-run
// wizard. Palette commands open them from anywhere.
export type ProviderDialog =
  | { readonly type: 'create'; readonly kind: ProviderKind }
  | { readonly type: 'edit'; readonly providerInstanceId: string }
  | { readonly type: 'wizard' };

// The project dialog: a new project, importing folders Claude and Codex worked in, or renaming
// or removing one. Palette commands open them.
export type ProjectDialog =
  | { readonly type: 'create' }
  | { readonly type: 'import' }
  | { readonly type: 'rename'; readonly projectId: string }
  | { readonly type: 'remove'; readonly projectId: string };

// The card dialog: a new card for a time range (from a click, a drag or the palette), or an
// existing card. Times are ISO instants.
export type CardDialog =
  | { readonly type: 'create'; readonly start: string; readonly end: string }
  | { readonly type: 'edit'; readonly cardId: string };

// The file the context panel shows in place of the conversation (review loop spec 6). `from` is
// the route it was opened on: the viewer belongs to that view and is gone on any other.
export interface ViewerFile {
  readonly runId: string;
  // As the run names it: relative to its folder, with forward slashes.
  readonly path: string;
  // The full path, for "Copy path".
  readonly fullPath: string;
  readonly from: string;
  // A picture at its own size instead of fitted to the panel.
  readonly fullSize: boolean;
}

// UI-only state: which panels and dialogs are open. Everything else comes from the server (or,
// without one, from the in-memory settings source).
export interface LayoutState {
  readonly sidebarOpen: boolean;
  // The context panel opened over the view in a narrow window, where it does not take room and
  // the appearance.contextPanel setting does not apply. Folds away again on its own.
  readonly contextPanelPeek: boolean;
  // Set by "Focus context panel" when the panel still has to open; the panel takes the focus once
  // it is there and clears it.
  readonly contextPanelFocus: boolean;
  readonly viewer: ViewerFile | undefined;
  readonly paletteOpen: boolean;
  readonly providerDialog: ProviderDialog | undefined;
  readonly projectDialog: ProjectDialog | undefined;
  readonly cardDialog: CardDialog | undefined;
}

export type LayoutStore = StoreApi<LayoutState>;

export const createLayoutStore = (): LayoutStore =>
  createStore<LayoutState>(() => ({
    sidebarOpen: true,
    contextPanelPeek: false,
    contextPanelFocus: false,
    viewer: undefined,
    paletteOpen: false,
    providerDialog: undefined,
    projectDialog: undefined,
    cardDialog: undefined,
  }));

export interface Runtime {
  readonly settings: SettingsStore;
  readonly layout: LayoutStore;
  readonly draft: DraftStore;
  // Absent when the web app runs without a server (development, tests).
  readonly connection: Connection | undefined;
  // Present only inside the desktop app, which owns the update state.
  readonly updates?: UpdatesClient | undefined;
  // The desktop's native folder dialog: the chosen folder, or null when cancelled. Absent in the
  // browser build, where a folder is typed instead.
  readonly pickFolder?: (() => Promise<string | null>) | undefined;
  // The desktop's "Restart now" for settings marked restartRequired. Absent in the browser build.
  readonly restartApp?: (() => void) | undefined;
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

const noUpdates: StoreApi<UpdateState | undefined> = createStore<UpdateState | undefined>(
  () => undefined,
);

// The desktop's update state, undefined outside the desktop app.
export function useUpdateState(): UpdateState | undefined {
  return useStore(useRuntime().updates?.store ?? noUpdates);
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
