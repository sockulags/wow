import {
  type CardOccurrence,
  isEventTrigger,
  isLivePlanRunState,
  isLiveRunState,
  touchPageRead,
  DomainEvent,
  TextItemPayload,
  type Project,
  type ProviderUpdateRun,
  type Skill,
  type SubscriptionTopic,
} from '@wow/contracts';
import { and, asc, count, desc, eq, gt, inArray, isNull, max, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/database.js';
import {
  approvals,
  assistantChanges,
  assistantProposals,
  setupApplications,
  assistantGreeting,
  backlogItems,
  calendarItems,
  cardOccurrences,
  changeRequests,
  events,
  hostReads,
  hostItemReads,
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
  ownText,
} from '../db/schema.js';
import type { ReadModel } from './orchestrator.js';

// The assistant thread is a row of the same table, shown through a topic of its own.
const threadTopics: SubscriptionTopic[] = ['threads', 'assistantThread'];

// A second approval in a thread that already needs the user does not restart its wait.
const stateSince = (state: string, at: string) =>
  sql`case when ${threads.state} = ${state} and ${threads.stateSince} is not null then ${threads.stateSince} else ${at} end`;

// Applies one event to the projection tables inside the caller's transaction and says which
// subscription topics changed.
// A skill as stored: a folder skill has no text, which the row keeps as null.
export function skillOf(row: typeof skills.$inferSelect): Skill {
  const { text, file, ...rest } = row;
  return { ...rest, ...(text === null ? {} : { text }), ...(file === null ? {} : { file }) };
}

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
    case 'skill.saved': {
      const { skill } = event.payload;
      const row = { ...skill, text: skill.text ?? null, file: skill.file ?? null };
      tx.insert(skills).values(row).onConflictDoUpdate({ target: skills.id, set: row }).run();
      return ['skills'];
    }
    case 'skill.deleted':
      tx.delete(skills).where(eq(skills.id, event.payload.skill.id)).run();
      return ['skills'];
    case 'skills.synced':
      for (const skill of event.payload.upserted) {
        const row = { ...skill, file: skill.file ?? null };
        tx.insert(skills).values(row).onConflictDoUpdate({ target: skills.id, set: row }).run();
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
    case 'hosts.itemRead': {
      const { read } = event.payload;
      tx.insert(hostItemReads)
        .values(read)
        .onConflictDoUpdate({ target: hostItemReads.id, set: read })
        .run();
      return ['hostItemReads'];
    }
    case 'tickets.synced':
      for (const read of event.payload.reads) {
        tx.insert(ticketReads)
          .values(read)
          .onConflictDoUpdate({ target: ticketReads.id, set: read })
          .run();
      }
      return ['ticketReads'];
    case 'pages.synced': {
      const { fetched } = event.payload;
      for (const id of fetched?.ids ?? []) {
        const stored = tx.select().from(pageReads).where(eq(pageReads.id, id)).get();
        if (!stored || !fetched) continue;
        const { fetchedAt, pages } = touchPageRead(stored, fetched.at);
        tx.update(pageReads).set({ fetchedAt, pages }).where(eq(pageReads.id, id)).run();
      }
      for (const read of event.payload.reads) {
        tx.insert(pageReads)
          .values(read)
          .onConflictDoUpdate({ target: pageReads.id, set: read })
          .run();
      }
      return ['pageReads'];
    }
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
      tx.insert(threads)
        .values({
          ...event.payload,
          stateSince: event.payload.stateSince ?? event.payload.createdAt,
        })
        .run();
      return threadTopics;
    case 'thread.configured':
      tx.update(threads)
        .set({ ...event.payload.changes, updatedAt: event.payload.updatedAt })
        .where(eq(threads.id, event.payload.threadId))
        .run();
      return threadTopics;
    case 'thread.providerChanged': {
      const { threadId, providerInstanceId, providerSessionId, model, effort } = event.payload;
      const { permissionMode, updatedAt } = event.payload;
      tx.update(threads)
        .set({ providerInstanceId, providerSessionId, model, effort, permissionMode, updatedAt })
        .where(eq(threads.id, threadId))
        .run();
      return threadTopics;
    }
    case 'thread.sessionStarted':
      tx.update(threads)
        .set({
          providerSessionId: event.payload.providerSessionId,
          updatedAt: event.payload.updatedAt,
        })
        .where(eq(threads.id, event.payload.threadId))
        .run();
      return threadTopics;
    case 'thread.pinned':
      tx.update(threads)
        .set({ pinned: event.payload.pinned })
        .where(eq(threads.id, event.payload.threadId))
        .run();
      return threadTopics;
    case 'thread.renamed':
      tx.update(threads)
        .set({ title: event.payload.title })
        .where(eq(threads.id, event.payload.threadId))
        .run();
      return threadTopics;
    case 'thread.archived':
      tx.update(threads)
        .set({ archived: event.payload.archived })
        .where(eq(threads.id, event.payload.threadId))
        .run();
      return threadTopics;
    case 'thread.seenChanged':
      tx.update(threads)
        .set({ seen: event.payload.seen })
        .where(eq(threads.id, event.payload.threadId))
        .run();
      return threadTopics;
    case 'thread.changesMarked': {
      const { threadId, turnId, base, mark } = event.payload;
      if (base) {
        tx.update(threads)
          .set({ baseSha: base.sha, baseFiles: base.files })
          .where(eq(threads.id, threadId))
          .run();
      }
      if (mark) tx.update(turns).set({ fileMark: mark }).where(eq(turns.id, turnId)).run();
      return ['turns'];
    }
    case 'thread.queueChanged':
      tx.update(threads)
        .set({ queued: event.payload.queued })
        .where(eq(threads.id, event.payload.threadId))
        .run();
      return threadTopics;
    case 'thread.stateChanged':
      tx.update(threads)
        .set({
          state: event.payload.state,
          stateSince: stateSince(event.payload.state, event.payload.updatedAt),
          updatedAt: event.payload.updatedAt,
        })
        .where(eq(threads.id, event.payload.threadId))
        .run();
      return threadTopics;
    case 'turn.started': {
      const { turn, item, settingsItem } = event.payload;
      tx.insert(turns).values(turn).run();
      if (settingsItem) tx.insert(threadItems).values(settingsItem).run();
      tx.insert(threadItems).values(item).run();
      tx.update(threads)
        .set({
          state: 'working',
          stateSince: stateSince('working', turn.startedAt),
          updatedAt: turn.startedAt,
        })
        .where(eq(threads.id, turn.threadId))
        .run();
      return ['turns', 'threadItems', ...threadTopics];
    }
    case 'turn.startedByProvider': {
      const { turn } = event.payload;
      tx.insert(turns).values(turn).run();
      tx.update(threads)
        .set({
          state: 'working',
          stateSince: stateSince('working', turn.startedAt),
          updatedAt: turn.startedAt,
        })
        .where(eq(threads.id, turn.threadId))
        .run();
      return ['turns', ...threadTopics];
    }
    case 'thread.backgroundChanged':
      tx.update(threads)
        .set({ backgroundTasks: event.payload.tasks, updatedAt: event.payload.updatedAt })
        .where(eq(threads.id, event.payload.threadId))
        .run();
      return threadTopics;
    case 'turn.interruptRequested':
    case 'thread.taskStopRequested':
    case 'thread.backgroundRequested':
      return [];
    case 'turn.usageRecorded':
      tx.update(turns)
        .set({ usage: event.payload.usage })
        .where(eq(turns.id, event.payload.turnId))
        .run();
      return ['turns'];
    case 'turn.ended': {
      const { threadId, turnId, state, threadState, endedAt, resumePoint } = event.payload;
      tx.update(turns)
        .set({ state, endedAt, ...(resumePoint === undefined ? {} : { resumePoint }) })
        .where(eq(turns.id, turnId))
        .run();
      tx.update(threadItems)
        .set({ streaming: false })
        .where(and(eq(threadItems.turnId, turnId), eq(threadItems.streaming, true)))
        .run();
      tx.update(threads)
        .set({
          state: threadState,
          stateSince: stateSince(threadState, endedAt),
          updatedAt: endedAt,
        })
        .where(eq(threads.id, threadId))
        .run();
      return ['turns', 'threadItems', ...threadTopics];
    }
    case 'turn.replaced':
      tx.update(turns)
        .set({ replacedBy: event.payload.by })
        .where(eq(turns.id, event.payload.turnId))
        .run();
      return ['turns'];
    case 'thread.goBackChanged':
      tx.update(threads)
        .set({ goBack: event.payload.goBack })
        .where(eq(threads.id, event.payload.threadId))
        .run();
      return threadTopics;
    case 'thread.historyCopied': {
      const { turns: copiedTurns, items } = event.payload;
      for (const turn of copiedTurns) tx.insert(turns).values(turn).run();
      for (const item of items) tx.insert(threadItems).values(item).run();
      return ['turns', 'threadItems'];
    }
    case 'threadItem.added':
      tx.insert(threadItems).values(event.payload).run();
      return ['threadItems'];
    case 'threadItem.appended': {
      const { itemId, field, delta, at } = event.payload;
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
          payload: {
            ...payload,
            [field]: (typeof before === 'string' ? before : '') + delta,
            ...(at === undefined ? {} : { endedAt: at }),
          },
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
    case 'question.answered': {
      tx.update(questions)
        .set({ answer: event.payload.answer, answeredAt: event.payload.answeredAt })
        .where(eq(questions.id, event.payload.questionId))
        .run();
      // The card shows what was picked and typed from its item; an answer from before the card
      // has only the row's text.
      const { reply } = event.payload;
      if (reply === undefined) return ['questions'];
      const row = tx
        .select()
        .from(questions)
        .where(eq(questions.id, event.payload.questionId))
        .get();
      const item = row && tx.select().from(threadItems).where(eq(threadItems.id, row.itemId)).get();
      if (!item || typeof item.payload !== 'object' || item.payload === null) return ['questions'];
      tx.update(threadItems)
        .set({ payload: { ...item.payload, reply } })
        .where(eq(threadItems.id, item.id))
        .run();
      return ['questions', 'threadItems'];
    }
    case 'card.created': {
      // The history and the next time are not the card's to set: they follow its occurrences
      // and its trigger.
      const { occurrences: _occurrences, nextAt: _nextAt, ...card } = event.payload;
      tx.insert(calendarItems).values(card).run();
      return ['calendarItems'];
    }
    case 'card.occurrenceRecorded': {
      const row = { cardId: event.payload.cardId, ...event.payload.occurrence };
      tx.insert(cardOccurrences)
        .values(row)
        .onConflictDoUpdate({ target: [cardOccurrences.cardId, cardOccurrences.date], set: row })
        .run();
      return ['calendarItems'];
    }
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
      // A card shows when its trigger fires next (recurring cards spec 9).
      if (event.payload.kind === 'card' && event.payload.calendarItemId !== null) {
        const nextAt = event.payload.state === 'scheduled' ? event.payload.runAt : null;
        const moved = tx
          .update(calendarItems)
          .set({ nextAt })
          .where(eq(calendarItems.id, event.payload.calendarItemId))
          .run();
        if (moved.changes > 0) return ['triggers', 'calendarItems'];
      }
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
    case 'assistant.greetingOwed':
      tx.insert(assistantGreeting)
        .values({ id: 1, owedAt: event.payload.at })
        .onConflictDoNothing()
        .run();
      return [];
    case 'assistant.greetingSent':
      tx.delete(assistantGreeting).run();
      return [];
    case 'setup.applied':
      tx.insert(setupApplications).values(event.payload).run();
      return ['setupApplications'];
    case 'setup.undone':
      tx.update(setupApplications)
        .set({ state: 'undone', undoneAt: event.payload.at })
        .where(eq(setupApplications.id, event.payload.applicationId))
        .run();
      return ['setupApplications'];
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

export function readCardOccurrences(tx: DbOrTx, cardId: string): CardOccurrence[] {
  return tx
    .select()
    .from(cardOccurrences)
    .where(eq(cardOccurrences.cardId, cardId))
    .orderBy(asc(cardOccurrences.start))
    .all()
    .map(({ cardId: _cardId, ...occurrence }) => occurrence);
}

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
    providerInstances: () =>
      tx
        .select()
        .from(providerInstances)
        .orderBy(sql`rowid`)
        .all(),
    instanceUsage: (id) => ({
      // The assistant thread does not hold an instance: it moves to another one (spec 27).
      threads:
        tx
          .select({ n: count() })
          .from(threads)
          .where(and(eq(threads.providerInstanceId, id), ne(threads.kind, 'assistant')))
          .get()?.n ?? 0,
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
    settingStored: (key) =>
      tx
        .select({ scope: settings.scope, value: settings.value })
        .from(settings)
        .where(eq(settings.key, key))
        .all(),
    skills: () => tx.select().from(skills).all().map(skillOf),
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
    hostItemRead: (id) => tx.select().from(hostItemReads).where(eq(hostItemReads.id, id)).get(),
    ticketReads: (projectId) =>
      tx.select().from(ticketReads).where(eq(ticketReads.projectId, projectId)).all(),
    pageReads: (projectId) =>
      tx.select().from(pageReads).where(eq(pageReads.projectId, projectId)).all(),
    changeRequests: (projectId) =>
      tx.select().from(changeRequests).where(eq(changeRequests.projectId, projectId)).all(),
    workflow: (id) => tx.select().from(workflows).where(eq(workflows.id, id)).get(),
    workflows: () =>
      tx
        .select()
        .from(workflows)
        .orderBy(sql`rowid`)
        .all(),
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
    setupApplication: (id) =>
      tx.select().from(setupApplications).where(eq(setupApplications.id, id)).get(),
    lastSetupApplication: () =>
      tx
        .select()
        .from(setupApplications)
        .where(eq(setupApplications.state, 'applied'))
        .orderBy(desc(setupApplications.at), desc(sql`rowid`))
        .get(),
    greetingOwed: () => tx.select().from(assistantGreeting).get() !== undefined,
    assistantProposal: (id) =>
      tx.select().from(assistantProposals).where(eq(assistantProposals.id, id)).get(),
    assistantAnswers: (since) => ({
      proposals: tx
        .select()
        .from(assistantProposals)
        .where(
          since === undefined
            ? ne(assistantProposals.state, 'pending')
            : gt(assistantProposals.answeredAt, since),
        )
        .orderBy(asc(assistantProposals.answeredAt))
        .all(),
      undone: tx
        .select()
        .from(assistantChanges)
        .where(
          since === undefined
            ? eq(assistantChanges.state, 'undone')
            : gt(assistantChanges.undoneAt, since),
        )
        .orderBy(asc(assistantChanges.undoneAt))
        .all(),
    }),
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
    threadsWithSession: (sessionId) =>
      tx.select().from(threads).where(eq(threads.providerSessionId, sessionId)).all(),
    runningTurn: (threadId) =>
      tx
        .select()
        .from(turns)
        .where(and(eq(turns.threadId, threadId), eq(turns.state, 'running')))
        .get(),
    lastTurn: (threadId) =>
      tx.select().from(turns).where(eq(turns.threadId, threadId)).orderBy(desc(turns.index)).get(),
    threadTurns: (threadId) =>
      tx.select().from(turns).where(eq(turns.threadId, threadId)).orderBy(asc(turns.index)).all(),
    threadItems: (threadId) =>
      tx
        .select()
        .from(threadItems)
        .where(eq(threadItems.threadId, threadId))
        .orderBy(asc(threadItems.index))
        .all(),
    turnCount: (threadId) =>
      tx.select({ n: count() }).from(turns).where(eq(turns.threadId, threadId)).get()?.n ?? 0,
    // The prompt is only in the stored event, which says what the provider was sent.
    lastSent: (threadId) => {
      const started = tx
        .select({ kind: events.kind, aggregate: events.aggregate, payload: events.payload })
        .from(events)
        .where(and(eq(events.kind, 'turn.started'), eq(events.aggregate, threadId)))
        .orderBy(desc(events.seq))
        .all();
      for (const row of started) {
        const event = DomainEvent.safeParse(row);
        if (!event.success || event.data.kind !== 'turn.started') continue;
        const { item, start } = event.data.payload;
        if (item.kind !== 'user') continue;
        const payload = TextItemPayload.safeParse(item.payload);
        if (!payload.success) continue;
        const { text, skills: sent } = payload.data;
        if (text.trim() !== '' || (sent ?? []).length > 0) {
          return { text, prompt: start.prompt, skills: sent };
        }
      }
      return undefined;
    },
    lastStart: (threadId) => {
      const row = tx
        .select({ kind: events.kind, aggregate: events.aggregate, payload: events.payload })
        .from(events)
        .where(and(eq(events.kind, 'turn.started'), eq(events.aggregate, threadId)))
        .orderBy(desc(events.seq))
        .limit(1)
        .get();
      const event = row ? DomainEvent.safeParse(row) : undefined;
      if (!event?.success || event.data.kind !== 'turn.started') return undefined;
      const { model, effort, permissionMode } = event.data.payload.start;
      return { model, effort, permissionMode };
    },
    nextItemIndex: (threadId) => {
      const last = tx
        .select({ index: max(threadItems.index) })
        .from(threadItems)
        .where(eq(threadItems.threadId, threadId))
        .get()?.index;
      return last === null || last === undefined ? 0 : last + 1;
    },
    threadItem: (id) => tx.select().from(threadItems).where(eq(threadItems.id, id)).get(),
    itemExists: (id) =>
      tx.select({ id: threadItems.id }).from(threadItems).where(eq(threadItems.id, id)).get() !==
      undefined,
    toolCallRow: (threadId, providerItemId) =>
      tx
        .select({ id: threadItems.id })
        .from(threadItems)
        .where(
          and(
            eq(threadItems.threadId, threadId),
            eq(threadItems.kind, 'tool_call'),
            sql`${threadItems.id} = ${threadItems.turnId} || ':' || ${providerItemId}`,
          ),
        )
        .orderBy(desc(threadItems.index))
        .get()?.id,
    turnTaskLists: (turnId) => {
      const lists = and(eq(threadItems.turnId, turnId), eq(threadItems.kind, 'task_list'));
      const total = tx.select({ n: count() }).from(threadItems).where(lists).get()?.n ?? 0;
      const last = tx
        .select({ payload: threadItems.payload })
        .from(threadItems)
        .where(lists)
        .orderBy(desc(threadItems.index))
        .limit(1)
        .get();
      return { count: total, last: last?.payload };
    },
    lastAssistantText: (turnId) =>
      tx
        .select()
        .from(threadItems)
        .where(and(eq(threadItems.turnId, turnId), eq(threadItems.kind, 'assistant_text'), ownText))
        .orderBy(desc(threadItems.index))
        .get(),
    approval: (id) => tx.select().from(approvals).where(eq(approvals.id, id)).get(),
    question: (id) => tx.select().from(questions).where(eq(questions.id, id)).get(),
    openRequests: (threadId) =>
      (tx
        .select({ n: count() })
        .from(approvals)
        .where(and(eq(approvals.threadId, threadId), isNull(approvals.decision)))
        .get()?.n ?? 0) +
      // A question left when its turn ended takes no answer any more, so nothing waits on it.
      (tx
        .select({ n: count() })
        .from(questions)
        .innerJoin(threadItems, eq(threadItems.id, questions.itemId))
        .innerJoin(turns, eq(turns.id, threadItems.turnId))
        .where(
          and(
            eq(questions.threadId, threadId),
            isNull(questions.answeredAt),
            eq(turns.state, 'running'),
          ),
        )
        .get()?.n ?? 0),
    calendarItem: (id) => tx.select().from(calendarItems).where(eq(calendarItems.id, id)).get(),
    cardOccurrences: (cardId) => readCardOccurrences(tx, cardId),
    outlookCalendarItems: () =>
      tx.select().from(calendarItems).where(eq(calendarItems.source, 'outlook')).all(),
    outlookStatus: () => readOutlookStatus(tx)[0],
  };
}
