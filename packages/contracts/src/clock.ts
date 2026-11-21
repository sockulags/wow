import type { Weekday } from './settings.js';
import { systemZone } from './calendar-prefs.js';

// Wall-clock arithmetic in one IANA zone on top of Intl, shared by the web app and the server.
// Days are local dates, never 24-hour steps, so a week that crosses a DST change still has seven
// days and a meeting keeps its clock time on both sides of the change.

export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface LocalDateTime extends LocalDate {
  readonly hour: number;
  readonly minute: number;
}

export const MINUTES_PER_DAY = 24 * 60;

const WEEKDAYS: readonly Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

// For callers without the Outlook profile: "outlook" falls back to the system zone, as it does
// until Outlook is first read. The calendar itself resolves zones with `useCalendarPrefs`.
export function resolveZone(setting: string): string {
  return setting === 'system' || setting === 'outlook' ? systemZone() : setting;
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

function wallClock(instant: Date, zone: string): LocalDateTime & { readonly second: number } {
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

export function localDateTime(instant: Date, zone: string): LocalDateTime {
  const { year, month, day, hour, minute } = wallClock(instant, zone);
  return { year, month, day, hour, minute };
}

// The instant a wall-clock time happens in `zone`. Minutes past 24:00 roll into the next day. In
// a DST gap the later offset wins, which moves the time forward like Outlook does.
export function zonedInstant(time: LocalDateTime, zone: string): Date {
  const guess = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute);
  const first = guess - offsetMs(new Date(guess), zone);
  return new Date(guess - offsetMs(new Date(first), zone));
}

export function atMinute(date: LocalDate, minute: number, zone: string): Date {
  return zonedInstant({ ...date, hour: Math.floor(minute / 60), minute: minute % 60 }, zone);
}

export const startOfDay = (date: LocalDate, zone: string): Date => atMinute(date, 0, zone);

export function addDays(date: LocalDate, days: number): LocalDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

export const weekdayOf = (date: LocalDate): Weekday =>
  WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()] ?? 'sunday';

export function startOfWeek(date: LocalDate, firstDay: Weekday): LocalDate {
  const back = (WEEKDAYS.indexOf(weekdayOf(date)) - WEEKDAYS.indexOf(firstDay) + 7) % 7;
  return addDays(date, -back);
}

export const sameDate = (a: LocalDate, b: LocalDate): boolean =>
  a.year === b.year && a.month === b.month && a.day === b.day;

const pad = (value: number) => String(value).padStart(2, '0');

// "2026-11-02", the form the calendar's URL uses.
export const isoDate = (date: LocalDate): string =>
  `${String(date.year).padStart(4, '0')}-${pad(date.month)}-${pad(date.day)}`;

export function parseIsoDate(text: string): LocalDate | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return undefined;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  // Rejects 2026-02-30 and the like.
  return sameDate(addDays(date, 0), date) ? date : undefined;
}

// Minutes since local midnight of the instant's own day.
export function minuteOfDay(instant: Date, zone: string): number {
  const { hour, minute } = wallClock(instant, zone);
  return hour * 60 + minute;
}

export const clockTime = (minute: number): string =>
  `${pad(Math.floor(minute / 60) % 24)}:${pad(minute % 60)}`;

export function parseClockTime(text: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? hour * 60 + minute : undefined;
}
