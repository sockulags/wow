import type { DomainEvent, Project, SubscriptionTopic } from '@wow/contracts';
import { and, count, eq, isNull, max } from 'drizzle-orm';
import type { DbOrTx } from '../db/database.js';
import {
  approvals,
  projects,
  providerInstances,
  questions,
  settings,
  threadItems,
  threads,
  turns,
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
    case 'project.deleted':
      tx.delete(projects).where(eq(projects.id, event.payload.projectId)).run();
      tx.delete(settings)
        .where(eq(settings.scope, `project:${event.payload.projectId}`))
        .run();
      return ['projects', 'settings'];
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
    case 'providerInstance.created':
      tx.insert(providerInstances).values(event.payload).run();
      return ['providerInstances'];
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
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function readModel(tx: DbOrTx): ReadModel {
  return {
    project: (id): Project | undefined =>
      tx.select().from(projects).where(eq(projects.id, id)).get(),
    providerInstanceExists: (id) =>
      tx
        .select({ id: providerInstances.id })
        .from(providerInstances)
        .where(eq(providerInstances.id, id))
        .get() !== undefined,
    setting: (key, scope) =>
      tx
        .select({ value: settings.value })
        .from(settings)
        .where(and(eq(settings.key, key), eq(settings.scope, scope)))
        .get(),
    thread: (id) => tx.select().from(threads).where(eq(threads.id, id)).get(),
    runningTurn: (threadId) =>
      tx
        .select()
        .from(turns)
        .where(and(eq(turns.threadId, threadId), eq(turns.state, 'running')))
        .get(),
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
  };
}
