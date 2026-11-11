import {
  CalendarRange,
  type CalendarItem,
  type CalendarOccurrence,
  type CardState,
  type WorkflowRun,
} from '@wow/contracts';
import { useEffect, useState } from 'react';
import { useRuntime } from '@/app/runtime';
import { cardKind } from './items';
import { addDays, startOfDay, type LocalDate } from './time';

// Repeating cards in the grid (recurring cards spec 15 to 17). The server works out every
// occurrence in a range (`calendar.occurrences`); the calendar only draws what it answers and
// never counts days itself. Each occurrence of a repeating card becomes a block of its own, with
// an id made of the card and the day, so the grid's layout, focus and drag work on it unchanged.

// What an occurrence shows: the state of its run, or what happened instead. `skipped` is an
// occurrence that started nothing because the card's earlier run was still going.
export type OccurrenceState = CardState | 'skipped';

export interface ShownOccurrence {
  readonly cardId: string;
  readonly date: string;
  readonly next: boolean;
  readonly record: CalendarOccurrence['record'];
  // What the block says, or null when there is nothing to say (a plain card, or a day that went
  // by with nothing to run).
  readonly state: OccurrenceState | null;
  // The run a reached occurrence started; it opens there.
  readonly runId: string | null;
}

export const occurrenceId = (cardId: string, date: string): string => `${cardId}@${date}`;

// The range a calendar view reads: from the start of its first day to the start of the day
// after its last, in the calendar's zone.
export function viewRange(
  days: readonly LocalDate[],
  zone: string,
): { readonly from: string; readonly to: string } | undefined {
  const first = days[0];
  const last = days.at(-1);
  if (!first || !last) return undefined;
  return {
    from: startOfDay(first, zone).toISOString(),
    to: startOfDay(addDays(last, 1), zone).toISOString(),
  };
}

export const isRepeatingCard = (card: CalendarItem): boolean =>
  card.source === 'local' && card.repeat !== null && card.repeat !== undefined;

function stateOf(
  occurrence: CalendarOccurrence,
  card: CalendarItem,
  runs: ReadonlyMap<string, WorkflowRun>,
): OccurrenceState | null {
  const record = occurrence.record;
  if (record) {
    switch (record.outcome) {
      case 'fired':
        return record.runId ? (runs.get(record.runId)?.state ?? null) : null;
      case 'failed':
        return 'failed';
      case 'skipped':
        return 'skipped';
      case 'missed':
        return 'missed';
    }
  }
  if (cardKind(card) !== 'trigger') return null;
  // Ahead of the trigger's next time (both the server's): still to come. Before it with no
  // record: a day that went by before the card was made, which ran nothing.
  if (occurrence.next) return 'scheduled';
  const nextAt = card.nextAt;
  if (nextAt && Date.parse(occurrence.start) >= Date.parse(nextAt)) return 'scheduled';
  return null;
}

export interface OccurrenceBlocks {
  // One calendar item per occurrence of a repeating card in the range, at the occurrence's time.
  readonly items: readonly CalendarItem[];
  readonly shown: ReadonlyMap<string, ShownOccurrence>;
}

export function occurrenceBlocks(
  cards: readonly CalendarItem[],
  range: CalendarRange | undefined,
  runs: readonly WorkflowRun[],
): OccurrenceBlocks {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const items: CalendarItem[] = [];
  const shown = new Map<string, ShownOccurrence>();
  for (const occurrence of range?.occurrences ?? []) {
    const card = byId.get(occurrence.cardId);
    // Single cards are drawn from their own row; a card the topic no longer has is gone.
    if (!occurrence.repeating || !card || !isRepeatingCard(card)) continue;
    const id = occurrenceId(card.id, occurrence.date);
    const state = stateOf(occurrence, card, runsById);
    const runId = occurrence.record?.runId ?? null;
    shown.set(id, {
      cardId: card.id,
      date: occurrence.date,
      next: occurrence.next,
      record: occurrence.record,
      state,
      runId,
    });
    items.push({
      ...card,
      id,
      start: occurrence.start,
      end: occurrence.end,
      state: state ?? card.state,
      runId,
    });
  }
  return { items, shown };
}

// The calendar's items: Outlook items and single cards from their topic rows, and every
// occurrence of a repeating card from the range read.
export function calendarBlocks(
  items: readonly CalendarItem[],
  range: CalendarRange | undefined,
  runs: readonly WorkflowRun[],
): OccurrenceBlocks {
  const cards = items.filter((item) => item.source === 'local');
  const repeating = occurrenceBlocks(cards, range, runs);
  return {
    items: [...items.filter((item) => !isRepeatingCard(item)), ...repeating.items],
    shown: repeating.shown,
  };
}

// Cards with more occurrences in the range than the server returns (spec 17).
export function notShown(
  cards: readonly CalendarItem[],
  range: CalendarRange | undefined,
): readonly CalendarItem[] {
  const more = new Set(range?.more ?? []);
  return cards.filter((card) => more.has(card.id));
}

export interface CalendarRangeRead {
  readonly range: CalendarRange | undefined;
  // Why the last read of the shown range failed: the request was refused or its answer could
  // not be read. The calendar then says so instead of showing no repeating card at all.
  readonly error: string | undefined;
  readonly retry: () => void;
}

// Reads the range from the server, and again whenever a card, a trigger or a run changes, since
// any of them can move, add or finish an occurrence. The newest answer wins.
export function useCalendarRange(
  range: { readonly from: string; readonly to: string } | undefined,
  changes: readonly unknown[],
): CalendarRangeRead {
  const { connection } = useRuntime();
  const [answer, setAnswer] = useState<CalendarRange>();
  const [failure, setFailure] = useState<{ from: string; to: string; message: string }>();
  const [attempt, setAttempt] = useState(0);
  const from = range?.from;
  const to = range?.to;
  useEffect(() => {
    if (!connection || from === undefined || to === undefined) return undefined;
    let current = true;
    connection.request('calendar.occurrences', { from, to }).then(
      (result) => {
        if (!current) return;
        const parsed = CalendarRange.safeParse(result);
        if (parsed.success) {
          setAnswer(parsed.data);
          setFailure(undefined);
        } else {
          setFailure({ from, to, message: 'The server answered with occurrences wow cannot read' });
        }
      },
      (error: unknown) => {
        if (current) {
          setFailure({ from, to, message: error instanceof Error ? error.message : String(error) });
        }
      },
    );
    return () => {
      current = false;
    };
    // The topic rows are what asks for a new read: their identity changes on every push. The
    // caller passes the same number of them on every render.
  }, [connection, from, to, attempt, ...changes]);
  return {
    range: answer && answer.from === from && answer.to === to ? answer : undefined,
    error: failure && failure.from === from && failure.to === to ? failure.message : undefined,
    retry: () => setAttempt((count) => count + 1),
  };
}
