import type {
  FileScope,
  HostItemRef,
  ProviderKind,
  SettingKey,
  SettingValue,
  UpdateState,
} from '@wow/contracts';
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
// existing card. Times are ISO instants. An edit opened from one occurrence of a repeating card
// names its day, so Delete can offer "This occurrence"; `deleting` opens it at that choice.
export type CardDialog =
  | { readonly type: 'create'; readonly start: string; readonly end: string }
  | {
      readonly type: 'edit';
      readonly cardId: string;
      readonly date?: string;
      readonly deleting?: boolean;
    };

// A file open in a tab of the context panel (review loop spec 6, agent workbench spec 11). `from`
// is the route it was opened on: its tabs belong to that view (a thread, a run) and come back
// with it.
export interface ViewerFile {
  // Whose folders it is read from: a run's, a thread's or a project's.
  readonly scope: FileScope;
  // As it was named: relative to the scope's folder, with forward slashes, or a full path.
  readonly path: string;
  // The full path as the client names it, for "Copy path" until the server has answered.
  readonly fullPath: string;
  // What the server read, once it has: the kind it is shown as and the path it resolved.
  readonly read:
    | { readonly kind: 'markdown' | 'html' | 'text' | 'image'; readonly absolutePath: string }
    | undefined;
  readonly from: string;
  // A picture at its own size instead of fitted to the panel.
  readonly fullSize: boolean;
}

// A linked Confluence page in a tab of the context panel (review loop spec 35), by the run and
// the link's `ref`. The page itself is the server's last read of it.
export interface ViewerPage {
  readonly runId: string;
  readonly ref: string;
  readonly from: string;
}

// An item a chat thread links to on one of the user's hosts (agent workbench spec 21): a pull or
// merge request, an issue, a ticket or a page. What it shows is the thread's stored read of it.
export interface ViewerHostItem {
  readonly threadId: string;
  readonly item: HostItemRef;
  readonly from: string;
}

// A chat thread's Changes (agent workbench spec 34) as a tab of the thread's panel.
export interface ViewerChanges {
  readonly threadId: string;
  readonly from: string;
}

export type PanelTab =
  | { readonly kind: 'file'; readonly id: string; readonly file: ViewerFile }
  | { readonly kind: 'page'; readonly id: string; readonly page: ViewerPage }
  | { readonly kind: 'host'; readonly id: string; readonly host: ViewerHostItem }
  | { readonly kind: 'changes'; readonly id: string; readonly changes: ViewerChanges };

// The tabs of one view's panel (agent workbench spec 11 to 14). The panel's own body (Details,
// or a run's conversation) is the tab `DETAILS_TAB`, always first and never closed.
export interface PanelTabs {
  readonly tabs: readonly PanelTab[];
  readonly selected: string;
  // The tabs shown before, latest last, for "Back".
  readonly history: readonly string[];
}

export const DETAILS_TAB = 'details';

// "Open file…": the files of a thread's or run's folder to pick from (agent workbench spec 18).
export interface OpenFileDialog {
  readonly scope: FileScope;
  // The folder the paths are relative to, for the full path of the pick.
  readonly folder: string;
  readonly from: string;
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
  // Panel tabs per route (agent workbench spec 13): a thread or a run keeps its own.
  readonly panelTabs: Readonly<Record<string, PanelTabs>>;
  readonly openFileDialog: OpenFileDialog | undefined;
  // "Open issue, PR or ticket…" (agent workbench spec 25): the thread whose hosts it reads.
  readonly openHostDialog: { readonly threadId: string; readonly from: string } | undefined;
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
    panelTabs: {},
    openFileDialog: undefined,
    openHostDialog: undefined,
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
