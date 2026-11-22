import { staleReason } from '@wow/agent-os';
import {
  hostReadId,
  isLivePlanRunState,
  isLiveRunState,
  PlanRunOnFailure,
  type DomainEvent,
  type PlanRun,
  type ServerCommand,
} from '@wow/contracts';
import { advancePlanRun, planRunRefusal, stopPlanRun } from '@wow/workflow-engine';
import { isDeepStrictEqual } from 'node:util';
import { resolveStored } from '../settings/service.js';
import { closePlanEvents } from './hosts.js';
import { CommandRejected, type DecideContext, type ReadModel } from './orchestrator.js';
import { engineCall, runInput, startRunEvents } from './workflows.js';

// Decisions for plan runs (review loop spec 40 to 47). What a plan run does next comes from the
// pure workflow engine; this file looks things up and turns its answer into events. A unit's run
// is an ordinary run started here, in the same commit as the plan run's change.

type PlanRunCommand = Extract<ServerCommand, { type: `planRun.${string}` }>;

export const isPlanRunCommand = (command: ServerCommand): command is PlanRunCommand =>
  command.type.startsWith('planRun.');

// The id of the run a plan run starts for a unit. A unit is started once per plan run, so the
// same decision made twice cannot start two runs.
export const unitRunId = (planRunId: string, unitKey: string): string => `${planRunId}.${unitKey}`;

function projectSetting(
  key: 'workflows.planRunOnFailure' | 'workflows.planRunParallel',
  read: ReadModel,
  context: DecideContext,
  projectId: string,
): unknown {
  const definition = context.registry[key];
  if (!definition) throw new Error(`${key} is missing from the settings registry`);
  return resolveStored(key, definition, { projectId }, (scope) => read.setting(key, scope)).value;
}

function onFailure(read: ReadModel, context: DecideContext, projectId: string): PlanRunOnFailure {
  const parsed = PlanRunOnFailure.safeParse(
    projectSetting('workflows.planRunOnFailure', read, context, projectId),
  );
  return parsed.success ? parsed.data : 'stop';
}

// How many units' runs a plan run keeps live at once (agent orchestration spec 13).
function parallel(read: ReadModel, context: DecideContext, projectId: string): number {
  const value = projectSetting('workflows.planRunParallel', read, context, projectId);
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1;
}

const changed = (cause: string, planRun: PlanRun): DomainEvent => ({
  kind: 'planRun.changed',
  aggregate: planRun.id,
  payload: { cause, planRun },
});

// The events that take a plan run one decision further: its own change, the next unit's run when
// one starts, and the plan closing when the plan run ended on a plan nobody follows. `before` is
// the stored plan run, undefined for one that is just starting.
function advanceEvents(
  cause: string,
  before: PlanRun | undefined,
  planRun: PlanRun,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const intent = read.planIntents().find((candidate) => candidate.id === planRun.planId);
  const ends = planRun.units
    .map((unit) => read.run(unit.runId)?.endedAt ?? null)
    .filter((at): at is string => at !== null)
    .toSorted();
  const decision = advancePlanRun(planRun, {
    now: context.now,
    units: intent?.units,
    runState: (runId) => read.run(runId)?.state,
    onFailure: onFailure(read, context, planRun.projectId),
    limit: parallel(read, context, planRun.projectId),
    unitsReadAt:
      read.hostReads(planRun.projectId).find((row) => row.id === hostReadId('plan', planRun.planId))
        ?.fetchedAt ?? null,
    lastUnitEndedAt: ends.at(-1) ?? null,
    runIdFor: (unitKey) => unitRunId(planRun.id, unitKey),
  });
  let next = decision.planRun;
  const runEvents: DomainEvent[] = [];
  for (const start of decision.start) {
    try {
      runEvents.push(
        ...startRunEvents(
          cause,
          {
            runId: start.runId,
            workflowId: planRun.workflowId,
            projectId: planRun.projectId,
            unit: {
              planRunId: planRun.id,
              planId: planRun.planId,
              intentId: planRun.intentId,
              unitKey: start.unitKey,
              title: start.title,
            },
          },
          read,
          context,
        ),
      );
    } catch (error) {
      // A plan run whose first unit cannot start is refused. Otherwise the unit is marked failed
      // and no unit starts after it; the plan run ends with the reason once no unit's run is live.
      if (!(error instanceof CommandRejected) || (!before && runEvents.length === 0)) throw error;
      // Units after it in this decision were not started, so they are not listed either.
      const notStarted = new Set(
        decision.start.slice(decision.start.indexOf(start) + 1).map((unit) => unit.unitKey),
      );
      const units = next.units
        .filter((unit) => !notStarted.has(unit.unitKey))
        .map((unit) =>
          unit.unitKey === start.unitKey ? { ...unit, outcome: 'failed' as const } : unit,
        );
      const message = `The run for ${start.unitKey} could not start: ${error.message}`;
      next = units.some((unit) => unit.outcome === 'running')
        ? { ...next, state: 'running', units, message, waitingFor: [] }
        : { ...next, state: 'failed', units, message, waitingFor: [], endedAt: context.now };
      break;
    }
  }
  if (before && isDeepStrictEqual(before, next)) return [];
  return [
    changed(cause, next),
    ...runEvents,
    ...(isLivePlanRunState(next.state) ? [] : closePlanEvents(next.planId, read)),
  ];
}

export function decidePlanRun(
  command: PlanRunCommand,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  switch (command.type) {
    case 'planRun.start': {
      if (read.planRun(command.planRunId)) {
        throw new CommandRejected('conflict', `Plan run ${command.planRunId} already exists`);
      }
      const intent = read.planIntents().find((candidate) => candidate.id === command.planId);
      const refusal = planRunRefusal({
        intent,
        workflow: read.workflow(command.workflowId),
        staleReason: intent ? staleReason(intent) : null,
        liveOnPlan: read.livePlanRun(command.planId) !== undefined,
      });
      if (refusal !== undefined || !intent) {
        throw new CommandRejected('rejected', refusal ?? `No plan ${command.planId}`);
      }
      return advanceEvents(
        command.type,
        undefined,
        {
          id: command.planRunId,
          planId: intent.id,
          projectId: intent.projectId,
          intentId: intent.intentId,
          workflowId: command.workflowId,
          state: 'running',
          units: [],
          waitingFor: [],
          message: null,
          startedAt: context.now,
          endedAt: null,
        },
        read,
        context,
      );
    }
    case 'planRun.advance': {
      const planRun = requirePlanRun(read, command.planRunId);
      return advanceEvents(command.type, planRun, planRun, read, context);
    }
    case 'planRun.stop': {
      const planRun = requirePlanRun(read, command.planRunId);
      const stopped = engineCall(() => stopPlanRun(planRun, context.now));
      // Every unit's run that is going stops as a run does (spec 45): its turn is interrupted,
      // threads stay.
      const live = planRun.units.flatMap((unit) => {
        const run = unit.outcome === 'running' ? read.run(unit.runId) : undefined;
        return run && isLiveRunState(run.state) ? [run] : [];
      });
      return [
        changed(command.type, stopped),
        ...live.flatMap((run) => runInput(command.type, run.id, { type: 'stop' }, read, context)),
        ...closePlanEvents(stopped.planId, read),
      ];
    }
  }
}

function requirePlanRun(read: ReadModel, planRunId: string): PlanRun {
  const planRun = read.planRun(planRunId);
  if (!planRun) throw new CommandRejected('not_found', `No plan run ${planRunId}`);
  return planRun;
}
