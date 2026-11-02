import type { ServerCommand, Trigger } from '@wow/contracts';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import { triggers } from '../db/schema.js';
import type { BackgroundService } from '../hooks/index.js';
import type { Logger } from '../logger.js';
import type { SettingsService } from '../settings/service.js';

// What the scheduler waits with; tests replace it so a tick runs only when they call `tick()`.
export interface SchedulerTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: SchedulerTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SchedulerDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly settings: SettingsService;
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly timers?: SchedulerTimers;
}

// Fires due triggers into workflow runs (spec 8) every `scheduler.tickSeconds`, and applies
// `scheduler.missedPolicy` to triggers whose time passed while nothing fired them: once at
// startup (the server was down) and when `scheduler.paused` is turned off (spec 12). The
// decisions are the orchestrator's; the scheduler only says which trigger is due when.
export class Scheduler implements BackgroundService {
  readonly #deps: SchedulerDeps;
  readonly #clock: () => Date;
  readonly #timers: SchedulerTimers;
  #timer: unknown;
  #paused = false;
  #running = false;
  #unsubscribe: (() => void) | undefined;

  constructor(deps: SchedulerDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? (() => new Date());
    this.#timers = deps.timers ?? realTimers;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#paused = this.#deps.settings.get('scheduler.paused');
    // While paused, what was missed waits for the resume.
    if (!this.#paused) this.applyMissed();
    this.#unsubscribe = this.#deps.settings.onChange((key) => {
      if (key === 'scheduler.tickSeconds') this.#schedule();
      if (key !== 'scheduler.paused') return;
      const paused = this.#deps.settings.get('scheduler.paused');
      const resumed = this.#paused && !paused;
      this.#paused = paused;
      if (resumed) this.applyMissed();
    });
    this.#schedule();
  }

  get paused(): boolean {
    return this.#paused;
  }

  // Fires every scheduled trigger whose time has come. Nothing fires while paused.
  tick(): void {
    if (this.#paused) return;
    for (const trigger of this.#due()) {
      const runId = randomUUID();
      this.#dispatch(`scheduler:fire:${trigger.id}:${runId}`, {
        type: 'trigger.fire',
        triggerId: trigger.id,
        runAt: trigger.runAt,
        runId,
      });
    }
  }

  // Hands every due trigger to the missed policy.
  applyMissed(): void {
    const policy = this.#deps.settings.get('scheduler.missedPolicy');
    for (const trigger of this.#due()) {
      const runId = randomUUID();
      this.#dispatch(`scheduler:missed:${trigger.id}:${runId}`, {
        type: 'trigger.applyMissed',
        triggerId: trigger.id,
        runAt: trigger.runAt,
        policy,
        runId,
      });
    }
  }

  stop(): Promise<void> {
    this.#running = false;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#clear();
    return Promise.resolve();
  }

  #due(): Trigger[] {
    const now = this.#clock().getTime();
    return this.#deps.db
      .select()
      .from(triggers)
      .where(eq(triggers.state, 'scheduled'))
      .all()
      .filter((trigger) => Date.parse(trigger.runAt) <= now)
      .toSorted((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt));
  }

  #schedule(): void {
    this.#clear();
    if (!this.#running) return;
    const delayMs = this.#deps.settings.get('scheduler.tickSeconds') * 1000;
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined;
      try {
        this.tick();
      } finally {
        this.#schedule();
      }
    }, delayMs);
  }

  #clear(): void {
    if (this.#timer === undefined) return;
    this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #dispatch(commandId: string, command: ServerCommand): void {
    try {
      this.#deps.engine.dispatch(commandId, command);
    } catch (error) {
      // One bad trigger must not keep the others from firing.
      if (error instanceof CommandRejected) {
        this.#deps.logger.warn(`${command.type} rejected`, error.message);
      } else {
        this.#deps.logger.error(`${command.type} failed`, error);
      }
    }
  }
}
