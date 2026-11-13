import { createContext, useContext, useState } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';

// Which closed parts of a conversation are open: a tool row, a group of tool calls, reasoning, a
// subagent's list, the earlier lines of an output, a task list update. A click sets it, and so
// does find (thread work spec 4), so what find opened stays open as if opened by hand. One store
// per conversation on screen; it goes with the conversation, as the rows' own state did.

// `prompt`: a subagent's whole prompt, which shows its first four lines until find opens it.
export type OpenPart = 'row' | 'group' | 'reasoning' | 'agent' | 'prompt' | 'output' | 'tasks';

export const openKey = (part: OpenPart, itemId: string): string => `${part}:${itemId}`;

export interface OpenState {
  readonly open: Readonly<Record<string, boolean>>;
}

export type OpenStore = StoreApi<OpenState>;

export const createOpenStore = (): OpenStore => createStore<OpenState>(() => ({ open: {} }));

export function setOpen(store: OpenStore, key: string, open: boolean): void {
  store.setState((state) =>
    (state.open[key] ?? false) === open ? state : { open: { ...state.open, [key]: open } },
  );
}

export function openAll(store: OpenStore, keys: readonly string[]): void {
  const closed = keys.filter((key) => !store.getState().open[key]);
  if (closed.length === 0) return;
  store.setState((state) => ({
    open: { ...state.open, ...Object.fromEntries(closed.map((key) => [key, true])) },
  }));
}

export const OpenStoreContext = createContext<OpenStore | undefined>(undefined);

// The key of the output inside a tool row or a subagent's answer, set by the row around it.
export const OutputKeyContext = createContext<string | undefined>(undefined);

const noStore = createOpenStore();

// A part's open state: the conversation's where there is one and the part has a key, else the
// row's own (a row drawn outside a conversation, or one without an item id).
export function useOpenState(key: string | undefined): readonly [boolean, (open: boolean) => void] {
  const store = useContext(OpenStoreContext);
  const [own, setOwn] = useState(false);
  const shared = store !== undefined && key !== undefined;
  const stored = useStore(store ?? noStore, (state) =>
    shared ? (state.open[key] ?? false) : false,
  );
  if (!shared) return [own, setOwn];
  return [stored, (open: boolean) => setOpen(store, key, open)];
}
