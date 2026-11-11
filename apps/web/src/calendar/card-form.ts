import {
  repeatMaxCount,
  repeatMaxInterval,
  RepeatRule,
  RepeatWeekday,
  repeatWeekdays,
  type CalendarItem,
  type Project,
  type Workflow,
  type WorkflowRun,
} from '@wow/contracts';
import {
  addDays,
  atMinute,
  formatMinutes,
  formatShortDay,
  formatTime,
  isoDate,
  localDate,
  parseClockTime,
  parseIsoDate,
  weekdayOf,
} from './time';

// The card dialog's rules, apart from React so they are tested on their own.

export interface CardFormValues {
  readonly title: string;
  readonly date: string;
  readonly start: string;
  readonly end: string;
  readonly projectId: string;
  readonly workflowId: string;
  readonly backlogItemId: string;
  readonly body: string;
  readonly repeat: RepeatDraft;
}

// The Repeat section as typed (recurring cards spec 16). Numbers stay text until the form is
// sent, so a half-typed value can be shown with its reason.
export interface RepeatDraft {
  readonly frequency: 'none' | RepeatRule['frequency'];
  readonly interval: string;
  readonly weekdays: readonly RepeatWeekday[];
  readonly end: RepeatRule['end']['kind'];
  readonly endDate: string;
  readonly count: string;
}

export const noRepeat: RepeatDraft = {
  frequency: 'none',
  interval: '1',
  weekdays: [],
  end: 'never',
  endDate: '',
  count: '10',
};

export function repeatDraft(rule: RepeatRule | null | undefined): RepeatDraft {
  if (!rule) return noRepeat;
  return {
    frequency: rule.frequency,
    interval: String(rule.interval),
    weekdays: rule.weekdays,
    end: rule.end.kind,
    endDate: rule.end.kind === 'on' ? rule.end.date : '',
    count: rule.end.kind === 'after' ? String(rule.end.count) : noRepeat.count,
  };
}

// The weekday a weekly rule starts with: the day of the card's date.
export function weekdayOfDate(date: string): RepeatWeekday | undefined {
  const day = parseIsoDate(date);
  if (!day) return undefined;
  const parsed = RepeatWeekday.safeParse(weekdayOf(day).slice(0, 3));
  return parsed.success ? parsed.data : undefined;
}

export type RepeatResult =
  | { readonly ok: true; readonly rule: RepeatRule | null }
  | {
      readonly ok: false;
      readonly field: 'interval' | 'endDate' | 'count';
      readonly message: string;
    };

const wholeNumber = (text: string): number | undefined =>
  /^\s*\d+\s*$/.test(text) ? Number(text) : undefined;

// The rule the form describes, or why it describes none. `date` is the card's first day: an end
// before it would leave the series without its own first occurrence.
export function repeatRule(draft: RepeatDraft, date: string): RepeatResult {
  if (draft.frequency === 'none') return { ok: true, rule: null };
  const interval = wholeNumber(draft.interval);
  if (interval === undefined || interval < 1 || interval > repeatMaxInterval) {
    return {
      ok: false,
      field: 'interval',
      message: `Give a whole number from 1 to ${repeatMaxInterval}`,
    };
  }
  let end: RepeatRule['end'] = { kind: 'never' };
  if (draft.end === 'on') {
    if (!parseIsoDate(draft.endDate))
      return { ok: false, field: 'endDate', message: 'Give a date' };
    if (draft.endDate < date) {
      return { ok: false, field: 'endDate', message: 'Ends before the first time' };
    }
    end = { kind: 'on', date: draft.endDate };
  } else if (draft.end === 'after') {
    const count = wholeNumber(draft.count);
    if (count === undefined || count < 1 || count > repeatMaxCount) {
      return {
        ok: false,
        field: 'count',
        message: `Give a whole number from 1 to ${repeatMaxCount}`,
      };
    }
    end = { kind: 'after', count };
  }
  const weekdays =
    draft.frequency === 'weekly'
      ? repeatWeekdays.filter((day) => draft.weekdays.includes(day))
      : [];
  const parsed = RepeatRule.safeParse({ frequency: draft.frequency, interval, weekdays, end });
  return parsed.success
    ? { ok: true, rule: parsed.data }
    : { ok: false, field: 'interval', message: parsed.error.issues[0]?.message ?? 'Not a rule' };
}

export const sameRule = (a: RepeatRule | null | undefined, b: RepeatRule | null | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// "Mon 16 Nov, 08:30": when a card's trigger fires next, as the server set it, in the zone the
// calendar shows.
export function nextFireText(nextAt: string, zone: string): string {
  const at = new Date(nextAt);
  return `${formatShortDay(localDate(at, zone))}, ${formatTime(at, zone)}`;
}

// The day an instant falls on in a card's own zone, as the server names occurrences.
export const cardDay = (instant: string, zone: string): string =>
  isoDate(localDate(new Date(instant), zone));

export type FormRange =
  | { readonly ok: true; readonly start: string; readonly end: string; readonly minutes: number }
  | { readonly ok: false; readonly field: 'date' | 'start' | 'end'; readonly message: string };

// The instants a form describes (audit B-03). An end of 00:00 is midnight at the end of the day;
// any other end at or before the start is an error, never a silent overnight card.
export function formRange(
  form: Pick<CardFormValues, 'date' | 'start' | 'end'>,
  zone: string,
): FormRange {
  const date = parseIsoDate(form.date);
  if (!date) return { ok: false, field: 'date', message: 'Give a date' };
  const start = parseClockTime(form.start);
  if (start === undefined) return { ok: false, field: 'start', message: 'Give a start time' };
  const end = parseClockTime(form.end);
  if (end === undefined) return { ok: false, field: 'end', message: 'Give an end time' };
  const midnight = end === 0;
  if (!midnight && end <= start)
    return { ok: false, field: 'end', message: 'Ends before it starts' };
  const startAt = atMinute(date, start, zone);
  const endAt = midnight ? atMinute(addDays(date, 1), 0, zone) : atMinute(date, end, zone);
  return {
    ok: true,
    start: startAt.toISOString(),
    end: endAt.toISOString(),
    minutes: Math.round((endAt.getTime() - startAt.getTime()) / 60_000),
  };
}

export const durationLabel = (minutes: number): string => formatMinutes(minutes);

// A new card starts with the project of the card the user last changed that had one (audit B-18).
export function lastUsedProjectId(
  cards: readonly CalendarItem[],
  projects: readonly Project[],
): string {
  const known = new Set(projects.map((project) => project.id));
  const latest = cards
    .filter((card) => card.projectId !== null && known.has(card.projectId))
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  return latest?.projectId ?? '';
}

const runStateLabels: Readonly<Record<WorkflowRun['state'], string>> = {
  running: 'is running',
  waiting: 'is waiting for you',
  done: 'is done',
  failed: 'failed',
  stopped: 'was stopped',
};

export type TriggerSummary =
  | { readonly tone: 'none' }
  | { readonly tone: 'warning'; readonly text: string }
  | { readonly tone: 'info'; readonly text: string }
  | { readonly tone: 'run'; readonly text: string; readonly runId: string };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// What the card will do (audit B-04): nothing, nothing for lack of a project, start a workflow at
// its start time, or how its run is doing.
export function triggerSummary({
  workflow,
  project,
  start,
  zone,
  run,
}: {
  workflow: Workflow | undefined;
  project: Project | undefined;
  start: string | undefined;
  zone: string;
  run: WorkflowRun | undefined;
}): TriggerSummary {
  if (run) {
    return { tone: 'run', text: `The workflow run ${runStateLabels[run.state]}.`, runId: run.id };
  }
  if (!workflow) return { tone: 'none' };
  if (!project) return { tone: 'warning', text: 'Will not run: pick a project.' };
  const gates = workflow.steps.reduce(
    (count, step) => count + (step.gateBefore ? 1 : 0) + (step.gateAfter ? 1 : 0),
    0,
  );
  const when = start
    ? `Starts at ${formatTime(new Date(start), zone)}`
    : 'Starts at the card start';
  const parts = [
    plural(workflow.steps.length, 'step'),
    ...(gates > 0 ? [plural(gates, 'gate')] : []),
  ];
  return { tone: 'info', text: `${when} in ${project.name} · ${parts.join(', ')}` };
}
