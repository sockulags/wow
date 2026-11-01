import type { Weekday } from '@wow/contracts';
import type { CalendarWindow } from './source.js';

// Small wall-clock helpers on top of Intl. The scheduler unit brings Temporal; this package only
// needs day boundaries in one zone, so it stays dependency-free.

export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface LocalDateTime extends LocalDate {
  readonly hour: number;
  readonly minute: number;
}

const WEEKDAYS: readonly Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

export function resolveZone(setting: string): string {
  return setting === 'system' ? Intl.DateTimeFormat().resolvedOptions().timeZone : setting;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, found);
  }
  return found;
}

function wallClock(instant: Date, zone: string): LocalDateTime & { second: number } {
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts['year'] ?? 0,
    month: parts['month'] ?? 0,
    day: parts['day'] ?? 0,
    hour: parts['hour'] ?? 0,
    minute: parts['minute'] ?? 0,
    second: parts['second'] ?? 0,
  };
}

function offsetMs(instant: Date, zone: string): number {
  const wall = wallClock(instant, zone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

export function localDate(instant: Date, zone: string): LocalDate {
  const { year, month, day } = wallClock(instant, zone);
  return { year, month, day };
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

export function weekdayOf(date: LocalDate): Weekday {
  return WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()] ?? 'sunday';
}

// The instant a wall-clock time happens in `zone`. In a DST gap the later offset wins, which moves
// the time forward like Outlook does.
export function zonedInstant(time: LocalDateTime, zone: string): Date {
  const guess = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute);
  const first = guess - offsetMs(new Date(guess), zone);
  const second = guess - offsetMs(new Date(first), zone);
  return new Date(second);
}

export function startOfDay(date: LocalDate, zone: string): Date {
  return zonedInstant({ ...date, hour: 0, minute: 0 }, zone);
}

export interface WindowSettings {
  readonly zone: string;
  readonly firstDayOfWeek: Weekday;
  readonly lookaheadDays: number;
}

// From the start of the current week (so the week view is complete) to the end of the day
// `lookaheadDays` after today.
export function calendarWindow(now: Date, settings: WindowSettings): CalendarWindow {
  const zone = resolveZone(settings.zone);
  const today = localDate(now, zone);
  const back =
    (WEEKDAYS.indexOf(weekdayOf(today)) - WEEKDAYS.indexOf(settings.firstDayOfWeek) + 7) % 7;
  const from = startOfDay(addDays(today, -back), zone);
  const to = startOfDay(addDays(today, settings.lookaheadDays + 1), zone);
  return { from: from.toISOString(), to: to.toISOString() };
}
