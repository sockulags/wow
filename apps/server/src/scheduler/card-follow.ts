import type { DomainEvent } from '@wow/contracts';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import { calendarItems } from '../db/schema.js';
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

// Keeps each card in step with the main thread it started: after a commit that may have moved a
// thread, every card that follows one is asked to look again with `card.followThread`. The state
// is the engine's to decide; a card whose state stays the same commits nothing, so this never
// feeds itself.
export class CardFollower {
  readonly #pending = new Set<Promise<void>>();
  readonly #unsubscribe: () => void;

  constructor(deps: { readonly db: Db; readonly engine: Engine; readonly logger: Logger }) {
    const following = () =>
      deps.db
        .select({ id: calendarItems.id })
        .from(calendarItems)
        .where(and(eq(calendarItems.source, 'local'), isNotNull(calendarItems.threadId)))
        .all();
    this.#unsubscribe = deps.engine.onCommit((commit) => {
      if (!commit.events.some(({ event }) => moves.has(event.kind))) return;
      const seq = commit.events.at(-1)?.seq ?? 0;
      // After this commit, so the decision reads the thread as it is now.
      const work = Promise.resolve().then(() => {
        for (const { id } of following()) {
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
