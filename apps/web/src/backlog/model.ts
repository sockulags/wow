import {
  BacklogState,
  type BacklogItem,
  type TrackerService,
  type WorkflowRun,
} from '@wow/contracts';
import {
  addDays,
  atMinute,
  clockTime,
  isoDate,
  localDate,
  minuteOfDay,
  parseClockTime,
  parseIsoDate,
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
  // Empty means every state.
  readonly state: BacklogState | '';
  readonly tag: string;
}

export const emptyFilter: BacklogFilter = { text: '', state: '', tag: '' };

export function filterItems(
  items: readonly BacklogItem[],
  filter: BacklogFilter,
): readonly BacklogItem[] {
  const needle = filter.text.trim().toLowerCase();
  return items.filter(
    (item) =>
      (filter.state === '' || item.state === filter.state) &&
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

// Where "Plan on calendar" puts the card: the date and start typed in the dialog, `minutes` long,
// in the calendar's zone. Returns a message instead when the form does not describe a time.
export function planRange(
  dateText: string,
  startText: string,
  minutes: number,
  zone: string,
): { readonly start: string; readonly end: string } | string {
  const date = parseIsoDate(dateText);
  const start = parseClockTime(startText);
  if (!date || start === undefined) return 'Give a date and a start time';
  if (!Number.isInteger(minutes) || minutes <= 0) return 'Give a length in minutes';
  const startAt = atMinute(date, start, zone);
  return {
    start: startAt.toISOString(),
    end: new Date(startAt.getTime() + minutes * MS_PER_MINUTE).toISOString(),
  };
}

const MS_PER_MINUTE = 60 * 1000;

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
