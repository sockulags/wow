import {
  changeRequestName,
  type ChangeRequest,
  type PlanIntent,
  type PlanRun,
  type Project,
  type Workflow,
} from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import type { AppCommand } from '@/app/commands';
import { safeHref } from '@/components/markdown';
import { livePlanRun, revisionLabel, runReadyUnitsBlocked, unitWorkflows } from './model';
import { askStopPlanRun, startPlanRun } from './plan-run';

export interface PlanCommandData {
  readonly intents: readonly PlanIntent[];
  readonly projects: readonly Project[];
  // The plan open in the Plans view, if any.
  readonly openIntent: PlanIntent | undefined;
  // What the host said, for the pull request links of the open plan's units.
  readonly changeRequests?: readonly ChangeRequest[] | undefined;
  // For "Run ready units" and Stop on the open plan.
  readonly planRuns?: readonly PlanRun[] | undefined;
  readonly workflows?: readonly Workflow[] | undefined;
}

// Palette commands for plans: read the files again and ask the hosts, every intent, and for the
// open plan Follow, "Run ready units" with each workflow for units, Stop for its plan run, the
// runs of its units, each unit's contract and each unit's pull request.
export function planCommands({
  intents,
  projects,
  openIntent,
  changeRequests = [],
  planRuns = [],
  workflows = [],
}: PlanCommandData): AppCommand[] {
  const commands: AppCommand[] = [
    {
      id: 'plans.refresh',
      title: 'Plans: Refresh now',
      group: 'Plans',
      keywords: ['plans', 'intents', 'units', 'reload', 'read again'],
      run: ({ connection }) =>
        void connection
          ?.request('plans.refresh', {})
          .then(() => connection.request('hosts.refresh', {}))
          .catch(() => {}),
    },
  ];
  if (openIntent) {
    const params = { projectId: openIntent.projectId, intentId: openIntent.intentId };
    commands.push({
      id: 'plans.follow',
      title: openIntent.followed ? 'Plan: stop following' : 'Plan: follow',
      group: 'Plans',
      keywords: ['follow', 'unfollow', 'pull requests', 'host', 'status', 'poll'],
      run: ({ connection }) => {
        if (!connection) return;
        void dispatch(connection, {
          type: 'plan.follow',
          planId: openIntent.id,
          followed: !openIntent.followed,
        }).catch(() => {});
      },
    });
    if (openIntent.followed) {
      commands.push({
        id: 'plans.refreshHost',
        title: 'Plan: refresh pull requests now',
        group: 'Plans',
        keywords: ['refresh', 'host', 'pull requests', 'github', 'fetch'],
        run: ({ connection }) =>
          void connection?.request('hosts.refresh', { planId: openIntent.id }).catch(() => {}),
      });
    }
    const planRun = livePlanRun(planRuns, openIntent.id);
    if (planRun) {
      commands.push({
        id: 'plans.planRun.stop',
        title: 'Plan: stop the plan run',
        group: 'Plans',
        keywords: ['plan run', 'stop', 'units', 'cancel'],
        run: () => askStopPlanRun(planRun.id),
      });
      for (const unit of planRun.units) {
        commands.push({
          id: `plans.planRun.unit.${unit.unitKey}`,
          title: `Open the run for ${unit.unitKey}: ${unit.title}`,
          group: 'Plans',
          keywords: ['plan run', 'unit', 'run', unit.unitKey],
          detail: 'Plan run',
          run: ({ navigate }) =>
            void navigate({ to: '/workflows/runs/$runId', params: { runId: unit.runId } }),
        });
      }
    } else if (runReadyUnitsBlocked(openIntent, planRuns, workflows) === undefined) {
      for (const workflow of unitWorkflows(workflows)) {
        commands.push({
          id: `plans.planRun.start.${workflow.id}`,
          title: `Plan: run ready units with ${workflow.name}`,
          group: 'Plans',
          keywords: ['plan run', 'ready', 'units', 'start', 'run', workflow.name],
          run: ({ connection }) => {
            if (!connection) return;
            void startPlanRun(
              (command) => dispatch(connection, command),
              openIntent.id,
              workflow.id,
            );
          },
        });
      }
    }
    for (const unit of openIntent.units) {
      const request = changeRequests.find((candidate) => candidate.id === unit.changeRequestId);
      const url = safeHref(request?.url);
      if (!request || url === undefined) continue;
      commands.push({
        id: `plans.unit.${unit.key}.changeRequest`,
        title: `Open ${changeRequestName(request).toLowerCase()} of ${unit.key} on the host`,
        group: 'Plans',
        keywords: ['pull request', 'merge request', 'host', 'github', 'gitlab', unit.key],
        detail: 'Unit',
        run: () => void window.open(url, '_blank', 'noreferrer'),
      });
    }
    for (const unit of openIntent.units) {
      commands.push({
        id: `plans.unit.${unit.key}`,
        title: `Unit ${unit.key}: ${unit.title}`,
        group: 'Plans',
        keywords: ['unit', 'contract', unit.key],
        detail: 'Unit',
        run: ({ navigate }) =>
          void navigate({ to: '/plans/$projectId/$intentId', params, search: { unit: unit.key } }),
      });
    }
  }
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  for (const intent of intents) {
    const project = projectNames.get(intent.projectId) ?? intent.projectId;
    commands.push({
      id: `plan.${intent.id}`,
      title: intent.title,
      value: `Plan ${intent.title} ${intent.intentId} ${project}`,
      group: 'Plans',
      keywords: ['plan', 'intent', 'spec', intent.intentId, project],
      detail: `Plan · ${project} · ${revisionLabel(intent.status, intent.rev)}`,
      searchOnly: true,
      run: ({ navigate }) =>
        void navigate({
          to: '/plans/$projectId/$intentId',
          params: { projectId: intent.projectId, intentId: intent.intentId },
        }),
    });
  }
  return commands;
}
