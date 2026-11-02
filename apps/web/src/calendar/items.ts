import { CardState, type CalendarItem } from '@wow/contracts';
import { formatTime } from './time';

// How calendar items read in the grid and its popovers.

// What a card is, which decides what it shows (audit B-01): a trigger runs a workflow in a
// project, a card with a workflow but no project will not run, and a plain card is only time.
export type CardKind = 'trigger' | 'unrunnable' | 'plain';

export const cardKind = (card: CalendarItem): CardKind =>
  card.workflowId === null ? 'plain' : card.projectId === null ? 'unrunnable' : 'trigger';

export const cardState = (item: CalendarItem): CardState => {
  const parsed = CardState.safeParse(item.state);
  return parsed.success ? parsed.data : 'scheduled';
};

export const cardStateLabels: Readonly<Record<CardState, string>> = {
  scheduled: 'Scheduled',
  running: 'Running',
  waiting: 'Needs you',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  missed: 'Missed',
};

export const timeRange = (item: Pick<CalendarItem, 'start' | 'end'>, zone: string): string =>
  `${formatTime(new Date(item.start), zone)}–${formatTime(new Date(item.end), zone)}`;

const URL_PATTERN = /^\s*<?https?:\/\/\S+>?\s*$/i;

// Where a meeting is, for people: a Teams link or Outlook's "Microsoft Teams Meeting" both read
// "Teams meeting", another bare link "Online meeting", and a room stays as Outlook names it.
export function meetingPlace(location: string | null, joinUrl: string | null): string | null {
  if (!location) return joinUrl ? 'Teams meeting' : null;
  if (/^microsoft teams meeting$/i.test(location.trim())) return 'Teams meeting';
  if (URL_PATTERN.test(location)) {
    return /teams\.microsoft\.com/i.test(location) ? 'Teams meeting' : 'Online meeting';
  }
  return location;
}
