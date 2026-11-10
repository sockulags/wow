import { useSyncExternalStore } from 'react';

// Window widths where the layout changes, like Tailwind's breakpoints: layout facts, not
// preferences. The user's own choices are settings (appearance.contextPanel); below `narrow` the
// context panel stops taking room from the view and opens over it instead (audit A-12).
export const breakpoints = {
  narrow: 1200,
} as const;

export type Breakpoint = keyof typeof breakpoints;

const queryFor = (breakpoint: Breakpoint) => `(max-width: ${breakpoints[breakpoint] - 1}px)`;

const mediaQuery = (breakpoint: Breakpoint): MediaQueryList | undefined =>
  typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? undefined
    : window.matchMedia(queryFor(breakpoint));

// Whether the window is narrower than the breakpoint right now, for code that runs outside React
// (palette commands).
export const isBelow = (breakpoint: Breakpoint): boolean =>
  mediaQuery(breakpoint)?.matches ?? false;

// The same, kept current while the window is resized.
export function useBelow(breakpoint: Breakpoint): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = mediaQuery(breakpoint);
      list?.addEventListener('change', onChange);
      return () => list?.removeEventListener('change', onChange);
    },
    () => isBelow(breakpoint),
    () => false,
  );
}
