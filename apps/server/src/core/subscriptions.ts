import {
  inListOrder,
  isTurnSnapshot,
  subscriptionTopics,
  type SubscribeParams,
  type SubscriptionTopic,
} from '@wow/contracts';
import { asc, desc, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import * as t from '../db/schema.js';
import type { Engine } from './engine.js';
import { readOutlookStatus, skillOf } from './projector.js';
import { activitySources, threadActivityRows } from './thread-activity.js';
import { threadListStatuses } from './thread-list.js';

// The threads, each main thread with its place in the thread list (orchestrator threads spec 31).
function threadRows(db: Db) {
  const threads = db.select().from(t.threads).orderBy(asc(t.threads.createdAt)).all();
  const statuses = threadListStatuses(threads, openGates(db));
  return threads.map((thread) => {
    const listStatus = statuses.get(thread.id);
    return listStatus === undefined ? thread : { ...thread, listStatus };
  });
}

// The threads that hold a gate card whose approval or question still waits (spec 14): nobody
// answered it, and the turn that asked still runs. A turn that ends leaves its request unanswered,
// as the gate card says, but nobody can answer it any more.
function openGates(db: Db): Set<string> {
  // Each thread's running turn: a request counts only while the turn that asked it runs,
  // so a new turn in the same thread does not bring an old request back.
  const running = new Map(
    db
      .select({ threadId: t.turns.threadId, id: t.turns.id })
      .from(t.turns)
      .where(eq(t.turns.state, 'running'))
      .all()
      .map((row) => [row.threadId, row.id]),
  );
  if (running.size === 0) return new Set();
  const turnOf = (itemId: string) =>
    db
      .select({ turnId: t.threadItems.turnId })
      .from(t.threadItems)
      .where(eq(t.threadItems.id, itemId))
      .get()?.turnId;
  const waiting = (rows: readonly { id: string; threadId: string; itemId: string }[]) =>
    new Set(
      rows
        .filter(
          (row) => running.has(row.threadId) && turnOf(row.itemId) === running.get(row.threadId),
        )
        .map((row) => row.id),
    );
  const approvals = waiting(
    db
      .select({ id: t.approvals.id, threadId: t.approvals.threadId, itemId: t.approvals.itemId })
      .from(t.approvals)
      .where(isNull(t.approvals.decision))
      .all(),
  );
  const questions = waiting(
    db
      .select({ id: t.questions.id, threadId: t.questions.threadId, itemId: t.questions.itemId })
      .from(t.questions)
      .where(isNull(t.questions.answer))
      .all(),
  );
  if (approvals.size === 0 && questions.size === 0) return new Set();
  const open = new Set<string>();
  for (const { threadId, payload } of db
    .select({ threadId: t.threadItems.threadId, payload: t.threadItems.payload })
    .from(t.threadItems)
    .where(eq(t.threadItems.kind, 'gate_card'))
    .all()) {
    const card = payload as { kind?: unknown; requestId?: unknown } | null;
    if (typeof card?.requestId !== 'string') continue;
    const waits =
      card.kind === 'approval' ? approvals.has(card.requestId) : questions.has(card.requestId);
    if (waits) open.add(threadId);
  }
  return open;
}

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
        return threadRows(db);
      case 'turns':
        // The mark itself stays on the server; that it exists tells the client to read the
        // thread's Changes again. So does the provider's point: the client only needs to know
        // that Edit and Fork can go back to it, and the snapshots only that Restore can.
        return db
          .select()
          .from(t.turns)
          .where(eq(t.turns.threadId, threadId))
          .orderBy(asc(t.turns.index))
          .all()
          .map(({ fileMark, resumePoint, startSnapshot, endSnapshot: _end, ...turn }) => ({
            ...turn,
            marked: fileMark !== null,
            resumable: resumePoint !== null,
            restorable: isTurnSnapshot(startSnapshot),
          }));
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
      case 'calendarItems': {
        // A repeating card carries what happened at its occurrences.
        const history = new Map<string, unknown[]>();
        for (const { cardId, ...occurrence } of db
          .select()
          .from(t.cardOccurrences)
          .orderBy(asc(t.cardOccurrences.start))
          .all()) {
          const kept = history.get(cardId);
          if (kept) kept.push(occurrence);
          else history.set(cardId, [occurrence]);
        }
        return db
          .select()
          .from(t.calendarItems)
          .orderBy(asc(t.calendarItems.start))
          .all()
          .map((item) =>
            item.source === 'local' ? { ...item, occurrences: history.get(item.id) ?? [] } : item,
          );
      }
      case 'outlookStatus':
        return readOutlookStatus(db);
      case 'backlogItems':
        return db.select().from(t.backlogItems).orderBy(asc(t.backlogItems.createdAt)).all();
      case 'workflows':
        return db.select().from(t.workflows).orderBy(asc(t.workflows.name)).all();
      case 'triggers':
        // By the time they fire.
        return db
          .select()
          .from(t.triggers)
          .orderBy(asc(t.triggers.runAt), asc(t.triggers.id))
          .all();
      case 'notifications':
        // Newest first.
        return db.select().from(t.notifications).orderBy(desc(t.notifications.at)).all();
      case 'skills':
        // Yours first, then wow's own, then the folders (wow skills spec 1, 7).
        return inListOrder(db.select().from(t.skills).all().map(skillOf));
      case 'hostItemReads':
        return db
          .select()
          .from(t.hostItemReads)
          .where(eq(t.hostItemReads.threadId, threadId))
          .orderBy(asc(t.hostItemReads.id))
          .all();
      case 'threadTools':
        return db.select().from(t.threadTools).where(eq(t.threadTools.threadId, threadId)).all();
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
      case 'threadActivity':
        return threadActivityRows(db);
      case 'providerLimits':
        return db.select().from(t.providerLimits).all();
      case 'setupApplications': {
        // Without what Undo puts back: it holds real values and is the server's alone.
        const { parts: _parts, ...shown } = getTableColumns(t.setupApplications);
        return db
          .select(shown)
          .from(t.setupApplications)
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

  #changed(changed: ReadonlySet<SubscriptionTopic>): void {
    // The activity of threads at work is read from other topics, so it changes with them.
    const topics = new Set(changed);
    // A gate card is answered in the approvals or questions of the thread that asked.
    if (changed.has('approvals') || changed.has('questions')) topics.add('threads');
    if ([...changed].some((topic) => activitySources.has(topic as never))) {
      topics.add('threadActivity');
    }
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
