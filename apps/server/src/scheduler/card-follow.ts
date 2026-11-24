import type { DomainEvent } from '@wow/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import type { Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import { calendarItems, threads } from '../db/schema.js';
import type { Logger } from '../logger.js';

// What can change the state a card shows for its main thread (orchestrator threads spec 28): a
// turn starting or ending, and an approval, a question or a gate card coming or going.
const moves = new Set<DomainEvent['kind']>([
  'turn.started',
  'turn.ended',
  'approval.requested',
  'approval.answered',
  'question.asked',
  'question.answered',
  'question.answeredByAssistant',
  'threadItem.added',
  'thread.stateChanged',
]);

// The thread an event is about: its payload names it, else it is the event's aggregate.
function threadOf(event: DomainEvent): string {
  const payload = event.payload as {
    threadId?: unknown;
    approval?: { threadId?: unknown };
    question?: { threadId?: unknown };
  };
  for (const id of [payload.threadId, payload.approval?.threadId, payload.question?.threadId]) {
    if (typeof id === 'string') return id;
  }
  return event.aggregate;
}

// Keeps each card in step with the main thread it started: after a commit that may have moved a
// thread, the cards that follow that thread, or the main thread a helper of it works under, are
// asked to look again with `card.followThread`. The state
// is the engine's to decide; a card whose state stays the same commits nothing, so this never
// feeds itself.
export class CardFollower {
  readonly #pending = new Set<Promise<void>>();
  readonly #unsubscribe: () => void;

  constructor(deps: { readonly db: Db; readonly engine: Engine; readonly logger: Logger }) {
    // The thread and every thread above it, up to its main thread (a gate card from a helper
    // changes what its main thread's card shows).
    const withParents = (threadId: string): string[] => {
      const found: string[] = [];
      let id: string | null = threadId;
      while (id !== null && !found.includes(id)) {
        found.push(id);
        const row = deps.db
          .select({ parent: threads.parentThreadId })
          .from(threads)
          .where(eq(threads.id, id))
          .get();
        id = row?.parent ?? null;
      }
      return found;
    };
    const following = (threadIds: readonly string[]) =>
      deps.db
        .select({ id: calendarItems.id })
        .from(calendarItems)
        .where(and(eq(calendarItems.source, 'local'), inArray(calendarItems.threadId, threadIds)))
        .all();
    this.#unsubscribe = deps.engine.onCommit((commit) => {
      const moved = new Set(
        commit.events
          .filter(({ event }) => moves.has(event.kind))
          .map(({ event }) => threadOf(event)),
      );
      if (moved.size === 0) return;
      const seq = commit.events.at(-1)?.seq ?? 0;
      // After this commit, so the decision reads the thread as it is now.
      const work = Promise.resolve().then(() => {
        const ids = [...new Set([...moved].flatMap(withParents))];
        for (const { id } of following(ids)) {
          try {
            deps.engine.dispatch(`card-follow:${id}:${seq}`, {
              type: 'card.followThread',
              cardId: id,
            });
          } catch (error) {
            if (!(error instanceof CommandRejected)) throw error;
            deps.logger.debug('card.followThread rejected', error.message);
          }
        }
      });
      const tracked = work.catch((error: unknown) =>
        deps.logger.error('card follow failed', error),
      );
      this.#pending.add(tracked);
      void tracked.finally(() => this.#pending.delete(tracked));
    });
  }

  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all(this.#pending);
  }

  stop(): void {
    this.#unsubscribe();
  }
}
