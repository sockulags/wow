import {
  isLiveRunState,
  type DomainEvent,
  type Project,
  type SubscriptionTopic,
} from '@wow/contracts';
import { and, count, desc, eq, inArray, isNull, max } from 'drizzle-orm';
import type { DbOrTx } from '../db/database.js';
import {
  approvals,
  backlogItems,
  calendarItems,
  mailItems,
  notifications,
  outlookStatus,
  projects,
  providerInstances,
  questions,
  settings,
  skills,
  threadItems,
  threads,
  triggers,
  turns,
  workflowRuns,
  workflows,
} from '../db/schema.js';
import type { ReadModel } from './orchestrator.js';

// Applies one event to the projection tables inside the caller's transaction and says which
// subscription topics changed.
export function project(tx: DbOrTx, event: DomainEvent): SubscriptionTopic[] {
  switch (event.kind) {
    case 'project.created':
      tx.insert(projects).values(event.payload).run();
      return ['projects'];
    case 'project.updated':
      tx.update(projects)
        .set(event.payload.changes)
        .where(eq(projects.id, event.payload.projectId))
        .run();
      return ['projects'];
    case 'project.deleted': {
      const id = event.payload.projectId;
      tx.delete(projects).where(eq(projects.id, id)).run();
      tx.delete(settings)
        .where(eq(settings.scope, `project:${id}`))
        .run();
      // A thread keeps its folder and becomes a folder thread; its history stays readable.
      tx.update(threads).set({ projectId: null }).where(eq(threads.projectId, id)).run();
      return ['projects', 'settings', 'threads'];
    }
    case 'setting.changed':
      tx.insert(settings)
        .values(event.payload)
        .onConflictDoUpdate({
          target: [settings.key, settings.scope],
          set: { value: event.payload.value },
        })
        .run();
      return ['settings'];
    case 'setting.reset':
      tx.delete(settings)
        .where(and(eq(settings.key, event.payload.key), eq(settings.scope, event.payload.scope)))
        .run();
      return ['settings'];
    case 'skills.synced':
      for (const skill of event.payload.upserted) {
        tx.insert(skills).values(skill).onConflictDoUpdate({ target: skills.id, set: skill }).run();
      }
      if (event.payload.removed.length > 0) {
        tx.delete(skills).where(inArray(skills.id, event.payload.removed)).run();
      }
      return ['skills'];
    case 'workflow.created':
      tx.insert(workflows).values(event.payload).run();
      return ['workflows'];
    case 'workflow.updated':
      tx.update(workflows)
        .set(event.payload.changes)
        .where(eq(workflows.id, event.payload.workflowId))
        .run();
      return ['workflows'];
    case 'workflow.deleted':
      tx.delete(workflows).where(eq(workflows.id, event.payload.workflowId)).run();
      return ['workflows'];
    case 'workflowRun.changed': {
      const { run } = event.payload;
      tx.insert(workflowRuns)
        .values(run)
        .onConflictDoUpdate({ target: workflowRuns.id, set: run })
        .run();
      return ['workflowRuns'];
    }
    case 'providerInstance.created':
      tx.insert(providerInstances).values(event.payload).run();
      return ['providerInstances'];
    case 'providerInstance.updated':
      tx.update(providerInstances)
        .set(event.payload.changes)
        .where(eq(providerInstances.id, event.payload.providerInstanceId))
        .run();
      return ['providerInstances'];
    case 'providerInstance.deleted': {
      const id = event.payload.providerInstanceId;
      tx.delete(providerInstances).where(eq(providerInstances.id, id)).run();
      tx.delete(settings)
        .where(eq(settings.scope, `provider:${id}`))
        .run();
      tx.update(projects)
        .set({ defaultProviderInstanceId: null })
        .where(eq(projects.defaultProviderInstanceId, id))
        .run();
      return ['providerInstances', 'settings', 'projects'];
    }
    case 'providerInstance.tested': {
      const { providerInstanceId, ...status } = event.payload;
      tx.update(providerInstances)
        .set(status)
        .where(eq(providerInstances.id, providerInstanceId))
        .run();
      return ['providerInstances'];
    }
    case 'thread.created':
      tx.insert(threads).values(event.payload).run();
      return ['threads'];
    case 'thread.configured':
      tx.update(threads)
        .set({ ...event.payload.changes, updatedAt: event.payload.updatedAt })
        .where(eq(threads.id, event.payload.threadId))
        .run();
      return ['threads'];
    case 'thread.sessionStarted':
      tx.update(threads)
        .set({
          providerSessionId: event.payload.providerSessionId,
          updatedAt: event.payload.updatedAt,
        })
        .where(eq(threads.id, event.payload.threadId))
        .run();
      return ['threads'];
    case 'thread.pinned':
      tx.update(threads)
        .set({ pinned: event.payload.pinned })
        .where(eq(threads.id, event.payload.threadId))
        .run();
      return ['threads'];
    case 'thread.stateChanged':
      tx.update(threads)
        .set({ state: event.payload.state, updatedAt: event.payload.updatedAt })
        .where(eq(threads.id, event.payload.threadId))
        .run();
      return ['threads'];
    case 'turn.started': {
      const { turn, item } = event.payload;
      tx.insert(turns).values(turn).run();
      tx.insert(threadItems).values(item).run();
      tx.update(threads)
        .set({ state: 'working', updatedAt: turn.startedAt })
        .where(eq(threads.id, turn.threadId))
        .run();
      return ['turns', 'threadItems', 'threads'];
    }
    case 'turn.interruptRequested':
      return [];
    case 'turn.usageRecorded':
      tx.update(turns)
        .set({ usage: event.payload.usage })
        .where(eq(turns.id, event.payload.turnId))
        .run();
      return ['turns'];
    case 'turn.ended': {
      const { threadId, turnId, state, threadState, endedAt } = event.payload;
      tx.update(turns).set({ state, endedAt }).where(eq(turns.id, turnId)).run();
      tx.update(threadItems)
        .set({ streaming: false })
        .where(and(eq(threadItems.turnId, turnId), eq(threadItems.streaming, true)))
        .run();
      tx.update(threads)
        .set({ state: threadState, updatedAt: endedAt })
        .where(eq(threads.id, threadId))
        .run();
      return ['turns', 'threadItems', 'threads'];
    }
    case 'threadItem.added':
      tx.insert(threadItems).values(event.payload).run();
      return ['threadItems'];
    case 'threadItem.appended': {
      const { itemId, field, delta } = event.payload;
      const row = tx
        .select({ payload: threadItems.payload })
        .from(threadItems)
        .where(eq(threadItems.id, itemId))
        .get();
      if (!row) return [];
      const payload = asRecord(row.payload);
      const before = payload[field];
      tx.update(threadItems)
        .set({
          payload: { ...payload, [field]: (typeof before === 'string' ? before : '') + delta },
        })
        .where(eq(threadItems.id, itemId))
        .run();
      return ['threadItems'];
    }
    case 'threadItem.patched': {
      const { itemId, patch, streaming } = event.payload;
      const row = tx
        .select({ payload: threadItems.payload })
        .from(threadItems)
        .where(eq(threadItems.id, itemId))
        .get();
      if (!row) return [];
      tx.update(threadItems)
        .set({
          payload: { ...asRecord(row.payload), ...patch },
          ...(streaming === undefined ? {} : { streaming }),
        })
        .where(eq(threadItems.id, itemId))
        .run();
      return ['threadItems'];
    }
    case 'approval.requested':
      tx.insert(approvals).values(event.payload.approval).run();
      tx.insert(threadItems).values(event.payload.item).run();
      return ['approvals', 'threadItems'];
    case 'approval.answered':
      tx.update(approvals)
        .set({ decision: event.payload.decision, decidedAt: event.payload.decidedAt })
        .where(eq(approvals.id, event.payload.approvalId))
        .run();
      return ['approvals'];
    case 'question.asked':
      tx.insert(questions).values(event.payload.question).run();
      tx.insert(threadItems).values(event.payload.item).run();
      return ['questions', 'threadItems'];
    case 'question.answered':
      tx.update(questions)
        .set({ answer: event.payload.answer, answeredAt: event.payload.answeredAt })
        .where(eq(questions.id, event.payload.questionId))
        .run();
      return ['questions'];
    case 'card.created':
      tx.insert(calendarItems).values(event.payload).run();
      return ['calendarItems'];
    case 'card.updated':
      tx.update(calendarItems)
        .set({ ...event.payload.changes, updatedAt: event.payload.updatedAt })
        .where(eq(calendarItems.id, event.payload.cardId))
        .run();
      return ['calendarItems'];
    case 'card.deleted':
      tx.delete(calendarItems).where(eq(calendarItems.id, event.payload.cardId)).run();
      return ['calendarItems'];
    case 'card.stateChanged': {
      const { cardId, ...changes } = event.payload;
      tx.update(calendarItems).set(changes).where(eq(calendarItems.id, cardId)).run();
      return ['calendarItems'];
    }
    case 'trigger.set':
      tx.insert(triggers)
        .values(event.payload)
        .onConflictDoUpdate({ target: triggers.id, set: event.payload })
        .run();
      return ['triggers'];
    case 'notification.sent':
      // A transition performed twice tells the user once.
      tx.insert(notifications).values(event.payload).onConflictDoNothing().run();
      return ['notifications'];
    case 'backlog.created':
      tx.insert(backlogItems).values(event.payload).run();
      return ['backlogItems'];
    case 'backlog.updated':
      tx.update(backlogItems)
        .set(event.payload.changes)
        .where(eq(backlogItems.id, event.payload.backlogItemId))
        .run();
      return ['backlogItems'];
    case 'backlog.deleted': {
      const id = event.payload.backlogItemId;
      tx.delete(backlogItems).where(eq(backlogItems.id, id)).run();
      // A card keeps its time and workflow; only the link to the deleted item goes.
      const cards = tx
        .update(calendarItems)
        .set({ backlogItemId: null })
        .where(eq(calendarItems.backlogItemId, id))
        .run();
      return cards.changes > 0 ? ['backlogItems', 'calendarItems'] : ['backlogItems'];
    }
    case 'backlog.published':
      tx.update(backlogItems)
        .set({ remote: event.payload.remote })
        .where(eq(backlogItems.id, event.payload.backlogItemId))
        .run();
      return ['backlogItems'];
    case 'outlook.synced': {
      const { calendarUpsert, calendarRemove, mailUpsert, mailRemove } = event.payload;
      const topics: SubscriptionTopic[] = ['outlookStatus'];
      for (const row of calendarUpsert) {
        tx.insert(calendarItems)
          .values(row)
          .onConflictDoUpdate({ target: calendarItems.id, set: row })
          .run();
      }
      if (calendarRemove.length > 0) {
        tx.delete(calendarItems)
          .where(
            and(inArray(calendarItems.id, calendarRemove), eq(calendarItems.source, 'outlook')),
          )
          .run();
      }
      if (calendarUpsert.length > 0 || calendarRemove.length > 0) topics.push('calendarItems');
      for (const row of mailUpsert) {
        tx.insert(mailItems)
          .values(row)
          .onConflictDoUpdate({ target: mailItems.id, set: row })
          .run();
      }
      if (mailRemove.length > 0)
        tx.delete(mailItems).where(inArray(mailItems.id, mailRemove)).run();
      if (mailUpsert.length > 0 || mailRemove.length > 0) topics.push('mailItems');
      const status = {
        lastSyncAt: event.payload.at,
        lastError: null,
        unavailableSince: null,
        unreadCount: event.payload.unreadCount,
        bridgeVersion: event.payload.bridgeVersion,
        // A poll that could not read the profile keeps the one stored.
        ...(event.payload.profile ? { profile: event.payload.profile } : {}),
      };
      tx.insert(outlookStatus)
        .values({ id: OUTLOOK_STATUS_ROW, ...status })
        .onConflictDoUpdate({ target: outlookStatus.id, set: status })
        .run();
      return topics;
    }
    case 'outlook.failed': {
      const status = {
        lastError: event.payload.lastError,
        unavailableSince: event.payload.unavailableSince,
      };
      tx.insert(outlookStatus)
        .values({ id: OUTLOOK_STATUS_ROW, ...status })
        .onConflictDoUpdate({ target: outlookStatus.id, set: status })
        .run();
      return ['outlookStatus'];
    }
  }
}

// `outlook_status` holds a single row.
const OUTLOOK_STATUS_ROW = 1;

const outlookStatusColumns = {
  lastSyncAt: outlookStatus.lastSyncAt,
  lastError: outlookStatus.lastError,
  unavailableSince: outlookStatus.unavailableSince,
  unreadCount: outlookStatus.unreadCount,
  bridgeVersion: outlookStatus.bridgeVersion,
  profile: outlookStatus.profile,
};

export function readOutlookStatus(tx: DbOrTx) {
  return tx.select(outlookStatusColumns).from(outlookStatus).all();
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function readModel(tx: DbOrTx): ReadModel {
  return {
    project: (id): Project | undefined =>
      tx.select().from(projects).where(eq(projects.id, id)).get(),
    projects: () => tx.select().from(projects).all(),
    projectCards: (id) =>
      tx
        .select()
        .from(calendarItems)
        .where(and(eq(calendarItems.source, 'local'), eq(calendarItems.projectId, id)))
        .all(),
    projectHasLiveRun: (id) =>
      tx
        .select({ state: workflowRuns.state })
        .from(workflowRuns)
        .where(eq(workflowRuns.projectId, id))
        .all()
        .some((row) => isLiveRunState(row.state)),
    providerInstanceExists: (id) =>
      tx
        .select({ id: providerInstances.id })
        .from(providerInstances)
        .where(eq(providerInstances.id, id))
        .get() !== undefined,
    providerInstance: (id) =>
      tx.select().from(providerInstances).where(eq(providerInstances.id, id)).get(),
    instanceUsage: (id) => ({
      threads:
        tx.select({ n: count() }).from(threads).where(eq(threads.providerInstanceId, id)).get()
          ?.n ?? 0,
      runningTurns:
        tx
          .select({ n: count() })
          .from(turns)
          .innerJoin(threads, eq(turns.threadId, threads.id))
          .where(and(eq(threads.providerInstanceId, id), eq(turns.state, 'running')))
          .get()?.n ?? 0,
    }),
    setting: (key, scope) =>
      tx
        .select({ value: settings.value })
        .from(settings)
        .where(and(eq(settings.key, key), eq(settings.scope, scope)))
        .get(),
    skills: () => tx.select().from(skills).all(),
    workflow: (id) => tx.select().from(workflows).where(eq(workflows.id, id)).get(),
    run: (id) => tx.select().from(workflowRuns).where(eq(workflowRuns.id, id)).get(),
    hasLiveRun: (workflowId) =>
      tx
        .select({ state: workflowRuns.state })
        .from(workflowRuns)
        .where(eq(workflowRuns.workflowId, workflowId))
        .all()
        .some((row) => isLiveRunState(row.state)),
    backlogItem: (id) => tx.select().from(backlogItems).where(eq(backlogItems.id, id)).get(),
    trigger: (id) => tx.select().from(triggers).where(eq(triggers.id, id)).get(),
    backlogItemHasLiveRun: (id) =>
      tx
        .select({ state: workflowRuns.state })
        .from(workflowRuns)
        .where(eq(workflowRuns.backlogItemId, id))
        .all()
        .some((row) => isLiveRunState(row.state)),
    thread: (id) => tx.select().from(threads).where(eq(threads.id, id)).get(),
    runningTurn: (threadId) =>
      tx
        .select()
        .from(turns)
        .where(and(eq(turns.threadId, threadId), eq(turns.state, 'running')))
        .get(),
    lastTurn: (threadId) =>
      tx.select().from(turns).where(eq(turns.threadId, threadId)).orderBy(desc(turns.index)).get(),
    turnCount: (threadId) =>
      tx.select({ n: count() }).from(turns).where(eq(turns.threadId, threadId)).get()?.n ?? 0,
    nextItemIndex: (threadId) => {
      const last = tx
        .select({ index: max(threadItems.index) })
        .from(threadItems)
        .where(eq(threadItems.threadId, threadId))
        .get()?.index;
      return last === null || last === undefined ? 0 : last + 1;
    },
    itemExists: (id) =>
      tx.select({ id: threadItems.id }).from(threadItems).where(eq(threadItems.id, id)).get() !==
      undefined,
    approval: (id) => tx.select().from(approvals).where(eq(approvals.id, id)).get(),
    question: (id) => tx.select().from(questions).where(eq(questions.id, id)).get(),
    openRequests: (threadId) =>
      (tx
        .select({ n: count() })
        .from(approvals)
        .where(and(eq(approvals.threadId, threadId), isNull(approvals.decision)))
        .get()?.n ?? 0) +
      (tx
        .select({ n: count() })
        .from(questions)
        .where(and(eq(questions.threadId, threadId), isNull(questions.answeredAt)))
        .get()?.n ?? 0),
    calendarItem: (id) => tx.select().from(calendarItems).where(eq(calendarItems.id, id)).get(),
    outlookCalendarItems: () =>
      tx.select().from(calendarItems).where(eq(calendarItems.source, 'outlook')).all(),
    mailItems: () => tx.select().from(mailItems).all(),
    outlookStatus: () => readOutlookStatus(tx)[0],
  };
}
