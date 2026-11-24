import { assistantThreadId, type DomainEvent, type ServerCommand } from '@wow/contracts';
import { eq } from 'drizzle-orm';
import type { Engine } from '../core/engine.js';
import {
  CommandRejected,
  decide,
  type DecideContext,
  type ReadModel,
} from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import * as t from '../db/schema.js';
import type { Logger } from '../logger.js';
import { decisionRowsWithoutBriefs, decisionSources } from './decisions.js';
import { settingValue, today } from './permissions.js';

// Briefs of the decision queue (chief of staff spec 18). When a decision the assistant can help
// with appears, wow asks it once for a brief, within `assistant.briefsPerDay`; the assistant reads
// what it needs and writes the brief with write_brief. It never answers the decision itself.

const briefed = new Set(['approval', 'question', 'gate', 'limit', 'failedRun']);

// False since the Assistant thread became a main thread: wow no longer asks it for briefs,
// briefing summaries or follow-up turns, which needed the assistant's own tools.
export const assistantAsked = false as boolean;

export function decideBriefRequest(
  command: Extract<ServerCommand, { type: 'assistant.requestBrief' }>,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  // The Assistant thread is a main thread without wow's assistant tools (orchestrator threads
  // spec 25), so it is not asked for what only those tools could write; this goes with them.
  if (!assistantAsked) return [];
  if (read.decisionBrief(command.decisionId)) return [];
  if (!read.thread(assistantThreadId)) return [];
  const limit = settingValue('assistant.briefsPerDay', read, context);
  if (typeof limit !== 'number' || read.briefsRequestedSince(today(read, context).since) >= limit) {
    return [];
  }
  const text = `From wow: this waits for the person (decision ${command.decisionId}): ${command.summary}. Read what you need (read_run, read_thread) and write its brief with write_brief: what the agent did, what the decision is, what to look at, and your recommendation in one sentence. Do not answer it; it is theirs.`;
  return [
    {
      kind: 'decision.briefRequested',
      aggregate: command.decisionId,
      payload: { decisionId: command.decisionId, at: context.now },
    },
    ...decide({ type: 'thread.sendMessage', threadId: assistantThreadId, text }, read, {
      ...context,
      origin: 'user',
    }),
  ];
}

export function decideWriteBrief(
  command: Extract<ServerCommand, { type: 'assistant.writeBrief' }>,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const brief = read.decisionBrief(command.decisionId);
  if (!brief) {
    throw new CommandRejected(
      'rejected',
      `wow did not ask for a brief of ${command.decisionId}; write one only when asked.`,
    );
  }
  if (brief.text !== null) throw new CommandRejected('conflict', 'That brief is written already.');
  return [
    {
      kind: 'decision.briefWritten',
      aggregate: command.decisionId,
      payload: {
        decisionId: command.decisionId,
        text: command.text,
        recommendation: command.recommendation,
        at: context.now,
      },
    },
  ];
}

// Asks for the brief of each new decision after a commit that can have made one.
export class BriefRequester {
  readonly #pending = new Set<Promise<void>>();
  readonly #unsubscribe: () => void;

  constructor(deps: { readonly db: Db; readonly engine: Engine; readonly logger: Logger }) {
    this.#unsubscribe = deps.engine.onCommit((commit) => {
      if (![...commit.topics].some((topic) => decisionSources.has(topic as never))) return;
      const work = Promise.resolve().then(() => {
        const asked = new Set(
          deps.db
            .select({ id: t.decisionBriefs.decisionId })
            .from(t.decisionBriefs)
            .all()
            .map((row) => row.id),
        );
        const assistant = deps.db
          .select({ id: t.threads.id })
          .from(t.threads)
          .where(eq(t.threads.id, assistantThreadId))
          .get();
        if (!assistant) return;
        for (const row of decisionRowsWithoutBriefs(deps.db)) {
          if (!briefed.has(row.kind) || asked.has(row.id)) continue;
          const summary = [row.title, row.where, ...row.fixed].filter(Boolean).join('; ');
          try {
            deps.engine.dispatch(`brief:${row.id}`, {
              type: 'assistant.requestBrief',
              decisionId: row.id,
              summary,
            });
          } catch (error) {
            if (!(error instanceof CommandRejected)) throw error;
            deps.logger.debug('assistant.requestBrief rejected', error.message);
          }
        }
      });
      const tracked = work.catch((error: unknown) =>
        deps.logger.error('asking for a brief failed', error),
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
