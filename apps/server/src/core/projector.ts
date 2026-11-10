import {
  isEventTrigger,
  isLivePlanRunState,
  isLiveRunState,
  type DomainEvent,
  type Project,
  type ProviderUpdateRun,
  type SubscriptionTopic,
} from '@wow/contracts';
import { and, asc, count, desc, eq, inArray, isNull, max } from 'drizzle-orm';
import type { DbOrTx } from '../db/database.js';
import {
  approvals,
  assistantChanges,
  assistantProposals,
  backlogItems,
  calendarItems,
  changeRequests,
  hostReads,
  ticketReads,
  pageReads,
  notifications,
  outlookStatus,
  planIntents,
  planRuns,
  projects,
  providerInstances,
  questions,
  settings,
  skills,
  threadItems,
  threads,
  triggerEvents,
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
      tx.delete(hostReads).where(eq(hostReads.projectId, id)).run();
      tx.delete(changeRequests).where(eq(changeRequests.projectId, id)).run();
      tx.delete(ticketReads).where(eq(ticketReads.projectId, id)).run();
      tx.delete(pageReads).where(eq(pageReads.projectId, id)).run();
      // Its event triggers have nothing left to listen to. Card triggers have no project here;
      // the calendar cancels those.
      const gone = tx
        .select({ id: triggers.id })
        .from(triggers)
        .where(eq(triggers.projectId, id))
        .all()
        .map((row) => row.id);
      if (gone.length > 0) {
        tx.delete(triggerEvents).where(inArray(triggerEvents.triggerId, gone)).run();
        tx.delete(triggers).where(inArray(triggers.id, gone)).run();
      }
      return [
        'projects',
        'settings',
        'threads',
        'hostReads',
        'changeRequests',
        'ticketReads',
        'pageReads',
        'triggers',
      ];
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
    case 'plans.synced':
      for (const intent of event.payload.upserted) {
        tx.insert(planIntents)
          .values(intent)
          .onConflictDoUpdate({ target: planIntents.id, set: intent })
          .run();
      }
      if (event.payload.removed.length > 0) {
        tx.delete(planIntents).where(inArray(planIntents.id, event.payload.removed)).run();
      }
      return ['planIntents'];
    case 'hosts.synced': {
      const { payload } = event;
      for (const read of payload.reads) {
        tx.insert(hostReads)
          .values(read)
          .onConflictDoUpdate({ target: hostReads.id, set: read })
          .run();
      }
      if (payload.removedReads.length > 0) {
        tx.delete(hostReads).where(inArray(hostReads.id, payload.removedReads)).run();
      }
      for (const request of payload.changeRequests) {
        tx.insert(changeRequests)
          .values(request)
          .onConflictDoUpdate({ target: changeRequests.id, set: request })
          .run();
      }
      if (payload.removedChangeRequests.length > 0) {
        tx.delete(changeRequests)
          .where(inArray(changeRequests.id, payload.removedChangeRequests))
          .run();
      }
      return ['hostReads', 'changeRequests'];
    }
    case 'tickets.synced':
      for (const read of event.payload.reads) {
        tx.insert(ticketReads)
          .values(read)
          .onConflictDoUpdate({ target: ticketReads.id, set: read })
          .run();
      }
      return ['ticketReads'];
    case 'pages.synced':
      for (const read of event.payload.reads) {
        tx.insert(pageReads)
          .values(read)
          .onConflictDoUpdate({ target: pageReads.id, set: read })
          .run();
      }
      return ['pageReads'];
    case 'planRun.changed': {
      const { planRun } = event.payload;
      tx.insert(planRuns)
        .values(planRun)
        .onConflictDoUpdate({ target: planRuns.id, set: planRun })
        .run();
      return ['planRuns'];
    }
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
    case 'providerInstance.updateProgressed': {
      const { providerInstanceId, progress } = event.payload;
      const row = tx
        .select({ updateRun: providerInstances.updateRun })
        .from(providerInstances)
        .where(eq(providerInstances.id, providerInstanceId))
        .get();
      const run = row?.updateRun ?? null;
      let next: ProviderUpdateRun | null = run;
      if (progress.phase === 'started') {
        next = {
          state: 'running',
          command: progress.command,
          targetVersion: progress.targetVersion,
          output: '',
          message: null,
          startedAt: progress.at,
          endedAt: null,
        };
      } else if (run && progress.phase === 'output') {
        next = { ...run, output: run.output + progress.text };
      } else if (run && progress.phase === 'finished') {
        next = {
          ...run,
          state: progress.ok ? 'succeeded' : 'failed',
          message: progress.message,
          endedAt: progress.at,
        };
      }
      tx.update(providerInstances)
        .set({ updateRun: next })
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
    case 'trigger.deleted':
      tx.delete(triggerEvents).where(eq(triggerEvents.triggerId, event.payload.triggerId)).run();
      tx.delete(triggers).where(eq(triggers.id, event.payload.triggerId)).run();
      return ['triggers'];
    case 'trigger.eventSeen': {
      const { triggerId, eventId, runId, at } = event.payload;
      tx.insert(triggerEvents)
        .values({ triggerId, eventId, runId, at })
        .onConflictDoNothing()
        .run();
      return [];
    }
    case 'notification.sent':
      // A transition performed twice tells the user once.
      tx.insert(notifications).values(event.payload).onConflictDoNothing().run();
      return ['notifications'];
    case 'assistant.changed':
      tx.insert(assistantChanges).values(event.payload).run();
      return ['assistantChanges'];
    case 'assistant.changeUndone':
      tx.update(assistantChanges)
        .set({ state: 'undone', undoneAt: event.payload.at })
        .where(eq(assistantChanges.id, event.payload.changeId))
        .run();
      return ['assistantChanges'];
    case 'assistant.proposed':
      tx.insert(assistantProposals).values(event.payload).run();
      return ['assistantProposals'];
    case 'assistant.proposalAnswered': {
      const { proposalId, state, reason, at } = event.payload;
      tx.update(assistantProposals)
        .set({ state, reason, answeredAt: at })
        .where(eq(assistantProposals.id, proposalId))
        .run();
      return ['assistantProposals'];
    }
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
      const { calendarUpsert, calendarRemove } = event.payload;
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
      const status = {
        lastSyncAt: event.payload.at,
        lastError: null,
        unavailableSince: null,
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
    planIntents: () => tx.select().from(planIntents).all(),
    planRun: (id) => tx.select().from(planRuns).where(eq(planRuns.id, id)).get(),
    livePlanRun: (planId) =>
      tx
        .select()
        .from(planRuns)
        .where(eq(planRuns.planId, planId))
        .all()
        .find((row) => isLivePlanRunState(row.state)),
    hostReads: (projectId) =>
      tx.select().from(hostReads).where(eq(hostReads.projectId, projectId)).all(),
    ticketReads: (projectId) =>
      tx.select().from(ticketReads).where(eq(ticketReads.projectId, projectId)).all(),
    pageReads: (projectId) =>
      tx.select().from(pageReads).where(eq(pageReads.projectId, projectId)).all(),
    changeRequests: (projectId) =>
      tx.select().from(changeRequests).where(eq(changeRequests.projectId, projectId)).all(),
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
    assistantChange: (id) =>
      tx.select().from(assistantChanges).where(eq(assistantChanges.id, id)).get(),
    assistantProposal: (id) =>
      tx.select().from(assistantProposals).where(eq(assistantProposals.id, id)).get(),
    trigger: (id) => tx.select().from(triggers).where(eq(triggers.id, id)).get(),
    eventTriggers: (projectId) =>
      tx
        .select()
        .from(triggers)
        .where(eq(triggers.projectId, projectId))
        .orderBy(asc(triggers.createdAt), asc(triggers.id))
        .all()
        .filter(isEventTrigger),
    triggerEventSeen: (triggerId, eventId) =>
      tx
        .select({ at: triggerEvents.at })
        .from(triggerEvents)
        .where(and(eq(triggerEvents.triggerId, triggerId), eq(triggerEvents.eventId, eventId)))
        .get() !== undefined,
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
    outlookStatus: () => readOutlookStatus(tx)[0],
  };
}
