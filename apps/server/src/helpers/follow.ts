import type { DomainEvent } from '@wow/contracts';
import { eq } from 'drizzle-orm';
import type { Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import { threads } from '../db/schema.js';
import type { Logger } from '../logger.js';

// Tells a main thread's agent when its helper ends a turn or asks a question (agent orchestration
// spec 3), as the assistant's follower does for the threads it started. It only sends
// `helper.followed`; what the message says, and whether there is one, is the engine's to decide.
export class HelperFollower {
  readonly #pending = new Set<Promise<void>>();
  readonly #unsubscribe: () => void;

  constructor(deps: { readonly db: Db; readonly engine: Engine; readonly logger: Logger }) {
    const isHelper = (threadId: string) =>
      deps.db
        .select({ startedBy: threads.startedBy })
        .from(threads)
        .where(eq(threads.id, threadId))
        .get()?.startedBy === 'helper';
    const follow = (event: DomainEvent, seq: number) => {
      const found =
        event.kind === 'turn.ended'
          ? { threadId: event.payload.threadId, reason: 'turnEnded' as const }
          : event.kind === 'question.asked'
            ? {
                threadId: event.payload.question.threadId,
                reason: 'question' as const,
                questionId: event.payload.question.id,
              }
            : event.kind === 'approval.requested'
              ? {
                  threadId: event.payload.approval.threadId,
                  reason: 'approval' as const,
                  approvalId: event.payload.approval.id,
                }
              : undefined;
      if (!found || !isHelper(found.threadId)) return;
      // After this commit, so the main thread's decision reads the helper's turn as ended.
      const work = Promise.resolve().then(() => {
        try {
          deps.engine.dispatch(`helper-follow:${found.threadId}:${seq}`, {
            type: 'helper.followed',
            ...found,
          });
        } catch (error) {
          if (!(error instanceof CommandRejected)) throw error;
          deps.logger.debug('helper.followed rejected', error.message);
        }
      });
      const tracked = work.catch((error: unknown) =>
        deps.logger.error('helper follow failed', error),
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
