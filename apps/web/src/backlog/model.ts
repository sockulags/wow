import {
  BacklogState,
  type BacklogItem,
  type CalendarItem,
  type TrackerService,
  type WorkHours,
  type WorkflowRun,
} from '@wow/contracts';
import {
  addDays,
  atMinute,
  clockTime,
  isoDate,
  localDate,
  MINUTES_PER_DAY,
  minuteOfDay,
  parseClockTime,
  parseIsoDate,
  weekdayOf,
} from '@/calendar/time';

// Pure helpers for the backlog view. Item state comes from the server: the user sets it while
// editing, "Plan on calendar" makes it planned, and the item follows its run (behavior 29).

export const backlogStates = BacklogState.options;

export const backlogStateLabels: Readonly<Record<BacklogState, string>> = {
  idea: 'Idea',
  planned: 'Planned',
  running: 'Running',
  done: 'Done',
  dropped: 'Dropped',
};

export const backlogStateDotClass: Readonly<Record<BacklogState, string>> = {
  idea: 'bg-muted-foreground/60',
  planned: 'bg-muted-foreground',
  running: 'bg-state-working',
  done: 'bg-state-done',
  dropped: 'bg-muted-foreground/30',
};

export const trackerNames: Readonly<Record<TrackerService, string>> = {
  jira: 'Jira',
  github: 'GitHub',
};

// Tags are typed as one comma-separated line.
export const parseTags = (text: string): string[] => [
  ...new Set(
    text
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== ''),
  ),
];

export const formatTags = (tags: readonly string[]): string => tags.join(', ');

export interface BacklogFilter {
  readonly text: string;
  // Empty means every state; 'open' hides done and dropped items.
  readonly state: BacklogState | '' | 'open';
  readonly tag: string;
}

export const emptyFilter: BacklogFilter = { text: '', state: 'open', tag: '' };

export function filterItems(
  items: readonly BacklogItem[],
  filter: BacklogFilter,
): readonly BacklogItem[] {
  const needle = filter.text.trim().toLowerCase();
  return items.filter(
    (item) =>
      (filter.state === '' ||
        (filter.state === 'open' ? isOpen(item) : item.state === filter.state)) &&
      (filter.tag === '' || item.tags.includes(filter.tag)) &&
      (needle === '' ||
        item.title.toLowerCase().includes(needle) ||
        item.body.toLowerCase().includes(needle) ||
        item.tags.some((tag) => tag.toLowerCase().includes(needle))),
  );
}

// Open work first (running, planned, ideas), finished and dropped last; newest first inside a
// state.
const stateOrder: Readonly<Record<BacklogState, number>> = {
  running: 0,
  planned: 1,
  idea: 2,
  done: 3,
  dropped: 4,
};

export const sortItems = (items: readonly BacklogItem[]): BacklogItem[] =>
  items.toSorted(
    (a, b) => stateOrder[a.state] - stateOrder[b.state] || b.createdAt.localeCompare(a.createdAt),
  );

export const allTags = (items: readonly BacklogItem[]): string[] =>
  [...new Set(items.flatMap((item) => item.tags))].toSorted((a, b) => a.localeCompare(b));

// Why the item's last run did not finish, when it did not: the failed step's error, or that it
// was stopped. Undefined while it runs or after it finished.
export function runProblem(run: WorkflowRun | undefined): string | undefined {
  if (!run) return undefined;
  if (run.state === 'failed') {
    const failed = run.steps.find((step) => step.state === 'failed');
    return `The run failed${failed?.error ? `: ${failed.error}` : '.'}`;
  }
  if (run.state === 'stopped') return 'The run was stopped.';
  return undefined;
}

// Where "Plan on calendar" puts the card: the date, start and end typed in the dialog, in the
// calendar's zone, like the card dialog. Returns a message instead when the form does not
// describe a time.
export function planRange(
  dateText: string,
  startText: string,
  endText: string,
  zone: string,
): { readonly start: string; readonly end: string } | string {
  const date = parseIsoDate(dateText);
  const start = parseClockTime(startText);
  const end = parseClockTime(endText);
  if (!date || start === undefined) return 'Give a date and a start time';
  if (end === undefined) return 'Give an end time';
  if (end <= start) return 'The end has to be after the start';
  return {
    start: atMinute(date, start, zone).toISOString(),
    end: atMinute(date, end, zone).toISOString(),
  };
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

// The workflow the user planned with last: the newest card made from a backlog item.
export function lastPlanningWorkflow(items: readonly CalendarItem[]): string | undefined {
  return (
    items
      .filter((item) => item.source === 'local' && item.backlogItemId !== null && item.workflowId)
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.workflowId ?? undefined
  );
}

// Owner decision F-12: the user sets an item to Idea or Dropped; Planned, Running and Done follow
// the item's card and run.
export const manualStates: readonly BacklogState[] = ['idea', 'dropped'];
export const isManualState = (state: BacklogState): boolean => manualStates.includes(state);

export const automaticStateHelp: Readonly<Record<BacklogState, string>> = {
  idea: 'Not planned yet.',
  dropped: 'Kept for reference; hidden from Open.',
  planned: "A card on the calendar runs its workflow at the card's time.",
  running: 'Its workflow run is in progress.',
  done: 'Its workflow run finished.',
};

// The list's default filter shows open items: not done and not dropped.
export const isOpen = (item: Pick<BacklogItem, 'state'>): boolean =>
  item.state !== 'done' && item.state !== 'dropped';

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
