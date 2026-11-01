import {
  isLiveRunState,
  type DomainEvent,
  type Project,
  type SubscriptionTopic,
} from '@wow/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/database.js';
import {
  backlogItems,
  projects,
  providerInstances,
  settings,
  skills,
  threads,
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
    case 'thread.created':
      tx.insert(threads).values(event.payload).run();
      return ['threads'];
    case 'thread.stateChanged':
      tx.update(threads)
        .set({ state: event.payload.state, updatedAt: event.payload.updatedAt })
        .where(eq(threads.id, event.payload.threadId))
        .run();
      return ['threads'];
  }
}

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
    providerInstance: (id) =>
      tx.select().from(providerInstances).where(eq(providerInstances.id, id)).get(),
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
    threadExists: (id) =>
      tx.select({ id: threads.id }).from(threads).where(eq(threads.id, id)).get() !== undefined,
    backlogItem: (id) => tx.select().from(backlogItems).where(eq(backlogItems.id, id)).get(),
  };
}
