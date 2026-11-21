// Wall-clock arithmetic lives in @wow/contracts (clock.ts) so the server can share it; the
// formatting for the calendar's own words is here.
import {
  MINUTES_PER_DAY,
  addDays,
  atMinute,
  clockTime,
  isoDate,
  localDate,
  localDateTime,
  minuteOfDay,
  parseClockTime,
  parseIsoDate,
  resolveZone,
  sameDate,
  startOfDay,
  startOfWeek,
  systemZone,
  weekdayOf,
  zonedInstant,
  type LocalDate,
  type LocalDateTime,
} from '@wow/contracts';

export {
  MINUTES_PER_DAY,
  addDays,
  atMinute,
  clockTime,
  isoDate,
  localDate,
  localDateTime,
  minuteOfDay,
  parseClockTime,
  parseIsoDate,
  resolveZone,
  sameDate,
  startOfDay,
  startOfWeek,
  systemZone,
  weekdayOf,
  zonedInstant,
};
export type { LocalDate, LocalDateTime };

export const formatTime = (instant: Date, zone: string): string =>
  clockTime(minuteOfDay(instant, zone));

// Labels are put together here rather than by Intl, whose punctuation differs between ICU
// versions (and so between the browser and the tests).
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const dayName = (date: LocalDate) =>
  DAY_NAMES[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()] ?? '';
const monthName = (date: LocalDate) => MONTH_NAMES[date.month - 1] ?? '';

// "Mon 2"
export const formatDayHeading = (date: LocalDate): string =>
  `${dayName(date).slice(0, 3)} ${date.day}`;
// "Monday 2 November 2026"
export const formatLongDay = (date: LocalDate): string =>
  `${dayName(date)} ${date.day} ${monthName(date)} ${date.year}`;
const shortMonth = (date: LocalDate) => monthName(date).slice(0, 3);

// "2–8 Nov 2026", "30 Nov – 6 Dec 2026", "28 Dec 2026 – 3 Jan 2027". `withYear: false` drops the
// year for a narrow toolbar.
export function formatDateRange(first: LocalDate, last: LocalDate, withYear = true): string {
  const year = (date: LocalDate) => (withYear ? ` ${date.year}` : '');
  if (first.year !== last.year) {
    return `${first.day} ${shortMonth(first)}${year(first)} – ${last.day} ${shortMonth(last)}${year(last)}`;
  }
  if (first.month !== last.month) {
    return `${first.day} ${shortMonth(first)} – ${last.day} ${shortMonth(last)}${year(last)}`;
  }
  return `${first.day}–${last.day} ${shortMonth(last)}${year(last)}`;
}

// "Mon 2 Nov", for narrow toolbars and details.
export const formatShortDay = (date: LocalDate): string =>
  `${dayName(date).slice(0, 3)} ${date.day} ${shortMonth(date)}`;

// The ISO 8601 week number: weeks start on Monday and week 1 holds the year's first Thursday.
export function isoWeek(date: LocalDate): number {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day));
  const weekday = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - weekday + 3);
  const firstThursday = new Date(Date.UTC(day.getUTCFullYear(), 0, 4));
  const firstWeekday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstWeekday + 3);
  return 1 + Math.round((day.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
}

// "UTC+1", "UTC+5:30", "UTC" for the zone's offset at `instant`.
export function formatOffset(zone: string, instant: Date): string {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(instant)
      .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  return name.replace('GMT', 'UTC');
}

// "Stockholm, UTC+1": the city of an IANA zone and its offset now.
export function formatZone(zone: string, instant: Date = new Date()): string {
  const city = (zone.split('/').at(-1) ?? zone).replaceAll('_', ' ');
  return `${city}, ${formatOffset(zone, instant)}`;
}

// "30 min", "1 h", "1 h 15 min".
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export const isWeekend = (date: LocalDate): boolean => {
  const weekday = weekdayOf(date);
  return weekday === 'saturday' || weekday === 'sunday';
};
