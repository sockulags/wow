import { addDays, atMinute, localDate, minuteOfDay, MINUTES_PER_DAY } from './time';

// Keyboard navigation inside the time grid (audit B-07). The grid is one Tab stop with roving
// focus: arrow keys move between items, Enter opens one, and Alt with the arrows moves or resizes
// a card. These are the standard grid keys (WAI-ARIA), so they are not keybindings settings.

// One focusable thing in the grid: an item in a day column, or a "+N" chip. `key` is unique even
// for an item that spans two days, so focus lands in the column it was moved in.
export interface GridStop {
  readonly key: string;
  readonly dayIndex: number;
  readonly top: number;
}

export const stopKey = (dayIndex: number, id: string): string => `${dayIndex}:${id}`;

export type GridMove = 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'first' | 'last';

export function gridMove(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}): GridMove | undefined {
  if (event.altKey || event.shiftKey) return undefined;
  const mod = event.ctrlKey || event.metaKey;
  switch (event.key) {
    case 'ArrowUp':
      return mod ? undefined : 'up';
    case 'ArrowDown':
      return mod ? undefined : 'down';
    case 'ArrowLeft':
      return mod ? undefined : 'left';
    case 'ArrowRight':
      return mod ? undefined : 'right';
    case 'Home':
      return mod ? 'first' : 'home';
    case 'End':
      return mod ? 'last' : 'end';
    default:
      return undefined;
  }
}

// Stops are in render order: by day, then by start. Left and right go to the nearest day that has
// items and pick the item closest in time; the others stay within the day or the whole range.
export function nextStop(
  stops: readonly GridStop[],
  current: string | undefined,
  move: GridMove,
): string | undefined {
  const at = stops.find((stop) => stop.key === current);
  if (!at) return stops[0]?.key;
  const sameDay = stops.filter((stop) => stop.dayIndex === at.dayIndex);
  const index = sameDay.indexOf(at);
  switch (move) {
    case 'up':
      return (sameDay[index - 1] ?? at).key;
    case 'down':
      return (sameDay[index + 1] ?? at).key;
    case 'home':
      return (sameDay[0] ?? at).key;
    case 'end':
      return (sameDay.at(-1) ?? at).key;
    case 'first':
      return (stops[0] ?? at).key;
    case 'last':
      return (stops.at(-1) ?? at).key;
    case 'left':
    case 'right': {
      const days = [...new Set(stops.map((stop) => stop.dayIndex))].toSorted((a, b) => a - b);
      const target =
        move === 'left'
          ? days.filter((day) => day < at.dayIndex).at(-1)
          : days.find((day) => day > at.dayIndex);
      if (target === undefined) return at.key;
      const candidates = stops.filter((stop) => stop.dayIndex === target);
      const nearest = candidates.reduce((best, stop) =>
        Math.abs(stop.top - at.top) < Math.abs(best.top - at.top) ? stop : best,
      );
      return nearest.key;
    }
  }
}

export type CardKeyChange =
  | { readonly kind: 'move'; readonly minutes: number; readonly days: number }
  | { readonly kind: 'resize'; readonly minutes: number };

// Alt+Up/Down moves a card by the snap step, Alt+Left/Right by a day, and Alt+Shift+Up/Down
// moves its end.
export function cardKeyChange(
  event: { readonly key: string; readonly altKey: boolean; readonly shiftKey: boolean },
  snap: number,
): CardKeyChange | undefined {
  if (!event.altKey) return undefined;
  const vertical = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
  const horizontal = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
  if (event.shiftKey) {
    return vertical === 0 ? undefined : { kind: 'resize', minutes: vertical * snap };
  }
  if (vertical !== 0) return { kind: 'move', minutes: vertical * snap, days: 0 };
  if (horizontal !== 0) return { kind: 'move', minutes: 0, days: horizontal };
  return undefined;
}

// The card's new instants. A move keeps its length and wall-clock start (a day move lands on the
// same clock time across a DST change); a resize never goes below one snap step.
export function applyCardKey(
  card: { readonly start: string; readonly end: string },
  change: CardKeyChange,
  zone: string,
  snap: number,
): { start: string; end: string } {
  const start = new Date(card.start);
  const end = new Date(card.end);
  if (change.kind === 'resize') {
    const next = end.getTime() + change.minutes * 60_000;
    const shortest = start.getTime() + snap * 60_000;
    return { start: card.start, end: new Date(Math.max(next, shortest)).toISOString() };
  }
  const length = end.getTime() - start.getTime();
  const day = addDays(localDate(start, zone), change.days);
  const minute = minuteOfDay(start, zone) + change.minutes;
  // Past midnight moves into the neighboring day; atMinute rolls minutes over 24:00.
  const dayShift = Math.floor(minute / MINUTES_PER_DAY);
  const moved = atMinute(addDays(day, dayShift), minute - dayShift * MINUTES_PER_DAY, zone);
  return {
    start: moved.toISOString(),
    end: new Date(moved.getTime() + length).toISOString(),
  };
}
