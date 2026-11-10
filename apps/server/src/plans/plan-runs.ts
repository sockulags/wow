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
}

// Tells live plan runs when something they depend on has changed (review loop spec 41): the run
// of their unit ended, or the plan's unit statuses did, which is how a host poll that shows a
// merge reaches them. It only sends `planRun.advance`; the orchestrator decides, and a call that
// finds nothing new stores nothing.
export class PlanRuns implements BackgroundService {
  readonly #deps: PlanRunsDeps;
  readonly #unsubscribe: () => void;

  constructor(deps: PlanRunsDeps) {
    this.#deps = deps;
    this.#unsubscribe = deps.engine.onCommit((commit) => {
      for (const planRunId of this.#touched(commit)) this.#advance(planRunId);
    });
  }

  // After a restart: whatever ended or changed while the server was down is looked at now.
  recover(): void {
    for (const planRun of this.#live()) this.#advance(planRun.id);
  }

  stop(): Promise<void> {
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

  #touched(commit: Commit): Set<string> {
    const ids = new Set<string>();
    const plans = new Set<string>();
    for (const { event } of commit.events) {
      if (event.kind === 'workflowRun.changed') {
        const { run } = event.payload;
        if (run.unit && !isLiveRunState(run.state)) ids.add(run.unit.planRunId);
      } else if (event.kind === 'plans.synced') {
        for (const intent of event.payload.upserted) plans.add(intent.id);
        for (const id of event.payload.removed) plans.add(id);
      }
    }
    if (plans.size > 0) {
      for (const planRun of this.#live()) if (plans.has(planRun.planId)) ids.add(planRun.id);
    }
    return ids;
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
