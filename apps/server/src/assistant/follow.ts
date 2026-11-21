import type { DomainEvent } from '@wow/contracts';
import { eq } from 'drizzle-orm';
import type { Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import { threads } from '../db/schema.js';
import type { Logger } from '../logger.js';

// Gives the assistant a turn when a thread it started ends a turn or asks for something (chief of
// staff spec 11 to 13). It only sends `assistant.follow`; whether a turn is given, and how many,
// is the engine's to decide.
export class DelegationFollower {
  readonly #pending = new Set<Promise<void>>();
  readonly #unsubscribe: () => void;

  constructor(deps: { readonly db: Db; readonly engine: Engine; readonly logger: Logger }) {
    const delegated = (threadId: string) =>
      deps.db
        .select({ startedBy: threads.startedBy })
        .from(threads)
        .where(eq(threads.id, threadId))
        .get()?.startedBy === 'assistant';
    const follow = (event: DomainEvent, seq: number) => {
      const found =
        event.kind === 'turn.ended'
          ? { threadId: event.payload.threadId, reason: 'turnEnded' as const }
          : event.kind === 'question.asked'
            ? { threadId: event.payload.question.threadId, reason: 'question' as const }
            : event.kind === 'approval.requested'
              ? { threadId: event.payload.approval.threadId, reason: 'approval' as const }
              : undefined;
      if (!found || !delegated(found.threadId)) return;
      const work = Promise.resolve().then(() => {
        try {
          deps.engine.dispatch(`follow:${found.threadId}:${seq}`, {
            type: 'assistant.follow',
            ...found,
          });
        } catch (error) {
          if (!(error instanceof CommandRejected)) throw error;
          deps.logger.debug('assistant.follow rejected', error.message);
        }
      });
      const tracked = work.catch((error: unknown) =>
        deps.logger.error('assistant follow failed', error),
      );
      this.#pending.add(tracked);
      void tracked.finally(() => this.#pending.delete(tracked));
    };
    this.#unsubscribe = deps.engine.onCommit((commit) => {
      for (const { event, seq } of commit.events) follow(event, seq);
    });
  }

  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all(this.#pending);
  }

  stop(): void {
    this.#unsubscribe();
  }
}
