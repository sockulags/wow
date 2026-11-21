import {
  MINUTES_PER_DAY,
  addDays,
  atMinute,
  clockTime,
  isoDate,
  localDate,
  minuteOfDay,
  parseClockTime,
  weekdayOf,
  type LocalDate,
} from './clock.js';
import type { CalendarItem } from './projections.js';
import type { WorkHours } from './settings.js';

// Free time in the calendar, the same for the plan dialog and the server: what is busy, the next
// gap of a length, and every gap of a length in a range.

// The next whole hour in the zone, as a date and a clock time for the dialog.
export function nextHour(
  now: Date,
  zone: string,
): { readonly date: string; readonly start: string } {
  const today = localDate(now, zone);
  const hour = Math.floor(minuteOfDay(now, zone) / 60) + 1;
  return hour >= 24
    ? { date: isoDate(addDays(today, 1)), start: clockTime(0) }
    : { date: isoDate(today), start: clockTime(hour * 60) };
}

export interface Busy {
  readonly title: string;
  readonly start: number;
  readonly end: number;
}

// What already fills the calendar: Outlook meetings and local cards, not cancelled or all day.
export function busyTimes(items: readonly CalendarItem[]): Busy[] {
  return items
    .filter((item) => !item.allDay && item.state !== 'cancelled')
    .map((item) => ({
      title: item.title || 'Untitled',
      start: new Date(item.start).getTime(),
      end: new Date(item.end).getTime(),
    }))
    .toSorted((a, b) => a.start - b.start);
}

export const overlaps = (busy: readonly Busy[], start: number, end: number): Busy[] =>
  busy.filter((entry) => entry.start < end && entry.end > start);

// The first gap of `minutes` within work hours, from now on, on a snap boundary, for as many
// days ahead as the calendar looks (audit D-10). Falls back to the next whole hour.
export function nextFreeSlot({
  now,
  zone,
  workHours,
  busy,
  minutes,
  snapMinutes,
  days,
}: {
  readonly now: Date;
  readonly zone: string;
  readonly workHours: WorkHours;
  readonly busy: readonly Busy[];
  readonly minutes: number;
  readonly snapMinutes: number;
  readonly days: number;
}): { readonly date: string; readonly start: string; readonly end: string } {
  const workStart = parseClockTime(workHours.start) ?? 0;
  const workEnd = parseClockTime(workHours.end) ?? MINUTES_PER_DAY;
  const snap = Math.max(1, snapMinutes);
  const today = localDate(now, zone);
  for (let offset = 0; offset <= days; offset += 1) {
    const day = addDays(today, offset);
    if (!workHours.days.includes(weekdayOf(day))) continue;
    let minute = workStart;
    if (offset === 0) minute = Math.max(minute, Math.ceil(minuteOfDay(now, zone) / snap) * snap);
    minute = Math.ceil(minute / snap) * snap;
    while (minute + minutes <= workEnd) {
      const start = atMinute(day, minute, zone).getTime();
      const end = start + minutes * 60_000;
      const hit = overlaps(busy, start, end);
      if (hit.length === 0) {
        return { date: isoDate(day), start: clockTime(minute), end: clockTime(minute + minutes) };
      }
      // Jump past the meeting that is in the way.
      const until = Math.max(...hit.map((entry) => entry.end));
      const next = minuteOfDay(new Date(until), zone);
      minute =
        until >= atMinute(addDays(day, 1), 0, zone).getTime()
          ? workEnd
          : Math.max(minute + snap, Math.ceil(next / snap) * snap);
    }
  }
  const fallback = nextHour(now, zone);
  const startMinute = parseClockTime(fallback.start) ?? 0;
  return {
    ...fallback,
    end: clockTime(Math.min(MINUTES_PER_DAY - 1, startMinute + minutes)),
  };
}

export interface FreeSlot {
  readonly start: string;
  readonly end: string;
}

// Every gap of at least `minutes` inside work hours between `from` and `to`, snapped to
// `snapMinutes`, each as long as the gap runs (not cut to `minutes`). Busy times cut gaps; work
// hours bound them. At most `limit` gaps, earliest first.
export function freeSlots({
  from,
  to,
  zone,
  workHours,
  busy,
  minutes,
  snapMinutes,
  limit,
}: {
  readonly from: Date;
  readonly to: Date;
  readonly zone: string;
  readonly workHours: WorkHours;
  readonly busy: readonly Busy[];
  readonly minutes: number;
  readonly snapMinutes: number;
  readonly limit: number;
}): FreeSlot[] {
  const workStart = parseClockTime(workHours.start) ?? 0;
  const workEnd = parseClockTime(workHours.end) ?? MINUTES_PER_DAY;
  const snap = Math.max(1, snapMinutes);
  const found: FreeSlot[] = [];
  const last = to.getTime();
  let day: LocalDate = localDate(from, zone);
  while (atMinute(day, 0, zone).getTime() < last && found.length < limit) {
    if (workHours.days.includes(weekdayOf(day))) {
      const open = Math.max(atMinute(day, workStart, zone).getTime(), from.getTime());
      const close = Math.min(atMinute(day, workEnd, zone).getTime(), last);
      let cursor = snapUp(open, snap);
      const inDay = busy.filter((entry) => entry.start < close && entry.end > cursor);
      for (const entry of [...inDay, { title: '', start: close, end: close }]) {
        const gapEnd = Math.min(entry.start, close);
        if (gapEnd - cursor >= minutes * 60_000 && found.length < limit) {
          found.push({
            start: new Date(cursor).toISOString(),
            end: new Date(gapEnd).toISOString(),
          });
        }
        cursor = Math.max(cursor, snapUp(entry.end, snap));
        if (cursor >= close) break;
      }
    }
    day = addDays(day, 1);
  }
  return found;
}

const snapUp = (instant: number, snapMinutes: number): number => {
  const step = snapMinutes * 60_000;
  return Math.ceil(instant / step) * step;
};
