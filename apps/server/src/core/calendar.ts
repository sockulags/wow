import type {
  CalendarItem,
  CardChanges,
  DomainEvent,
  OutlookCalendarRow,
  ServerCommand,
} from '@wow/contracts';
import { isDeepStrictEqual } from 'node:util';
import { CommandRejected, type DecideContext, type ReadModel } from './orchestrator.js';
import {
  instantOf,
  localDay,
  occurrenceOn,
  wallClock,
  type Occurrence,
} from '../scheduler/occurrences.js';
import { isRepeating, seriesOf } from './series.js';
import { cardDeleteEvents, cardTriggerEvents, triggerIdFor } from './triggers.js';

// Decisions for local cards and the Outlook cache. Cards are the user's own calendar items and
// never reach Outlook; Outlook rows only change through `outlook.sync`, never through card
// commands, because Outlook is read-only (spec boundaries).

type CalendarCommand = Extract<
  ServerCommand,
  {
    type:
      | 'card.create'
      | 'card.update'
      | 'card.delete'
      | 'card.skipOccurrence'
      | 'card.moveOccurrence'
      | 'outlook.sync'
      | 'outlook.fail';
  }
>;

export const isCalendarCommand = (command: ServerCommand): command is CalendarCommand =>
  (command.type.startsWith('card.') && command.type !== 'card.runNow') ||
  command.type.startsWith('outlook.');

// Outlook rows are `outlook:<id>`; a card id may not look like one, so a card can never replace a
// cached Outlook row.
const outlookIdPrefix = 'outlook';

const OUTLOOK_STATUS_AGGREGATE = 'outlook';

const triggerFields = [
  'start',
  'end',
  'zone',
  'projectId',
  'workflowId',
  'repeat',
  'skippedDates',
] as const;

function requireCard(read: ReadModel, cardId: string): CalendarItem {
  const item = read.calendarItem(cardId);
  if (!item) throw new CommandRejected('not_found', `No card ${cardId}`);
  if (item.source !== 'local') {
    throw new CommandRejected('rejected', 'Outlook items are read-only');
  }
  return item;
}

function checkRange(start: string, end: string): void {
  if (Date.parse(end) <= Date.parse(start)) {
    throw new CommandRejected('rejected', 'A card must end after it starts');
  }
}

function checkZone(zone: string): void {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions();
  } catch {
    throw new CommandRejected('rejected', `${zone} is not a time zone`);
  }
}

// A rule whose end comes before its first occurrence would have no occurrence at all.
function checkRepeat(card: CalendarItem): void {
  const rule = card.repeat;
  if (!rule) return;
  checkZone(card.zone);
  if (rule.end.kind === 'on' && rule.end.date < localDay(card.start, card.zone)) {
    throw new CommandRejected(
      'rejected',
      `The repeat ends on ${rule.end.date}, before the card's first day`,
    );
  }
}

const sortedDays = (days: readonly string[]): string[] => [...new Set(days)].toSorted();

// The occurrence of a repeating card on a day, which must not have started yet.
function upcomingOccurrence(
  card: CalendarItem,
  date: string,
  read: ReadModel,
  context: DecideContext,
): Occurrence {
  if (!isRepeating(card)) {
    throw new CommandRejected('rejected', `"${card.title}" does not repeat`);
  }
  const occurrence = occurrenceOn(seriesOf(card), date);
  if (!occurrence) {
    throw new CommandRejected('rejected', `"${card.title}" has no occurrence on ${date}`);
  }
  const reached = read.cardOccurrences(card.id).some((done) => done.date === date);
  if (reached || Date.parse(occurrence.start) <= Date.parse(context.now)) {
    throw new CommandRejected(
      'rejected',
      `The occurrence of "${card.title}" on ${date} has already started`,
    );
  }
  return occurrence;
}

interface Links {
  readonly projectId?: string | null | undefined;
  readonly backlogItemId?: string | null | undefined;
  readonly workflowId?: string | null | undefined;
}

function checkLinks(read: ReadModel, links: Links): void {
  if (links.projectId && !read.project(links.projectId)) {
    throw new CommandRejected('not_found', `No project ${links.projectId}`);
  }
  if (links.backlogItemId && !read.backlogItem(links.backlogItemId)) {
    throw new CommandRejected('not_found', `No backlog item ${links.backlogItemId}`);
  }
  if (links.workflowId && !read.workflow(links.workflowId)) {
    throw new CommandRejected('not_found', `No workflow ${links.workflowId}`);
  }
}

const toCalendarItem = (row: OutlookCalendarRow, at: string): CalendarItem => ({
  ...row,
  source: 'outlook',
  projectId: null,
  backlogItemId: null,
  workflowId: null,
  runId: null,
  updatedAt: at,
});

// What Outlook says about a row: neither the time it was stored nor a card's own columns, which
// an Outlook row stores empty.
const withoutUpdatedAt = ({
  updatedAt: _updatedAt,
  repeat: _repeat,
  skippedDates: _skippedDates,
  nextAt: _nextAt,
  occurrences: _occurrences,
  ...rest
}: CalendarItem) => rest;

// Rows Outlook returned that are new or differ, and stored rows overlapping the polled window that
// Outlook no longer returns (deleted or moved there). Rows outside the window stay as history.
export function diffOutlookCalendar(
  stored: readonly CalendarItem[],
  incoming: readonly CalendarItem[],
  window: { readonly from: string; readonly to: string },
): { upsert: CalendarItem[]; remove: string[] } {
  const before = new Map(stored.map((row) => [row.id, row]));
  const seen = new Set(incoming.map((row) => row.id));
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  return {
    upsert: incoming.filter((row) => {
      const old = before.get(row.id);
      return !old || !isDeepStrictEqual(withoutUpdatedAt(old), withoutUpdatedAt(row));
    }),
    remove: stored
      .filter(
        (row) => !seen.has(row.id) && Date.parse(row.start) < to && Date.parse(row.end) > from,
      )
      .map((row) => row.id),
  };
}

function updateEvents(
  card: CalendarItem,
  changes: CardChanges,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  if (Object.keys(changes).length === 0) return [];
  const after: CalendarItem = Object.assign({ ...card }, changes);
  checkRepeat(after);
  const events: DomainEvent[] = [
    {
      kind: 'card.updated',
      aggregate: card.id,
      payload: { cardId: card.id, changes, updatedAt: context.now },
    },
  ];
  // A single card that already ran becomes a series whose first occurrence is that run.
  const trigger = read.trigger(triggerIdFor(card.id));
  if (
    !isRepeating(card) &&
    isRepeating(after) &&
    card.runId !== null &&
    trigger?.state === 'fired' &&
    !read.cardOccurrences(card.id).some((done) => done.date === localDay(card.start, card.zone))
  ) {
    events.push({
      kind: 'card.occurrenceRecorded',
      aggregate: card.id,
      payload: {
        cardId: card.id,
        occurrence: {
          date: localDay(card.start, card.zone),
          start: card.start,
          end: card.end,
          outcome: 'fired',
          runId: card.runId,
          reason: null,
          offerRunNow: false,
          at: context.now,
        },
      },
    });
  }
  // Moving the card moves its trigger (spec 6); its workflow and project decide whether it
  // has one, and a rule which occurrence it waits for.
  if (triggerFields.some((field) => field in changes)) {
    events.push(...cardTriggerEvents(after, read, context));
  }
  return events;
}

// The series after one of its occurrences moved within its day: every occurrence keeps the
// series' days and takes the moved one's local start time and length (recurring cards spec
// 11). The first day stays the first day.
function movedSeries(
  card: CalendarItem,
  occurrence: Occurrence,
  moved: { readonly start: string; readonly end: string },
  zone: string,
): { start: string; end: string } {
  const wall = wallClock(Date.parse(moved.start), zone);
  const first = wallClock(Date.parse(card.start), zone);
  const start =
    occurrence.start === card.start
      ? Date.parse(moved.start)
      : instantOf({ ...first, hour: wall.hour, minute: wall.minute, second: wall.second }, zone);
  const length = Date.parse(moved.end) - Date.parse(moved.start);
  return {
    start: new Date(start).toISOString(),
    end: new Date(start + length).toISOString(),
  };
}

export function decideCalendar(
  command: CalendarCommand,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  switch (command.type) {
    case 'card.create': {
      if (command.cardId.startsWith(outlookIdPrefix)) {
        throw new CommandRejected('rejected', `Card ids may not start with "${outlookIdPrefix}"`);
      }
      if (read.calendarItem(command.cardId)) {
        throw new CommandRejected('conflict', `Card ${command.cardId} already exists`);
      }
      checkRange(command.start, command.end);
      checkLinks(read, command);
      const card: CalendarItem = {
        id: command.cardId,
        source: 'local',
        externalId: null,
        title: command.title,
        start: command.start,
        end: command.end,
        zone: command.zone,
        allDay: false,
        location: null,
        joinUrl: null,
        body: command.body ?? null,
        organizer: null,
        projectId: command.projectId ?? null,
        backlogItemId: command.backlogItemId ?? null,
        workflowId: command.workflowId ?? null,
        runId: null,
        state: 'scheduled',
        updatedAt: context.now,
        repeat: command.repeat ?? null,
        skippedDates: sortedDays(command.skippedDates ?? []),
      };
      checkRepeat(card);
      return [
        { kind: 'card.created', aggregate: card.id, payload: card },
        ...cardTriggerEvents(card, read, context),
      ];
    }
    case 'card.update': {
      const card = requireCard(read, command.cardId);
      checkRange(command.start ?? card.start, command.end ?? card.end);
      checkLinks(read, command);
      const changes: CardChanges = {};
      const fields = [
        'title',
        'start',
        'end',
        'zone',
        'body',
        'projectId',
        'backlogItemId',
        'workflowId',
      ] as const;
      for (const field of fields) {
        const value = command[field];
        if (value !== undefined && value !== card[field])
          Object.assign(changes, { [field]: value });
      }
      if (command.repeat !== undefined && !isDeepStrictEqual(command.repeat, card.repeat ?? null)) {
        changes.repeat = command.repeat;
      }
      if (command.skippedDates !== undefined) {
        const days = sortedDays(command.skippedDates);
        if (!isDeepStrictEqual(days, card.skippedDates ?? [])) changes.skippedDates = days;
      }
      return updateEvents(card, changes, read, context);
    }
    case 'card.skipOccurrence': {
      const card = requireCard(read, command.cardId);
      upcomingOccurrence(card, command.date, read, context);
      const skipped = card.skippedDates ?? [];
      if (skipped.includes(command.date)) return [];
      return updateEvents(
        card,
        { skippedDates: sortedDays([...skipped, command.date]) },
        read,
        context,
      );
    }
    case 'card.moveOccurrence': {
      const card = requireCard(read, command.cardId);
      const occurrence = upcomingOccurrence(card, command.date, read, context);
      checkRange(command.start, command.end);
      if (localDay(command.start, card.zone) !== command.date) {
        throw new CommandRejected(
          'rejected',
          'An occurrence moves within its day; to move the series to other days, change its rule',
        );
      }
      const { start, end } = movedSeries(card, occurrence, command, card.zone);
      const changes: CardChanges = {};
      if (start !== card.start) changes.start = start;
      if (end !== card.end) changes.end = end;
      return updateEvents(card, changes, read, context);
    }
    case 'card.delete': {
      const card = requireCard(read, command.cardId);
      return [
        ...cardDeleteEvents(card, command.stopRun, read, context),
        { kind: 'card.deleted', aggregate: command.cardId, payload: { cardId: command.cardId } },
      ];
    }
    case 'outlook.sync': {
      const calendar = diffOutlookCalendar(
        read.outlookCalendarItems(),
        command.calendar.map((row) => toCalendarItem(row, command.at)),
        command.window,
      );
      return [
        {
          kind: 'outlook.synced',
          aggregate: OUTLOOK_STATUS_AGGREGATE,
          payload: {
            at: command.at,
            calendarUpsert: calendar.upsert,
            calendarRemove: calendar.remove,
            bridgeVersion: command.bridgeVersion,
            profile: command.profile,
          },
        },
      ];
    }
    case 'outlook.fail': {
      const lastError = command.message === '' ? command.code : command.message;
      const status = read.outlookStatus();
      // Every failed poll would otherwise add an identical event.
      if (status?.lastError === lastError && status.unavailableSince === command.unavailableSince) {
        return [];
      }
      return [
        {
          kind: 'outlook.failed',
          aggregate: OUTLOOK_STATUS_AGGREGATE,
          payload: { lastError, unavailableSince: command.unavailableSince },
        },
      ];
    }
  }
}
