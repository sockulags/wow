import { useSyncExternalStore } from 'react';

// Below this window width the mail rail folds to its count strip on its own, so the week keeps
// room (audit A-12/B-16). A layout breakpoint like Tailwind's, not a preference: the user's own
// choice is the outlook.mailRailCollapsed setting.
const NARROW_QUERY = '(max-width: 1199px)';

const query = () =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? undefined
    : window.matchMedia(NARROW_QUERY);

export function useNarrowWindow(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = query();
      list?.addEventListener('change', onChange);
      return () => list?.removeEventListener('change', onChange);
    },
    () => query()?.matches ?? false,
    () => false,
  );
}
