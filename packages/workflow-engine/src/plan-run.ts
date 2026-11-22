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
// next plan run and the units to start runs for. A plan run starts ordinary runs, one per unit,
// up to `workflows.planRunParallel` live at once, and never the same unit twice.

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
    return 'A plan run is already going on this plan, and a plan has one plan run at a time';
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
  // The state of a unit's run by its id; undefined when there is no such run (any more).
  readonly runState: (runId: string) => WorkflowRunState | undefined;
  readonly onFailure: PlanRunOnFailure;
  // How many units' runs may be live at once (`workflows.planRunParallel`, agent orchestration
  // spec 13); below 1 counts as 1.
  readonly limit: number;
  // When the plan's host was last read, and when the last of the plan run's unit runs ended.
  // Statuses read before that end can show ready a unit someone else claimed meanwhile, so no
  // unit starts from them (review loop spec 42).
  readonly unitsReadAt: string | null;
  readonly lastUnitEndedAt: string | null;
  // The id the next unit's run gets.
  readonly runIdFor: (unitKey: string) => string;
}

export interface PlanRunDecision {
  readonly planRun: PlanRun;
  // The units to start runs for, in plan order; they are already listed in the plan run as
  // `running`.
  readonly start: readonly PlanRunUnit[];
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

// Decides again what a live plan run does. Called when the run of one of its units changes and
// when the plan's unit statuses do; a call that finds nothing new answers the plan run as it was.
// With `stop`, a unit's run that fails or is stopped sets the plan run's message: from then on no
// unit starts, and the plan run ends as failed once its other units' runs have ended (agent
// orchestration spec 14). A live plan run carries a message only then.
export function advancePlanRun(planRun: PlanRun, input: PlanRunAdvance): PlanRunDecision {
  if (!isLivePlanRunState(planRun.state)) return { planRun, start: [] };
  let { message } = planRun;
  const units = planRun.units.map((unit): PlanRunUnit => {
    if (unit.outcome !== 'running') return unit;
    const state = input.runState(unit.runId);
    if (state === 'running' || state === 'waiting') return unit;
    // A run that is no longer there cannot have delivered its unit.
    const outcome = state === 'done' ? 'done' : state === 'failed' ? 'failed' : 'stopped';
    if (outcome !== 'done' && input.onFailure === 'stop' && message === null) {
      const what = outcome === 'failed' ? 'failed' : 'was stopped';
      message = `The run for ${unit.unitKey} ${what}, so no further unit was started`;
    }
    return { ...unit, outcome };
  });
  const live = units.filter((unit) => unit.outcome === 'running');
  const unchanged = message === planRun.message && units.every((u, i) => u === planRun.units[i]);
  if (message !== null) {
    if (live.length === 0) {
      return { planRun: ended(planRun, 'failed', units, message, input.now), start: [] };
    }
    return {
      planRun: unchanged
        ? planRun
        : {
            ...planRun,
            state: 'running',
            units,
            message,
            waitingFor: [`Waits for the run of ${listed(live.map((u) => u.unitKey))} to end`],
          },
      start: [],
    };
  }
  if (!input.units) {
    if (live.length > 0) {
      return {
        planRun: {
          ...planRun,
          state: 'running',
          units,
          message: 'The plan is no longer there',
          waitingFor: [],
        },
        start: [],
      };
    }
    return {
      planRun: ended(planRun, 'failed', units, 'The plan is no longer there', input.now),
      start: [],
    };
  }
  // A ready unit has every dependency delivered, so it never depends on a unit whose run failed
  // here and was left, nor on one whose run is still going (spec 43).
  const before = new Set(units.map((unit) => unit.unitKey));
  const room = Math.max(1, Math.floor(input.limit)) - live.length;
  const ready = input.units.filter((unit) => unit.status === 'ready' && !before.has(unit.key));
  const next = room > 0 ? ready.slice(0, room) : [];
  const stale =
    input.lastUnitEndedAt !== null &&
    (input.unitsReadAt === null ||
      Date.parse(input.unitsReadAt) < Date.parse(input.lastUnitEndedAt));
  const first = next[0];
  if (first && stale) {
    return {
      planRun: {
        ...planRun,
        state: live.length > 0 ? 'running' : 'waiting',
        units,
        waitingFor: [`Reading the plan from its host before ${first.key} starts`],
      },
      start: [],
    };
  }
  if (next.length > 0) {
    const start = next.map((unit): PlanRunUnit => ({
      unitKey: unit.key,
      title: unit.title,
      runId: input.runIdFor(unit.key),
      outcome: 'running',
    }));
    return {
      planRun: { ...planRun, state: 'running', units: [...units, ...start], waitingFor: [] },
      start,
    };
  }
  if (live.length > 0) {
    return {
      planRun:
        unchanged && planRun.state === 'running' && planRun.waitingFor.length === 0
          ? planRun
          : { ...planRun, state: 'running', units, waitingFor: [] },
      start: [],
    };
  }
  if (input.units.length > 0 && input.units.every((unit) => unit.status === 'delivered')) {
    return { planRun: ended(planRun, 'done', units, null, input.now), start: [] };
  }
  return {
    planRun: {
      ...planRun,
      state: 'waiting',
      units,
      waitingFor: waitingSentences(units, input.units),
    },
    start: [],
  };
}

// Stop: the units' runs that are going are stopped by the caller, and no further unit starts.
export function stopPlanRun(planRun: PlanRun, now: string): PlanRun {
  if (!isLivePlanRunState(planRun.state)) {
    throw new RunRejected(`The plan run is already ${planRun.state}`);
  }
  const units = planRun.units.map((unit): PlanRunUnit =>
    unit.outcome === 'running' ? { ...unit, outcome: 'stopped' } : unit,
  );
  return ended(planRun, 'stopped', units, null, now);
}
