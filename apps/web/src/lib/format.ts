import { useSetting } from '@/app/runtime';
import {
  addDays,
  formatTime,
  localDate,
  resolveZone,
  sameDate,
  type LocalDate,
} from '@/calendar/time';

// Human dates, times and durations (design rules, "Dates"; audit A-17). Never ISO in the UI.
// `now` is a parameter so the wording is tested without a clock.

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const weekday = (date: LocalDate) =>
  DAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()] ?? '';

// "Mon 2 Nov", with the year when it is not this year: "Mon 2 Nov 2025".
export function formatDay(date: LocalDate, today: LocalDate): string {
  const base = `${weekday(date)} ${date.day} ${MONTHS[date.month - 1] ?? ''}`;
  return date.year === today.year ? base : `${base} ${date.year}`;
}

const toDate = (value: Date | string) => (typeof value === 'string' ? new Date(value) : value);

// "14:25" today, "Yesterday 14:25", "Tomorrow 09:00", otherwise "Mon 2 Nov 14:25".
export function formatWhen(value: Date | string, zone: string, now: Date = new Date()): string {
  const instant = toDate(value);
  const day = localDate(instant, zone);
  const today = localDate(now, zone);
  const time = formatTime(instant, zone);
  if (sameDate(day, today)) return time;
  if (sameDate(day, addDays(today, -1))) return `Yesterday ${time}`;
  if (sameDate(day, addDays(today, 1))) return `Tomorrow ${time}`;
  return `${formatDay(day, today)} ${time}`;
}

// "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then the day.
export function formatRelative(value: Date | string, zone: string, now: Date = new Date()): string {
  const instant = toDate(value);
  const seconds = Math.round((now.getTime() - instant.getTime()) / 1000);
  if (seconds < 0) return formatWhen(instant, zone, now);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  const day = localDate(instant, zone);
  const today = localDate(now, zone);
  if (sameDate(day, today)) return `${hours} h ago`;
  if (sameDate(day, addDays(today, -1))) return 'yesterday';
  for (let back = 2; back <= 6; back += 1) {
    if (sameDate(day, addDays(today, -back))) return `${back} days ago`;
  }
  return formatDay(day, today);
}

// "45 s", "1 min 12 s", "2 h 5 min".
export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

// The formatters bound to the calendar.zone setting, so every view uses the same zone.
export function useDateFormat() {
  const zone = resolveZone(useSetting('calendar.zone'));
  return {
    zone,
    when: (value: Date | string, now?: Date) => formatWhen(value, zone, now),
    relative: (value: Date | string, now?: Date) => formatRelative(value, zone, now),
  };
}
