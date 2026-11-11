import { z } from 'zod';

// A card's repeat rule (recurring cards spec 1 to 4). It is wow's own small structure rather
// than an iCalendar RRULE: it covers what the intent asks for and can be said in words. The
// server works the occurrences out from it in the card's zone; nothing here does zone math
// beyond formatting.

const Id = z.string().min(1);
const Timestamp = z.iso.datetime({ offset: true });

// A day in the card's zone, as YYYY-MM-DD. An occurrence is named by its day: no rule falls
// twice on one day.
export const LocalDay = z.iso.date();
export type LocalDay = z.infer<typeof LocalDay>;

export const RepeatFrequency = z.enum(['daily', 'weekly', 'monthly']);
export type RepeatFrequency = z.infer<typeof RepeatFrequency>;

export const RepeatWeekday = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export type RepeatWeekday = z.infer<typeof RepeatWeekday>;

// Monday first, as ISO numbers them (1 to 7).
export const repeatWeekdays: readonly RepeatWeekday[] = RepeatWeekday.options;

export const RepeatEnd = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('never') }),
  // The last day an occurrence may fall on, inclusive.
  z.object({ kind: z.literal('on'), date: LocalDay }),
  // How many occurrences there are, the first one (the card's own start) included. A skipped
  // occurrence still counts.
  z.object({ kind: z.literal('after'), count: z.number().int().min(1) }),
]);
export type RepeatEnd = z.infer<typeof RepeatEnd>;

export const RepeatRule = z
  .object({
    frequency: RepeatFrequency,
    // Every `interval` days, weeks or months.
    interval: z.number().int().min(1).default(1),
    // Weekly only: the days of the week it falls on. Empty means the start's own weekday.
    weekdays: z.array(RepeatWeekday).default([]),
    end: RepeatEnd.default({ kind: 'never' }),
  })
  .refine((rule) => rule.frequency === 'weekly' || rule.weekdays.length === 0, {
    message: 'Only a weekly rule names weekdays',
    path: ['weekdays'],
  });
export type RepeatRule = z.infer<typeof RepeatRule>;

// What happened at an occurrence the scheduler reached, kept per card so the calendar can show
// how each past occurrence went. `fired` started `runId`; `failed` could not start a run;
// `skipped` started nothing because the card's earlier run was still going; `missed` passed
// while the app was closed or paused.
export const OccurrenceOutcome = z.enum(['fired', 'failed', 'skipped', 'missed']);
export type OccurrenceOutcome = z.infer<typeof OccurrenceOutcome>;

export const CardOccurrence = z.object({
  date: LocalDay,
  start: Timestamp,
  end: Timestamp,
  outcome: OccurrenceOutcome,
  runId: Id.nullable(),
  // Why nothing started, in words, for `failed` and `skipped`.
  reason: z.string().nullable(),
  // A missed occurrence the card offers "Run now" for (missed policy `mark`).
  offerRunNow: z.boolean(),
  // When it was recorded.
  at: Timestamp,
});
export type CardOccurrence = z.infer<typeof CardOccurrence>;

// One occurrence of a card in a range the calendar reads (spec 15, 17). A card without a rule
// is its one occurrence. `record` is what happened when the occurrence was reached; null for
// one still ahead, and for one that went by with nothing to run.
export const CalendarOccurrence = z.object({
  cardId: Id,
  date: LocalDay,
  start: Timestamp,
  end: Timestamp,
  repeating: z.boolean(),
  // The occurrence the card's trigger fires next.
  next: z.boolean(),
  record: CardOccurrence.nullable(),
});
export type CalendarOccurrence = z.infer<typeof CalendarOccurrence>;

export const CalendarRangeParams = z
  .object({ from: Timestamp, to: Timestamp })
  .refine((range) => Date.parse(range.to) > Date.parse(range.from), {
    message: 'A range must end after it starts',
    path: ['to'],
  });
export type CalendarRangeParams = z.infer<typeof CalendarRangeParams>;

export const CalendarRange = z.object({
  from: Timestamp,
  to: Timestamp,
  // In start order.
  occurrences: z.array(CalendarOccurrence),
  // Cards with more occurrences in the range than `calendar.maxOccurrences`; only the first
  // ones are in `occurrences`.
  more: z.array(Id),
});
export type CalendarRange = z.infer<typeof CalendarRange>;

const weekdayNames: Readonly<Record<RepeatWeekday, string>> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

const workweek: readonly RepeatWeekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];

const ordinal = (day: number): string => {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${['th', 'st', 'nd', 'rd'][day % 10] ?? 'th'}`;
};

const list = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;

function partsIn(start: string, zone: string): Record<string, string> {
  const parts: Record<string, string> = {};
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    day: 'numeric',
    weekday: 'short',
  });
  for (const part of format.formatToParts(new Date(start))) parts[part.type] = part.value;
  return parts;
}

function endDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const named = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return named.format(new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)));
}

// The rule in words, as the editor and the assistant's change rows say it: "Every weekday at
// 08:30, until 19 December 2026". With the card's start and zone it names the time and the
// days the start decides; without them it says the rule alone.
export function repeatRuleWords(
  rule: RepeatRule,
  card?: { readonly start: string; readonly zone: string },
): string {
  const parts = card ? partsIn(card.start, card.zone) : undefined;
  const every = (one: string, many: string) =>
    rule.interval === 1 ? `Every ${one}` : `Every ${rule.interval} ${many}`;
  const days = ((): string => {
    switch (rule.frequency) {
      case 'daily':
        return every('day', 'days');
      case 'weekly': {
        const startDay = parts?.['weekday']?.toLowerCase().slice(0, 3);
        const chosen =
          rule.weekdays.length > 0
            ? repeatWeekdays.filter((day) => rule.weekdays.includes(day))
            : RepeatWeekday.safeParse(startDay).success
              ? [startDay as RepeatWeekday]
              : [];
        if (rule.interval === 1 && chosen.length === 5 && workweek.every((d) => chosen.includes(d)))
          return 'Every weekday';
        if (rule.interval === 1 && chosen.length === 7) return 'Every day';
        const head = every('week', 'weeks');
        return chosen.length === 0
          ? head
          : `${head} on ${list(chosen.map((day) => weekdayNames[day]))}`;
      }
      case 'monthly': {
        const head = every('month', 'months');
        const day = Number(parts?.['day']);
        return Number.isInteger(day) && day > 0 ? `${head} on the ${ordinal(day)}` : head;
      }
    }
  })();
  const time = parts ? ` at ${parts['hour']}:${parts['minute']}` : '';
  const end =
    rule.end.kind === 'on'
      ? `, until ${endDay(rule.end.date)}`
      : rule.end.kind === 'after'
        ? rule.end.count === 1
          ? ', once'
          : `, ${rule.end.count} times`
        : '';
  return `${days}${time}${end}`;
}
