import {
  settingsRegistry,
  type DispatchResult,
  type DomainEvent,
  type ServerCommand,
  type SettingDefinition,
  type SubscriptionTopic,
} from '@wow/contracts';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/database.js';
import { commandReceipts, events } from '../db/schema.js';
import { CommandRejected, decide } from './orchestrator.js';
import { project, readModel } from './projector.js';

export interface StoredEvent {
  readonly seq: number;
  readonly at: string;
  readonly event: DomainEvent;
}

// Delivered after the transaction that produced the events has committed.
export interface Commit {
  readonly commandId: string;
  readonly events: readonly StoredEvent[];
  readonly topics: ReadonlySet<SubscriptionTopic>;
}

export type CommitListener = (commit: Commit) => void;

export interface EngineOptions {
  readonly registry?: Readonly<Record<string, SettingDefinition>>;
  readonly clock?: () => Date;
  // wow's own folder, for decisions that name a path inside it.
  readonly home?: string;
  readonly onListenerError?: (error: unknown) => void;
}

// Canonical JSON with sorted keys, so the same command always has the same fingerprint.
export function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : inner,
  );
}

// Command → events → projections. One SQLite transaction appends the events, updates the
// projections and records the command receipt; listeners hear about it only after commit.
export class Engine {
  readonly #db: Db;
  readonly #registry: Readonly<Record<string, SettingDefinition>>;
  readonly #clock: () => Date;
  readonly #home: string | undefined;
  readonly #onListenerError: (error: unknown) => void;
  readonly #listeners = new Set<CommitListener>();

  constructor(db: Db, options: EngineOptions = {}) {
    this.#db = db;
    this.#registry = options.registry ?? settingsRegistry;
    this.#clock = options.clock ?? (() => new Date());
    this.#home = options.home;
    // A failing listener must not undo or hide a committed command.
    this.#onListenerError =
      options.onListenerError ??
      ((error) => process.emitWarning(error instanceof Error ? error : String(error)));
  }

  onCommit(listener: CommitListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispatch(commandId: string, command: ServerCommand): DispatchResult {
    const print = fingerprint(command);
    const outcome = this.#db.transaction((tx) => {
      const receipt = tx
        .select()
        .from(commandReceipts)
        .where(eq(commandReceipts.commandId, commandId))
        .get();
      if (receipt) {
        if (receipt.fingerprint !== print) {
          throw new CommandRejected(
            'conflict',
            `Command id ${commandId} was already used for a different command`,
          );
        }
        return { duplicate: true, stored: [] as StoredEvent[], seqs: receipt.seqs, topics: [] };
      }

      const at = this.#clock().toISOString();
      const decided = decide(command, readModel(tx), {
        now: at,
        registry: this.#registry,
        home: this.#home,
      });
      const stored: StoredEvent[] = [];
      const topics: SubscriptionTopic[] = [];
      for (const event of decided) {
        const row = tx
          .insert(events)
          .values({ at, kind: event.kind, aggregate: event.aggregate, payload: event.payload })
          .returning({ seq: events.seq })
          .get();
        stored.push({ seq: row.seq, at, event });
        topics.push(...project(tx, event));
      }
      const seqs = stored.map((event) => event.seq);
      tx.insert(commandReceipts)
        .values({ commandId, commandType: command.type, fingerprint: print, seqs, at })
        .run();
      return { duplicate: false, stored, seqs, topics };
    });

    // better-sqlite3 transactions are synchronous: reaching this line means the commit happened.
    if (outcome.stored.length > 0) {
      const commit: Commit = { commandId, events: outcome.stored, topics: new Set(outcome.topics) };
      for (const listener of this.#listeners) {
        try {
          listener(commit);
        } catch (error) {
          this.#onListenerError(error);
        }
      }
    }
    return { commandId, seqs: outcome.seqs, duplicate: outcome.duplicate };
  }
}
