import {
  isLiveRunState,
  type CalendarItem,
  type CalendarOccurrence,
  type CalendarRange,
  type CardOccurrence,
  type PastSeries,
  type WorkflowRun,
} from '@wow/contracts';
import {
  firstAfter,
  localDay,
  occurrencesIn,
  type Occurrence,
  type SchedulePart,
  type Series,
} from '../scheduler/occurrences.js';
import { asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/database.js';
import { calendarItems } from '../db/schema.js';
import type { ReadModel } from './orchestrator.js';
import { readCardOccurrences } from './projector.js';

// A repeating card read as a series (recurring cards spec 1 to 14). The card is one row; its
// occurrences come from the rule, and what happened at the ones already reached is in its
// occurrence records.

export type RepeatingCard = CalendarItem & { readonly repeat: NonNullable<CalendarItem['repeat']> };

export const isRepeating = (card: CalendarItem): card is RepeatingCard =>
  card.source === 'local' && card.repeat !== null && card.repeat !== undefined;

export const seriesOf = (card: RepeatingCard): Series => ({
  start: card.start,
  end: card.end,
  zone: card.zone,
  repeat: card.repeat,
});

// The card's series over time: each series it followed before a change keeps the days before
// that change, so past occurrences stay where they were (recurring cards spec 10, 11).
export function scheduleOf(card: RepeatingCard): SchedulePart[] {
  const parts: SchedulePart[] = [];
  let from: string | undefined;
  for (const past of card.pastSeries ?? []) {
    const { until, ...series } = past;
    parts.push({ series, from, until });
    from = until;
  }
  parts.push({ series: seriesOf(card), from });
  return parts;
}

// The card's past series once its own series changes from `day` on: the days before `day` keep
// the series that set them, and every day from `day` on follows the changed one.
export function pastSeriesBefore(card: RepeatingCard, day: string): PastSeries[] {
  const kept: PastSeries[] = [];
  let from: string | undefined;
  for (const past of card.pastSeries ?? []) {
    if (from !== undefined && from >= day) break;
    kept.push(past.until > day ? { ...past, until: day } : past);
    from = past.until;
  }
  if ((from ?? localDay(card.start, card.zone)) < day) kept.push({ ...seriesOf(card), until: day });
  return kept;
}

// The days that will not fire again: skipped by hand, or already reached.
export function takenDays(card: CalendarItem, read: ReadModel): Set<string> {
  return new Set([
    ...(card.skippedDates ?? []),
    ...read.cardOccurrences(card.id).map((occurrence) => occurrence.date),
  ]);
}

// The occurrence the card's trigger fires next: the first one after `now` that was neither
// skipped nor reached. Only finitely many days are taken, so the walk ends.
export function nextOccurrence(
  card: RepeatingCard,
  read: ReadModel,
  now: number,
  alsoTaken: ReadonlySet<string> = new Set(),
): Occurrence | undefined {
  const taken = takenDays(card, read);
  return firstAfter(
    scheduleOf(card),
    now,
    (occurrence) => !taken.has(occurrence.date) && !alsoTaken.has(occurrence.date),
  );
}

// A run of the card that is still running or waiting: the newest run it follows, or the run of
// any occurrence it reached (a card restored by Undo has no run of its own yet).
export function liveRunOf(card: CalendarItem, read: ReadModel): WorkflowRun | undefined {
  const ids = new Set<string>();
  if (card.runId !== null) ids.add(card.runId);
  for (const occurrence of read.cardOccurrences(card.id)) {
    if (occurrence.runId !== null) ids.add(occurrence.runId);
  }
  for (const id of ids) {
    const run = read.run(id);
    if (run && isLiveRunState(run.state)) return run;
  }
  return undefined;
}

// A card stored with a zone the platform does not know (before zones were checked for every
// card) is read on its UTC day, so that one row cannot fail the whole range.
function dayOf(card: CalendarItem): string {
  try {
    return localDay(card.start, card.zone);
  } catch (error) {
    if (error instanceof RangeError) return localDay(card.start, 'UTC');
    throw error;
  }
}

// The occurrences of the local cards in [from, to) (recurring cards spec 15, 17). A repeating
// card gives every occurrence in the range except the days skipped by hand, at most `limit`;
// an occurrence already reached is shown where it was then, with what happened, even when the
// rule has changed since. A card without a rule is its one occurrence.
export function calendarRange(
  cards: readonly CalendarItem[],
  occurrencesOf: (cardId: string) => readonly CardOccurrence[],
  range: { readonly from: string; readonly to: string },
  limit: number,
): CalendarRange {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  const overlaps = (item: { start: string; end: string }) =>
    Date.parse(item.end) > from && Date.parse(item.start) < to;
  const found: CalendarOccurrence[] = [];
  const more: string[] = [];
  for (const card of cards) {
    if (card.source !== 'local') continue;
    if (!isRepeating(card)) {
      if (overlaps(card)) {
        found.push({
          cardId: card.id,
          date: dayOf(card),
          start: card.start,
          end: card.end,
          repeating: false,
          next: card.nextAt === card.start,
          record: null,
        });
      }
      continue;
    }
    const skipped = new Set(card.skippedDates ?? []);
    const records = new Map(occurrencesOf(card.id).map((record) => [record.date, record]));
    const computed = occurrencesIn(
      scheduleOf(card),
      from,
      to,
      limit,
      (occurrence) => !skipped.has(occurrence.date) && !records.has(occurrence.date),
    );
    const own: CalendarOccurrence[] = [
      ...computed.found.map((occurrence) => ({
        cardId: card.id,
        ...occurrence,
        repeating: true,
        next: card.nextAt === occurrence.start,
        record: null,
      })),
      ...[...records.values()].filter(overlaps).map((record) => ({
        cardId: card.id,
        date: record.date,
        start: record.start,
        end: record.end,
        repeating: true,
        next: false,
        record,
      })),
    ].toSorted((a, b) => Date.parse(a.start) - Date.parse(b.start));
    if (computed.more || own.length > limit) more.push(card.id);
    found.push(...own.slice(0, limit));
  }
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    occurrences: found.toSorted((a, b) => Date.parse(a.start) - Date.parse(b.start)),
    more,
  };
}

// The range read the calendar and the assistant ask for.
export function readCalendarRange(
  db: DbOrTx,
  range: { readonly from: string; readonly to: string },
  limit: number,
): CalendarRange {
  const cards = db
    .select()
    .from(calendarItems)
    .where(eq(calendarItems.source, 'local'))
    .orderBy(asc(calendarItems.start))
    .all();
  return calendarRange(cards, (cardId) => readCardOccurrences(db, cardId), range, limit);
}
