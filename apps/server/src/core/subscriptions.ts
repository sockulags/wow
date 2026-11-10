import { subscriptionTopics, type SubscribeParams, type SubscriptionTopic } from '@wow/contracts';
import { asc, desc, eq, getTableColumns, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import * as t from '../db/schema.js';
import type { Engine } from './engine.js';
import { readOutlookStatus } from './projector.js';

// Reads the current rows of a topic. Thread-scoped topics only read one thread.
export function snapshot(db: Db, params: SubscribeParams): unknown[] {
  const threadId = params.threadId ?? '';
  const rows = ((): unknown[] => {
    switch (params.topic) {
      case 'projects':
        return db.select().from(t.projects).orderBy(asc(t.projects.name)).all();
      case 'providerInstances':
        return db.select().from(t.providerInstances).orderBy(asc(t.providerInstances.name)).all();
      case 'threads':
        return db
          .select()
          .from(t.threads)
          .where(ne(t.threads.kind, 'assistant'))
          .orderBy(asc(t.threads.createdAt))
          .all();
      case 'assistantThread':
        return db.select().from(t.threads).where(eq(t.threads.kind, 'assistant')).all();
      case 'turns':
        return db
          .select()
          .from(t.turns)
          .where(eq(t.turns.threadId, threadId))
          .orderBy(asc(t.turns.index))
          .all();
      case 'threadItems':
        return db
          .select()
          .from(t.threadItems)
          .where(eq(t.threadItems.threadId, threadId))
          .orderBy(asc(t.threadItems.index))
          .all();
      case 'approvals':
        return db.select().from(t.approvals).where(eq(t.approvals.threadId, threadId)).all();
      case 'questions':
        return db.select().from(t.questions).where(eq(t.questions.threadId, threadId)).all();
      case 'calendarItems':
        return db.select().from(t.calendarItems).orderBy(asc(t.calendarItems.start)).all();
      case 'outlookStatus':
        return readOutlookStatus(db);
      case 'backlogItems':
        return db.select().from(t.backlogItems).orderBy(asc(t.backlogItems.createdAt)).all();
      case 'workflows':
        return db.select().from(t.workflows).orderBy(asc(t.workflows.name)).all();
      case 'workflowRuns':
        return db.select().from(t.workflowRuns).orderBy(asc(t.workflowRuns.startedAt)).all();
      case 'triggers':
        // Card triggers by their time, then event triggers in the order they were made.
        return db
          .select()
          .from(t.triggers)
          .orderBy(asc(t.triggers.runAt), asc(t.triggers.createdAt), asc(t.triggers.id))
          .all();
      case 'notifications':
        // Newest first.
        return db.select().from(t.notifications).orderBy(desc(t.notifications.at)).all();
      case 'skills':
        return db.select().from(t.skills).orderBy(asc(t.skills.name)).all();
      case 'planIntents':
        return db
          .select()
          .from(t.planIntents)
          .orderBy(asc(t.planIntents.projectId), asc(t.planIntents.intentId))
          .all();
      case 'planRuns':
        return db.select().from(t.planRuns).orderBy(asc(t.planRuns.startedAt)).all();
      case 'changeRequests':
        return db
          .select()
          .from(t.changeRequests)
          .orderBy(asc(t.changeRequests.projectId), asc(t.changeRequests.number))
          .all();
      case 'hostReads':
        return db.select().from(t.hostReads).orderBy(asc(t.hostReads.id)).all();
      case 'ticketReads':
        return db.select().from(t.ticketReads).orderBy(asc(t.ticketReads.id)).all();
      case 'pageReads':
        return db.select().from(t.pageReads).orderBy(asc(t.pageReads.id)).all();
      case 'assistantChanges': {
        // In the order they were made (spec 13): the insertion order of the table. Without what
        // Undo puts back: it holds real values and is the server's alone.
        const {
          expect: _expect,
          inverse: _inverse,
          ...shown
        } = getTableColumns(t.assistantChanges);
        return db
          .select(shown)
          .from(t.assistantChanges)
          .orderBy(sql`rowid`)
          .all();
      }
      case 'assistantProposals': {
        // Without the held command and what it was proposed for.
        const {
          command: _command,
          basis: _basis,
          ...shown
        } = getTableColumns(t.assistantProposals);
        return db
          .select(shown)
          .from(t.assistantProposals)
          .orderBy(sql`rowid`)
          .all();
      }
      case 'settings':
        return db
          .select()
          .from(t.settings)
          .orderBy(asc(t.settings.key), asc(t.settings.scope))
          .all();
    }
  })();
  // Rows leave the server only in their contract shape.
  const row = subscriptionTopics[params.topic].row;
  return rows.map((value) => row.parse(value));
}

export type Push = (subscriptionId: string, data: unknown[]) => void;

interface Subscription {
  readonly params: SubscribeParams;
  readonly push: Push;
}

// Keeps the open subscriptions and pushes a fresh snapshot of each affected topic after a commit.
export class Subscriptions {
  readonly #db: Db;
  readonly #open = new Map<string, Subscription>();

  constructor(db: Db, engine: Engine) {
    this.#db = db;
    engine.onCommit((commit) => this.#changed(commit.topics));
  }

  subscribe(params: SubscribeParams, push: Push): { subscriptionId: string; data: unknown[] } {
    const subscriptionId = randomUUID();
    this.#open.set(subscriptionId, { params, push });
    return { subscriptionId, data: snapshot(this.#db, params) };
  }

  unsubscribe(subscriptionId: string): boolean {
    return this.#open.delete(subscriptionId);
  }

  get size(): number {
    return this.#open.size;
  }

  #changed(topics: ReadonlySet<SubscriptionTopic>): void {
    const cache = new Map<string, unknown[]>();
    for (const [subscriptionId, subscription] of this.#open) {
      if (!topics.has(subscription.params.topic)) continue;
      const cacheKey = `${subscription.params.topic}:${subscription.params.threadId ?? ''}`;
      let data = cache.get(cacheKey);
      if (!data) {
        data = snapshot(this.#db, subscription.params);
        cache.set(cacheKey, data);
      }
      subscription.push(subscriptionId, data);
    }
  }
}
