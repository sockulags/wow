import {
  isLiveRunState,
  type BacklogChanges,
  type BacklogItem,
  type BacklogState,
  type DomainEvent,
  type ServerCommand,
  type WorkflowRun,
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
            runId: null,
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
      if (read.backlogItemHasLiveRun(item.id)) {
        throw new CommandRejected('conflict', `${item.title} has a run in progress; stop it first`);
      }
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
      if (read.backlogItemHasLiveRun(item.id)) {
        throw new CommandRejected('conflict', `${item.title} has a run in progress`);
      }
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

// What a run means for its backlog item: running while the run is live, done when it finished,
// and back to planned when it failed or was stopped; the item keeps the run, so the failure can
// be shown (behavior 29).
function stateForRun(run: WorkflowRun): BacklogState {
  if (isLiveRunState(run.state)) return 'running';
  return run.state === 'done' ? 'done' : 'planned';
}

export function backlogFollowsRun(run: WorkflowRun, read: ReadModel): DomainEvent[] {
  if (run.backlogItemId === null) return [];
  const item = read.backlogItem(run.backlogItemId);
  if (!item) return [];
  const changes: BacklogChanges = {};
  const state = stateForRun(run);
  if (item.state !== state) changes.state = state;
  if (item.runId !== run.id) changes.runId = run.id;
  return updated(item.id, changes);
}
