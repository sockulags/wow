import { repeatWeekdays, type RepeatRule, type RepeatWeekday } from '@wow/contracts';

// The occurrences of a repeating card (recurring cards spec 1 to 3), worked out from its rule
// in the card's zone and never stored one by one. Wall-clock times come from the platform's
// zone data through Intl: every occurrence has the card's local start time and local length,
// whatever the offset is that day. Pure; the scheduler, the card decisions and the calendar
// read all ask this module.

export interface Series {
  readonly start: string;
  readonly end: string;
  readonly zone: string;
  readonly repeat: RepeatRule;
}

export interface Occurrence {
  // The day in the card's zone, YYYY-MM-DD.
  readonly date: string;
  readonly start: string;
  readonly end: string;
}

interface Day {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

interface Wall extends Day {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
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

// The wall clock in `zone` at an instant.
export function wallClock(instantMs: number, zone: string): Wall {
  const parts: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts['year'] ?? 1970,
    month: parts['month'] ?? 1,
    day: parts['day'] ?? 1,
    hour: parts['hour'] ?? 0,
    minute: parts['minute'] ?? 0,
    second: parts['second'] ?? 0,
  };
}

// A wall-clock reading as if it were UTC, so readings can be compared and added to.
const naive = (wall: Wall): number =>
  Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);

// The zone's offset at an instant, in milliseconds.
function offsetAt(instantMs: number, zone: string): number {
  const whole = Math.floor(instantMs / 1000) * 1000;
  return naive(wallClock(whole, zone)) - whole;
}

const oneDay = 86_400_000;

// The instant a wall-clock reading in `zone` names. A reading that happens twice (clocks going
// back) is the first; one that does not exist (clocks going forward) moves to the first moment
// after it that does, which is the instant the clocks jumped (spec 2).
export function instantOf(wall: Wall, zone: string): number {
  const target = naive(wall);
  const before = offsetAt(target - oneDay, zone);
  const after = offsetAt(target + oneDay, zone);
  const found = [target - before, target - after]
    .filter((candidate) => naive(wallClock(candidate, zone)) === target)
    .toSorted((a, b) => a - b);
  if (found[0] !== undefined) return found[0];
  // In the gap: the reading under the old offset is still before the jump at `low`, and the
  // reading at `high` is after it. The jump is the first instant whose reading passes the target.
  let low = target - after;
  let high = target - before;
  while (high - low > 1000) {
    const middle = low + Math.floor((high - low) / 2000) * 1000;
    if (naive(wallClock(middle, zone)) >= target) high = middle;
    else low = middle;
  }
  return high;
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

export const dayText = (day: Day): string =>
  `${pad(day.year, 4)}-${pad(day.month)}-${pad(day.day)}`;

export function parseDay(text: string): Day {
  const [year, month, day] = text.split('-').map(Number);
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}

// The day in `zone` an instant falls on.
export const localDay = (instant: string | number, zone: string): string =>
  dayText(wallClock(typeof instant === 'number' ? instant : Date.parse(instant), zone));

const dayNumber = (day: Day): number => Date.UTC(day.year, day.month - 1, day.day) / oneDay;

function fromDayNumber(value: number): Day {
  const date = new Date(value * oneDay);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

// Monday is 0.
const weekdayIndex = (day: Day): number => (new Date(dayNumber(day) * oneDay).getUTCDay() + 6) % 7;

const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

// A series stops at the last day an occurrence can be named by (YYYY-MM-DD), so a rule with a
// long interval ends instead of walking into dates the platform cannot represent.
const lastYear = 9999;
const lastDayNumber = Date.UTC(lastYear, 11, 31) / oneDay;

// The days the rule falls on, in order, from the start's day, before the end is applied, as day
// numbers. Days before `skipTo` may be left out: the walk jumps there with integer arithmetic,
// so a read far from the start costs no more than one near it.
function* ruleDays(first: Day, rule: RepeatRule, skipTo: number): Generator<number> {
  const step = rule.interval;
  const start = dayNumber(first);
  const ahead = Math.max(0, skipTo - start);
  switch (rule.frequency) {
    case 'daily': {
      for (let n = start + Math.ceil(ahead / step) * step; n <= lastDayNumber; n += step) yield n;
      return;
    }
    case 'weekly': {
      const chosen = new Set<RepeatWeekday>(
        rule.weekdays.length > 0 ? rule.weekdays : [repeatWeekdays[weekdayIndex(first)] ?? 'mon'],
      );
      const offsets = repeatWeekdays
        .map((weekday, index) => (chosen.has(weekday) ? index : -1))
        .filter((index) => index >= 0);
      // The start is the first occurrence even on a weekday the rule does not name (spec 2).
      if (ahead === 0) yield start;
      const firstMonday = start - weekdayIndex(first);
      const weeks = Math.floor(Math.max(0, skipTo - firstMonday) / (7 * step));
      for (let monday = firstMonday + weeks * 7 * step; ; monday += 7 * step) {
        for (const offset of offsets) {
          if (monday + offset > lastDayNumber) return;
          if (monday + offset > start) yield monday + offset;
        }
      }
    }
    case 'monthly': {
      // A month without the start's day has no occurrence (spec 3).
      const firstIndex = first.year * 12 + first.month - 1;
      const target = fromDayNumber(Math.max(start, skipTo));
      const months = Math.floor((target.year * 12 + target.month - 1 - firstIndex) / step);
      for (let index = firstIndex + months * step; ; index += step) {
        const year = Math.floor(index / 12);
        if (year > lastYear) return;
        const month = (index % 12) + 1;
        if (first.day <= daysInMonth(year, month)) yield dayNumber({ year, month, day: first.day });
      }
    }
  }
}

// Every occurrence of the series in order, the first being the card's own start and end. The
// sequence ends where the rule's end says; without one it does not end, so callers stop it.
// With `from` (an instant, or a day in the card's zone), occurrences that end well before it are
// left out without being worked out; a few that end before it may still come, so callers keep
// their own check.
export function* occurrences(series: Series, from?: number | string): Generator<Occurrence> {
  const startMs = Date.parse(series.start);
  const endMs = Date.parse(series.end);
  const startWall = wallClock(startMs, series.zone);
  const length = naive(wallClock(endMs, series.zone)) - naive(startWall);
  const elapsed = endMs - startMs;
  const { end } = series.repeat;
  const first = dayNumber(startWall);
  const last = end.kind === 'on' ? dayNumber(parseDay(end.date)) : lastDayNumber;
  // An occurrence that overlaps `from` starts at most its length (and a day of offset change)
  // before it, in days of the card's zone.
  const skipTo =
    typeof from === 'string'
      ? dayNumber(parseDay(from))
      : typeof from === 'number' && Number.isFinite(from)
        ? dayNumber(wallClock(from, series.zone)) -
          Math.ceil(Math.max(length, elapsed) / oneDay) -
          1
        : first;
  if (skipTo > last) return;
  // An end after a count has to count the days before `skipTo`; it is at most the count's bound
  // of steps, and those days are counted without being worked out.
  const counted = end.kind === 'after';
  let count = 0;
  for (const n of ruleDays(startWall, series.repeat, counted ? first : skipTo)) {
    if (counted && count >= end.count) return;
    if (n > last) return;
    count += 1;
    if (n < skipTo) continue;
    const day = fromDayNumber(n);
    const isFirst = n === first;
    const at = isFirst ? startMs : instantOf({ ...startWall, ...day }, series.zone);
    const endAt = isFirst ? endMs : wallPlus(at, length, series.zone);
    yield {
      date: dayText(day),
      start: new Date(at).toISOString(),
      end: new Date(endAt > at ? endAt : at + elapsed).toISOString(),
    };
  }
}

// The instant `length` of wall-clock time after `at`, so a card from 08:30 to 09:00 stays half
// an hour on the clock on the day the offset changes.
function wallPlus(at: number, length: number, zone: string): number {
  const wall = new Date(naive(wallClock(at, zone)) + length);
  return instantOf(
    {
      year: wall.getUTCFullYear(),
      month: wall.getUTCMonth() + 1,
      day: wall.getUTCDate(),
      hour: wall.getUTCHours(),
      minute: wall.getUTCMinutes(),
      second: wall.getUTCSeconds(),
    },
    zone,
  );
}

// The occurrences that overlap [from, to), at most `limit` of them, and whether more did.
export function occurrencesIn(
  series: Series,
  from: number,
  to: number,
  limit: number,
  keep: (occurrence: Occurrence) => boolean = () => true,
): { found: Occurrence[]; more: boolean } {
  const found: Occurrence[] = [];
  for (const occurrence of occurrences(series, from)) {
    if (Date.parse(occurrence.start) >= to) break;
    if (Date.parse(occurrence.end) <= from || !keep(occurrence)) continue;
    if (found.length === limit) return { found, more: true };
    found.push(occurrence);
  }
  return { found, more: false };
}

// The first occurrence that starts after `after` and that `keep` lets through, or undefined
// when the series has ended. Starts are in order, so this walks only as far as it must.
export function firstAfter(
  series: Series,
  after: number,
  keep: (occurrence: Occurrence) => boolean = () => true,
): Occurrence | undefined {
  for (const occurrence of occurrences(series, after)) {
    if (Date.parse(occurrence.start) > after && keep(occurrence)) return occurrence;
  }
  return undefined;
}

// The occurrences that start in (after, until], in order.
export function startingBetween(
  series: Series,
  after: number,
  until: number,
  keep: (occurrence: Occurrence) => boolean = () => true,
): Occurrence[] {
  const found: Occurrence[] = [];
  for (const occurrence of occurrences(series, after)) {
    const start = Date.parse(occurrence.start);
    if (start > until) break;
    if (start > after && keep(occurrence)) found.push(occurrence);
  }
  return found;
}

// The occurrence on a day, if the rule falls on it.
export function occurrenceOn(series: Series, date: string): Occurrence | undefined {
  const wanted = dayNumber(parseDay(date));
  for (const occurrence of occurrences(series, date)) {
    const day = dayNumber(parseDay(occurrence.date));
    if (day === wanted) return occurrence;
    if (day > wanted) return undefined;
  }
  return undefined;
}
