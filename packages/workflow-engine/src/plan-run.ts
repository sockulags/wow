import {
  isLivePlanRunState,
  type PlanIntent,
  type PlanRun,
  type PlanRunOnFailure,
  type PlanRunUnit,
  type PlanUnit,
  type Workflow,
  type WorkflowRunState,
} from '@wow/contracts';
import { RunRejected } from './engine.js';

// The plan run decisions (review loop spec 40 to 47). Pure: given the plan run, the plan's units
// with the status the hosts last gave them and what became of the unit's run, they answer the
// next plan run and the unit to start a run for. A plan run starts ordinary runs, one per unit
// and one at a time, and never the same unit twice.

export interface PlanRunStart {
  readonly intent: PlanIntent | undefined;
  readonly workflow: Workflow | undefined;
  // Which of the plan's files are stale, as a sentence, or null when none is.
  readonly staleReason: string | null;
  // A plan run is already running or waiting on this plan.
  readonly liveOnPlan: boolean;
}

// Why a plan run cannot start, or undefined when it can.
export function planRunRefusal(start: PlanRunStart): string | undefined {
  const { intent, workflow } = start;
  if (!intent) return 'This plan is no longer there';
  if (!workflow) return 'The workflow is no longer there';
  if (!workflow.forUnits) {
    return `Workflow ${workflow.name} is not marked "For units"; turn that on in the builder first`;
  }
  if (start.liveOnPlan) {
    return 'A plan run is already going on this plan, and a plan runs one unit at a time';
  }
  if (intent.plan === null) return 'This intent has no plan.md';
  if (intent.source === 'issues') {
    return 'This plan keeps its units in issues (source: issues), so wow cannot tell which unit is ready';
  }
  if (start.staleReason !== null) return `Not started: ${start.staleReason}`;
  if (intent.source === null) return 'plan.md cannot be read as a plan; see its problems';
  if (!intent.followed) {
    return 'Follow the plan first, so wow knows from its pull requests which units are ready';
  }
  if (intent.units.length === 0) return 'This plan has no units';
  if (intent.units.every((unit) => unit.status === 'delivered')) {
    return 'Every unit of this plan is delivered';
  }
  return undefined;
}

export interface PlanRunAdvance {
  readonly now: string;
  // The plan's units as they are now; undefined when the plan is gone.
  readonly units: readonly PlanUnit[] | undefined;
  // The state of the run of the unit that is `running` in the plan run; undefined when there is
  // no such run (any more).
  readonly unitRunState: WorkflowRunState | undefined;
  readonly onFailure: PlanRunOnFailure;
  // The id the next unit's run gets.
  readonly runIdFor: (unitKey: string) => string;
}

export interface PlanRunDecision {
  readonly planRun: PlanRun;
  // The unit to start a run for; it is already listed in the plan run as `running`.
  readonly start: PlanRunUnit | undefined;
}

const listed = (keys: readonly string[]): string =>
  keys.length <= 1
    ? keys.join('')
    : `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1] ?? ''}`;

// What a waiting plan run waits for: one sentence per unit that is not delivered, in plan order.
export function waitingSentences(
  started: readonly PlanRunUnit[],
  units: readonly PlanUnit[],
): string[] {
  if (units.length === 0) return ['The plan has no units to read'];
  const delivered = new Set(
    units.filter((unit) => unit.status === 'delivered').map((unit) => unit.key),
  );
  const outcomes = new Map(started.map((unit) => [unit.unitKey, unit.outcome]));
  return units.flatMap((unit): string[] => {
    const outcome = outcomes.get(unit.key);
    switch (unit.status) {
      case 'delivered':
        return [];
      case 'claimed':
        return [`${unit.key} waits for its pull request to merge`];
      case 'blocked':
        return [`${unit.key} is blocked: ${unit.statusReason}`];
      case 'waiting': {
        const missing = unit.dependsOn.filter((key) => !delivered.has(key));
        return missing.length > 0
          ? [`${unit.key} waits for ${listed(missing)} to merge`]
          : [`${unit.key}: ${unit.statusReason}`];
      }
      case 'ready':
        // Its run in this plan run is over and the hosts show no pull request for it. It is not
        // started a second time.
        if (outcome === 'done') return [`No pull request found for ${unit.key}`];
        if (outcome === 'failed') return [`The run for ${unit.key} failed`];
        if (outcome === 'stopped') return [`The run for ${unit.key} was stopped`];
        return [];
      case 'unknown':
        return [`${unit.key}: ${unit.statusReason}`];
    }
  });
}

const ended = (
  planRun: PlanRun,
  state: 'done' | 'failed' | 'stopped',
  units: PlanRunUnit[],
  message: string | null,
  now: string,
): PlanRun => ({ ...planRun, state, units, waitingFor: [], message, endedAt: now });

// Decides again what a live plan run does. Called when the run of its unit changes and when the
// plan's unit statuses do; a call that finds nothing new answers the plan run as it was.
export function advancePlanRun(planRun: PlanRun, input: PlanRunAdvance): PlanRunDecision {
  if (!isLivePlanRunState(planRun.state)) return { planRun, start: undefined };
  let units = planRun.units;
  const current = units.find((unit) => unit.outcome === 'running');
  if (current) {
    const state = input.unitRunState;
    if (state === 'running' || state === 'waiting') return { planRun, start: undefined };
    // A run that is no longer there cannot have delivered its unit.
    const outcome = state === 'done' ? 'done' : state === 'failed' ? 'failed' : 'stopped';
    units = units.map((unit) => (unit === current ? { ...unit, outcome } : unit));
    if (outcome !== 'done' && input.onFailure === 'stop') {
      const what = outcome === 'failed' ? 'failed' : 'was stopped';
      return {
        planRun: ended(
          planRun,
          'failed',
          units,
          `The run for ${current.unitKey} ${what}, so no further unit was started`,
          input.now,
        ),
        start: undefined,
      };
    }
  }
  if (!input.units) {
    return {
      planRun: ended(planRun, 'failed', units, 'The plan is no longer there', input.now),
      start: undefined,
    };
  }
  // A ready unit has every dependency delivered, so it never depends on a unit whose run failed
  // here and was left (spec 43).
  const before = new Set(units.map((unit) => unit.unitKey));
  const next = input.units.find((unit) => unit.status === 'ready' && !before.has(unit.key));
  if (next) {
    const start: PlanRunUnit = {
      unitKey: next.key,
      title: next.title,
      runId: input.runIdFor(next.key),
      outcome: 'running',
    };
    return {
      planRun: { ...planRun, state: 'running', units: [...units, start], waitingFor: [] },
      start,
    };
  }
  if (input.units.length > 0 && input.units.every((unit) => unit.status === 'delivered')) {
    return { planRun: ended(planRun, 'done', units, null, input.now), start: undefined };
  }
  return {
    planRun: {
      ...planRun,
      state: 'waiting',
      units,
      waitingFor: waitingSentences(units, input.units),
    },
    start: undefined,
  };
}

// Stop: the unit's run that is going is stopped by the caller, and no further unit starts.
export function stopPlanRun(planRun: PlanRun, now: string): PlanRun {
  if (!isLivePlanRunState(planRun.state)) {
    throw new RunRejected(`The plan run is already ${planRun.state}`);
  }
  const units = planRun.units.map((unit): PlanRunUnit =>
    unit.outcome === 'running' ? { ...unit, outcome: 'stopped' } : unit,
  );
  return ended(planRun, 'stopped', units, null, now);
}
