import {
  settingsRegistry,
  type CommandOrigin,
  type DispatchResult,
  type DomainEvent,
  type HostKind,
  type ServerCommand,
  type SettingDefinition,
  type SubscriptionTopic,
} from '@wow/contracts';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/database.js';
import { commandReceipts, events } from '../db/schema.js';
import { decideInSteps } from './assistant.js';
import { CommandRejected } from './orchestrator.js';
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
  // The code host a project's git data names, while no host read says (see DecideContext).
  readonly codeHost?: (projectId: string) => HostKind | undefined;
  readonly platform?: NodeJS.Platform;
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
  readonly #codeHost: ((projectId: string) => HostKind | undefined) | undefined;
  readonly #platform: NodeJS.Platform | undefined;
  readonly #onListenerError: (error: unknown) => void;
  readonly #listeners = new Set<CommitListener>();

  constructor(db: Db, options: EngineOptions = {}) {
    this.#db = db;
    this.#registry = options.registry ?? settingsRegistry;
    this.#clock = options.clock ?? (() => new Date());
    this.#home = options.home;
    this.#codeHost = options.codeHost;
    this.#platform = options.platform;
    // A failing listener must not undo or hide a committed command.
    this.#onListenerError =
      options.onListenerError ??
      ((error) => process.emitWarning(error instanceof Error ? error : String(error)));
  }

  onCommit(listener: CommitListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // `origin` says who sent the command. Every caller is the user unless it says otherwise; only
  // the assistant's tools do.
  dispatch(
    commandId: string,
    command: ServerCommand,
    origin: CommandOrigin = 'user',
  ): DispatchResult {
    // The user's commands keep the fingerprint they always had.
    const print = fingerprint(origin === 'user' ? command : { origin, command });
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
      const steps = decideInSteps(commandId, command, readModel(tx), {
        now: at,
        registry: this.#registry,
        home: this.#home,
        codeHost: this.#codeHost,
        platform: this.#platform,
        origin,
      });
      const stored: StoredEvent[] = [];
      const topics: SubscriptionTopic[] = [];
      // Each step decides on the projections as the steps before it left them.
      for (const decided of steps) {
        for (const event of decided) {
          const row = tx
            .insert(events)
            .values({ at, kind: event.kind, aggregate: event.aggregate, payload: event.payload })
            .returning({ seq: events.seq })
            .get();
          stored.push({ seq: row.seq, at, event });
          topics.push(...project(tx, event));
        }
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
