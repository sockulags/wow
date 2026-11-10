import type { ChangeRequest, PlanIntent, Project } from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import type { AppCommand } from '@/app/commands';
import { safeHref } from '@/components/markdown';
import { revisionLabel } from './model';

export interface PlanCommandData {
  readonly intents: readonly PlanIntent[];
  readonly projects: readonly Project[];
  // The plan open in the Plans view, if any.
  readonly openIntent: PlanIntent | undefined;
  // What the host said, for the pull request links of the open plan's units.
  readonly changeRequests?: readonly ChangeRequest[] | undefined;
}

// Palette commands for plans: read the files again and ask the hosts, every intent, and for the
// open plan Follow, each unit's contract and each unit's pull request.
export function planCommands({
  intents,
  projects,
  openIntent,
  changeRequests = [],
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
    for (const unit of openIntent.units) {
      const request = changeRequests.find((candidate) => candidate.id === unit.changeRequestId);
      const url = safeHref(request?.url);
      if (!request || url === undefined) continue;
      commands.push({
        id: `plans.unit.${unit.key}.changeRequest`,
        title: `Open pull request #${request.number} of ${unit.key} on the host`,
        group: 'Plans',
        keywords: ['pull request', 'host', 'github', unit.key],
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
