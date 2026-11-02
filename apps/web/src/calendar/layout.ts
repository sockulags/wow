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

export interface PlacedItem {
  readonly item: CalendarItem;
  // Minutes from local midnight, clipped to the day; `bottom` is 1440 for an item running past it.
  readonly top: number;
  readonly bottom: number;
  // Side-by-side placement among overlapping items: this item's lane out of `lanes`.
  readonly lane: number;
  readonly lanes: number;
}

interface Span {
  readonly item: CalendarItem;
  readonly top: number;
  readonly bottom: number;
}

function assignLanes(spans: readonly Span[]): PlacedItem[] {
  const sorted = spans.toSorted((a, b) => a.top - b.top || b.bottom - a.bottom);
  const placed: PlacedItem[] = [];
  // A cluster is a run of items that overlap each other transitively; they share a lane count.
  let cluster: { span: Span; lane: number }[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = Math.max(0, ...cluster.map((entry) => entry.lane)) + 1;
    for (const { span, lane } of cluster) placed.push({ ...span, lane, lanes });
    cluster = [];
  };
  for (const span of sorted) {
    if (span.top >= clusterEnd) {
      flush();
      clusterEnd = -1;
    }
    const taken = new Set(
      cluster.filter((entry) => entry.span.bottom > span.top).map((entry) => entry.lane),
    );
    let lane = 0;
    while (taken.has(lane)) lane += 1;
    cluster.push({ span, lane });
    clusterEnd = Math.max(clusterEnd, span.bottom);
  }
  flush();
  return placed;
}

// Timed items that overlap the local day, placed by their wall-clock times in `zone`.
export function placeTimedItems(
  items: readonly CalendarItem[],
  day: LocalDate,
  zone: string,
): PlacedItem[] {
  const dayStart = startOfDay(day, zone).getTime();
  const dayEnd = startOfDay(addDays(day, 1), zone).getTime();
  const spans: Span[] = [];
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
  return assignLanes(spans);
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
