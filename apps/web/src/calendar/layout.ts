import type { CalendarItem, Weekday, WorkHours } from '@wow/contracts';
import {
  addDays,
  MINUTES_PER_DAY,
  minuteOfDay,
  parseClockTime,
  startOfDay,
  startOfWeek,
  weekdayOf,
  type LocalDate,
} from './time';
import { layoutColumns, type ColumnPlacement } from './overlap';

export type CalendarViewKind = 'day' | 'week';

export function visibleDays(
  view: CalendarViewKind,
  anchor: LocalDate,
  firstDay: Weekday,
): LocalDate[] {
  if (view === 'day') return [anchor];
  const first = startOfWeek(anchor, firstDay);
  return Array.from({ length: 7 }, (_, index) => addDays(first, index));
}

// Where "next" and "previous" go: one day in day view, one week in week view.
export const stepDays = (view: CalendarViewKind): number => (view === 'day' ? 1 : 7);

export interface PlacedItem extends ColumnPlacement {
  readonly item: CalendarItem;
  // Minutes from local midnight, clipped to the day; `bottom` is 1440 for an item running past it.
  readonly top: number;
  readonly bottom: number;
}

// Timed items that overlap the local day, placed by their wall-clock times in `zone` and side by
// side where they overlap (`layoutColumns`). `minMinutes` is the shortest length a block is drawn
// with at the current zoom.
export function placeTimedItems(
  items: readonly CalendarItem[],
  day: LocalDate,
  zone: string,
  minMinutes = 0,
): PlacedItem[] {
  const dayStart = startOfDay(day, zone).getTime();
  const dayEnd = startOfDay(addDays(day, 1), zone).getTime();
  const spans: { item: CalendarItem; top: number; bottom: number }[] = [];
  for (const item of items) {
    if (item.allDay) continue;
    const start = Date.parse(item.start);
    const end = Date.parse(item.end);
    if (start >= dayEnd || end <= dayStart) continue;
    const top = start <= dayStart ? 0 : minuteOfDay(new Date(start), zone);
    const wallBottom = end >= dayEnd ? MINUTES_PER_DAY : minuteOfDay(new Date(end), zone);
    // On the night the clocks go back an item can end at an earlier wall-clock time than it
    // started; it then keeps its real length.
    const bottom =
      wallBottom > top ? wallBottom : Math.min(MINUTES_PER_DAY, top + (end - start) / 60_000);
    spans.push({ item, top, bottom });
  }
  return layoutColumns(spans, minMinutes);
}

export function allDayItemsOn(
  items: readonly CalendarItem[],
  day: LocalDate,
  zone: string,
): CalendarItem[] {
  const dayStart = startOfDay(day, zone).getTime();
  const dayEnd = startOfDay(addDays(day, 1), zone).getTime();
  return items.filter(
    (item) => item.allDay && Date.parse(item.start) < dayEnd && Date.parse(item.end) > dayStart,
  );
}

// The highlighted part of a day, in minutes from midnight, or undefined off work days.
export function workSpan(
  hours: WorkHours,
  day: LocalDate,
): { readonly top: number; readonly bottom: number } | undefined {
  if (!hours.days.includes(weekdayOf(day))) return undefined;
  const top = parseClockTime(hours.start);
  const bottom = parseClockTime(hours.end);
  return top === undefined || bottom === undefined ? undefined : { top, bottom };
}

export const snapMinute = (minute: number, snap: number): number =>
  Math.min(MINUTES_PER_DAY, Math.max(0, Math.round(minute / snap) * snap));
