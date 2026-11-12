import { useEffect, useRef, useState, type FocusEvent } from 'react';
import { createStore } from 'zustand';

// The actions of the row or message that last took the keyboard focus (Copy, Copy code, Show all
// lines), so the palette can offer them as commands (keyboard first: every action in a view has
// a palette command). A row inside another, such as a code block in a message, comes first.
// Opening the palette moves the focus away, so the last row's actions stay until another row
// takes the focus, the focus moves elsewhere in the same scope, or the row goes away.

export interface RowAction {
  // Short and stable, such as "copyCode"; the palette command is `chat.<id>`.
  readonly id: string;
  readonly title: string;
  readonly keywords?: readonly string[];
  // Copies return the clipboard write, so a caller can wait for it.
  readonly run: () => unknown;
}

interface Area {
  readonly key: object;
  readonly actions: readonly RowAction[];
}

export const rowActionStore = createStore<{ readonly areas: readonly Area[] }>(() => ({
  areas: [],
}));

// A focus event already taken by a row inside: the rows around it add theirs after it.
const claimed = new WeakSet<Event>();

export const focusedRowActions = (state: { readonly areas: readonly Area[] }): RowAction[] => {
  const byId = new Map<string, RowAction>();
  for (const action of state.areas.flatMap((area) => area.actions)) {
    if (!byId.has(action.id)) byId.set(action.id, action);
  }
  return [...byId.values()];
};

// Props for the element of a row: its actions become the focused ones when the focus enters it.
// `actions` may be a new array on each render; the store follows what it says.
export function useRowActions(actions: readonly RowAction[]): {
  onFocus: (event: FocusEvent) => void;
} {
  const [key] = useState(() => ({}));
  const latest = useRef(actions);
  latest.current = actions;
  const signature = actions.map((action) => `${action.id}\u0000${action.title}`).join('\u0001');
  const stored = (): readonly RowAction[] =>
    latest.current.map((action) => ({
      ...action,
      run: (): unknown => latest.current.find((current) => current.id === action.id)?.run(),
    }));

  useEffect(() => {
    rowActionStore.setState((state) =>
      state.areas.some((area) => area.key === key)
        ? {
            areas: state.areas.map((area) =>
              area.key === key ? { key, actions: stored() } : area,
            ),
          }
        : state,
    );
    // `stored` reads the ref; the signature says when the titles changed.
  }, [key, signature]);
  useEffect(
    () => () =>
      rowActionStore.setState((state) => ({
        areas: state.areas.filter((area) => area.key !== key),
      })),
    [key],
  );

  return {
    onFocus: (event) => {
      const area = { key, actions: stored() };
      const native = event.nativeEvent;
      if (claimed.has(native)) {
        rowActionStore.setState((state) => ({ areas: [...state.areas, area] }));
      } else {
        claimed.add(native);
        rowActionStore.setState({ areas: [area] });
      }
    },
  };
}

// For the element around the rows (the conversation): focus on something in it that is no row
// leaves no row's actions offered.
export function rowActionScope(event: FocusEvent): void {
  if (!claimed.has(event.nativeEvent)) rowActionStore.setState({ areas: [] });
}
