import { isLivePlanRunState, isLiveRunState } from '@wow/contracts';
import { randomUUID } from 'node:crypto';
import type { Commit, Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import { planRuns } from '../db/schema.js';
import type { BackgroundService } from '../hooks/index.js';
import type { Logger } from '../logger.js';

export interface PlanRunsDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly logger: Logger;
  // Asks the plan's host once and settles when the answer is stored (HostPoller.readPlan).
  readonly readPlan?: (planId: string) => Promise<void>;
}

// Tells live plan runs when something they depend on has changed (review loop spec 41): the run
// of their unit ended, or the plan's unit statuses did, which is how a host poll that shows a
// merge reaches them. It only sends `planRun.advance`; the orchestrator decides, and a call that
// finds nothing new stores nothing. After a unit's run ends the plan is read from its host
// first, so the next unit is picked from what the host shows now: the pull request the run
// opened, and a unit someone else claimed in the meantime (spec 42).
export class PlanRuns implements BackgroundService {
  readonly #deps: PlanRunsDeps;
  readonly #unsubscribe: () => void;
  // Plan runs whose unit's run ended and whose plan is being read from its host. A plan change
  // stored meanwhile does not advance them: its statuses are from before the read, and could
  // show ready a unit someone else has claimed since.
  readonly #reading = new Set<string>();
  // Unit runs whose end was seen. A run that has ended still changes (its working copy is
  // settled), and only its end asks the host.
  readonly #endedRuns = new Set<string>();
  #stopped = false;

  constructor(deps: PlanRunsDeps) {
    this.#deps = deps;
    this.#unsubscribe = deps.engine.onCommit((commit) => {
      const { ended, synced } = this.#touched(commit);
      for (const planRunId of synced) {
        if (!ended.has(planRunId) && !this.#reading.has(planRunId)) this.#advance(planRunId);
      }
      for (const [planRunId, planId] of ended) this.#unitRunEnded(planRunId, planId);
    });
  }

  // After a restart: whatever ended or changed while the server was down is looked at now.
  recover(): void {
    for (const planRun of this.#live()) this.#advance(planRun.id);
  }

  stop(): Promise<void> {
    this.#stopped = true;
    this.#unsubscribe();
    return Promise.resolve();
  }

  #live() {
    return this.#deps.db
      .select({ id: planRuns.id, planId: planRuns.planId, state: planRuns.state })
      .from(planRuns)
      .all()
      .filter((row) => isLivePlanRunState(row.state));
  }

  // Live plan runs whose unit's run ended in this commit (with their plan), and ones whose
  // plan's unit statuses changed.
  #touched(commit: Commit): { ended: Map<string, string>; synced: Set<string> } {
    const ended = new Map<string, string>();
    const synced = new Set<string>();
    const plans = new Set<string>();
    for (const { event } of commit.events) {
      if (event.kind === 'workflowRun.changed') {
        const { run } = event.payload;
        if (run.unit && !isLiveRunState(run.state) && !this.#endedRuns.has(run.id)) {
          this.#endedRuns.add(run.id);
          ended.set(run.unit.planRunId, run.unit.planId);
        }
      } else if (event.kind === 'plans.synced') {
        for (const intent of event.payload.upserted) plans.add(intent.id);
        for (const id of event.payload.removed) plans.add(id);
      }
    }
    if (plans.size > 0) {
      for (const planRun of this.#live()) if (plans.has(planRun.planId)) synced.add(planRun.id);
    }
    return { ended, synced };
  }

  #unitRunEnded(planRunId: string, planId: string): void {
    const { readPlan, logger } = this.#deps;
    if (!readPlan) {
      this.#advance(planRunId);
      return;
    }
    this.#reading.add(planRunId);
    void readPlan(planId)
      .catch((error: unknown) => logger.error('plan not read after a unit run', error))
      .then(() => {
        this.#reading.delete(planRunId);
        if (!this.#stopped) this.#advance(planRunId);
      });
  }

  #advance(planRunId: string): void {
    try {
      this.#deps.engine.dispatch(`planRun.advance:${planRunId}:${randomUUID()}`, {
        type: 'planRun.advance',
        planRunId,
      });
    } catch (error) {
      if (error instanceof CommandRejected) {
        this.#deps.logger.debug('plan run not advanced', { planRunId, reason: error.message });
      } else {
        this.#deps.logger.error('plan run advance failed', error);
      }
    }
  }
}
