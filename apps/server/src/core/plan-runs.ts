import { staleReason } from '@wow/agent-os';
import {
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

const ON_FAILURE_KEY = 'workflows.planRunOnFailure';

function onFailure(read: ReadModel, context: DecideContext, projectId: string): PlanRunOnFailure {
  const definition = context.registry[ON_FAILURE_KEY];
  if (!definition) throw new Error(`${ON_FAILURE_KEY} is missing from the settings registry`);
  const { value } = resolveStored(ON_FAILURE_KEY, definition, { projectId }, (scope) =>
    read.setting(ON_FAILURE_KEY, scope),
  );
  const parsed = PlanRunOnFailure.safeParse(value);
  return parsed.success ? parsed.data : PlanRunOnFailure.parse(definition.default);
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
  const current = planRun.units.find((unit) => unit.outcome === 'running');
  const decision = advancePlanRun(planRun, {
    now: context.now,
    units: intent?.units,
    unitRunState: current ? read.run(current.runId)?.state : undefined,
    onFailure: onFailure(read, context, planRun.projectId),
    runIdFor: (unitKey) => unitRunId(planRun.id, unitKey),
  });
  let next = decision.planRun;
  const runEvents: DomainEvent[] = [];
  const { start } = decision;
  if (start) {
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
      // A first unit that cannot start refuses the plan run; a later one ends it with the reason.
      if (!(error instanceof CommandRejected) || !before) throw error;
      next = {
        ...next,
        state: 'failed',
        units: next.units.map((unit) => (unit === start ? { ...unit, outcome: 'failed' } : unit)),
        message: `The run for ${start.unitKey} could not start: ${error.message}`,
        endedAt: context.now,
      };
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
      const current = planRun.units.find((unit) => unit.outcome === 'running');
      const run = current ? read.run(current.runId) : undefined;
      return [
        changed(command.type, stopped),
        // The unit's run stops as a run does (spec 45): its turn is interrupted, threads stay.
        ...(run && isLiveRunState(run.state)
          ? runInput(command.type, run.id, { type: 'stop' }, read, context)
          : []),
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
