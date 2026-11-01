import type { DomainEvent, Project, SubscriptionTopic } from '@wow/contracts';
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/database.js';
import { projects, providerInstances, settings } from '../db/schema.js';
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
  };
}
