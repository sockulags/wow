import type {
  CalendarItem,
  CardChanges,
  DomainEvent,
  MailItem,
  OutlookCalendarRow,
  ServerCommand,
} from '@wow/contracts';
import { isDeepStrictEqual } from 'node:util';
import { CommandRejected, type DecideContext, type ReadModel } from './orchestrator.js';
import { cardDeleteEvents, cardTriggerEvents } from './triggers.js';

// Decisions for local cards and the Outlook cache. Cards are the user's own calendar items and
// never reach Outlook; Outlook rows only change through `outlook.sync`, never through card
// commands, because Outlook is read-only (spec boundaries).

type CalendarCommand = Extract<
  ServerCommand,
  { type: 'card.create' | 'card.update' | 'card.delete' | 'outlook.sync' | 'outlook.fail' }
>;

export const isCalendarCommand = (command: ServerCommand): command is CalendarCommand =>
  (command.type.startsWith('card.') && command.type !== 'card.runNow') ||
  command.type.startsWith('outlook.');

// Outlook rows are `outlook:<id>` and mail rows `outlook-mail:<id>`; a card id may not look like
// either, so a card can never replace a cached Outlook row.
const outlookIdPrefix = 'outlook';

const OUTLOOK_STATUS_AGGREGATE = 'outlook';

const triggerFields = ['start', 'zone', 'projectId', 'workflowId'] as const;

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
  body: null,
  projectId: null,
  backlogItemId: null,
  workflowId: null,
  runId: null,
  updatedAt: at,
});

const withoutUpdatedAt = ({ updatedAt: _updatedAt, ...rest }: CalendarItem) => rest;

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

// The mail rail mirrors what is unread now, so anything not returned is gone.
export function diffMail(
  stored: readonly MailItem[],
  incoming: readonly MailItem[],
): { upsert: MailItem[]; remove: string[] } {
  const before = new Map(stored.map((row) => [row.id, row]));
  const seen = new Set(incoming.map((row) => row.id));
  return {
    upsert: incoming.filter((row) => {
      const old = before.get(row.id);
      return !old || !isDeepStrictEqual(old, row);
    }),
    remove: stored.filter((row) => !seen.has(row.id)).map((row) => row.id),
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
        projectId: command.projectId ?? null,
        backlogItemId: command.backlogItemId ?? null,
        workflowId: command.workflowId ?? null,
        runId: null,
        state: 'scheduled',
        updatedAt: context.now,
      };
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
      if (Object.keys(changes).length === 0) return [];
      const events: DomainEvent[] = [
        {
          kind: 'card.updated',
          aggregate: command.cardId,
          payload: { cardId: command.cardId, changes, updatedAt: context.now },
        },
      ];
      // Moving the card moves its trigger (spec 6); its workflow and project decide whether it
      // has one.
      if (triggerFields.some((field) => field in changes)) {
        events.push(...cardTriggerEvents(Object.assign({ ...card }, changes), read, context));
      }
      return events;
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
      const mail = diffMail(read.mailItems(), command.mail);
      return [
        {
          kind: 'outlook.synced',
          aggregate: OUTLOOK_STATUS_AGGREGATE,
          payload: {
            at: command.at,
            calendarUpsert: calendar.upsert,
            calendarRemove: calendar.remove,
            mailUpsert: mail.upsert,
            mailRemove: mail.remove,
            unreadCount: command.unreadCount,
            bridgeVersion: command.bridgeVersion,
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
