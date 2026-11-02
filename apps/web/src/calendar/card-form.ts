import type { CalendarItem, Project, Workflow, WorkflowRun } from '@wow/contracts';
import { addDays, atMinute, formatMinutes, formatTime, parseClockTime, parseIsoDate } from './time';

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
}

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
