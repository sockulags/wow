import {
  type BacklogChanges,
  type BacklogItem,
  type BacklogState,
  type CalendarItem,
  type CardState,
  type DomainEvent,
  type ServerCommand,
} from '@wow/contracts';
import { isDeepStrictEqual } from 'node:util';
import { decideCalendar } from './calendar.js';
import { CommandRejected, type DecideContext, type ReadModel } from './orchestrator.js';

// Decisions for backlog items (behaviors 28 to 30). Nothing here talks to a tracker: publishing
// happens in the tracker service, which reports the created issue as `backlog.published`.

type BacklogCommand = Extract<ServerCommand, { type: `backlog.${string}` }>;

export const isBacklogCommand = (command: ServerCommand): command is BacklogCommand =>
  command.type.startsWith('backlog.');

function requireItem(read: ReadModel, backlogItemId: string): BacklogItem {
  const item = read.backlogItem(backlogItemId);
  if (!item) throw new CommandRejected('not_found', `No backlog item ${backlogItemId}`);
  return item;
}

const normalizeTags = (tags: readonly string[]): string[] => [
  ...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag !== '')),
];

const updated = (backlogItemId: string, changes: BacklogChanges): DomainEvent[] =>
  Object.keys(changes).length === 0
    ? []
    : [{ kind: 'backlog.updated', aggregate: backlogItemId, payload: { backlogItemId, changes } }];

export function decideBacklog(
  command: BacklogCommand,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  switch (command.type) {
    case 'backlog.create': {
      if (read.backlogItem(command.backlogItemId)) {
        throw new CommandRejected(
          'conflict',
          `Backlog item ${command.backlogItemId} already exists`,
        );
      }
      return [
        {
          kind: 'backlog.created',
          aggregate: command.backlogItemId,
          payload: {
            id: command.backlogItemId,
            title: command.title.trim(),
            body: command.body,
            tags: normalizeTags(command.tags),
            state: 'idea',
            remote: null,
            createdAt: context.now,
          },
        },
      ];
    }
    case 'backlog.update': {
      const item = requireItem(read, command.backlogItemId);
      const changes: BacklogChanges = {};
      const title = command.title?.trim();
      if (title !== undefined && title !== item.title) changes.title = title;
      if (command.body !== undefined && command.body !== item.body) changes.body = command.body;
      const tags = command.tags === undefined ? undefined : normalizeTags(command.tags);
      if (tags !== undefined && !isDeepStrictEqual(tags, item.tags)) changes.tags = tags;
      if (command.state !== undefined && command.state !== item.state)
        changes.state = command.state;
      return updated(item.id, changes);
    }
    case 'backlog.delete': {
      const item = requireItem(read, command.backlogItemId);
      return [{ kind: 'backlog.deleted', aggregate: item.id, payload: { backlogItemId: item.id } }];
    }
    case 'backlog.restore': {
      const { item } = command;
      if (read.backlogItem(item.id)) {
        throw new CommandRejected('conflict', `Backlog item ${item.id} already exists`);
      }
      return [{ kind: 'backlog.created', aggregate: item.id, payload: item }];
    }
    case 'backlog.plan': {
      const item = requireItem(read, command.backlogItemId);
      // The card goes through the calendar's own checks: id, time range, project and workflow.
      const card = decideCalendar(
        {
          type: 'card.create',
          cardId: command.cardId,
          title: item.title,
          start: command.start,
          end: command.end,
          zone: command.zone,
          projectId: command.projectId,
          backlogItemId: item.id,
          workflowId: command.workflowId,
        },
        read,
        context,
      );
      return [...card, ...updated(item.id, item.state === 'planned' ? {} : { state: 'planned' })];
    }
    case 'backlog.published': {
      const item = requireItem(read, command.backlogItemId);
      if (item.remote) {
        throw new CommandRejected(
          'conflict',
          `${item.title} is already published as ${item.remote.key}`,
          item.remote,
        );
      }
      return [
        {
          kind: 'backlog.published',
          aggregate: item.id,
          payload: { backlogItemId: item.id, remote: command.remote },
        },
      ];
    }
  }
}

// A backlog item planned on a card follows the main thread the card started (orchestrator
// threads spec 28): working or waiting is `running`, done is `done`,
// anything else leaves it planned.
export function backlogFollowsCard(
  card: Pick<CalendarItem, 'backlogItemId'>,
  state: CardState,
  read: ReadModel,
): DomainEvent[] {
  if (card.backlogItemId === null) return [];
  const item = read.backlogItem(card.backlogItemId);
  if (!item) return [];
  const next: BacklogState =
    state === 'running' || state === 'waiting' ? 'running' : state === 'done' ? 'done' : 'planned';
  return item.state === next ? [] : updated(item.id, { state: next });
}
