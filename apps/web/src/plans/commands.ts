import type { PlanIntent, Project } from '@wow/contracts';
import type { AppCommand } from '@/app/commands';
import { revisionLabel } from './model';

export interface PlanCommandData {
  readonly intents: readonly PlanIntent[];
  readonly projects: readonly Project[];
  // The plan open in the Plans view, if any.
  readonly openIntent: PlanIntent | undefined;
}

// Palette commands for plans: read the files again, every intent, and for the open plan each
// unit's contract.
export function planCommands({ intents, projects, openIntent }: PlanCommandData): AppCommand[] {
  const commands: AppCommand[] = [
    {
      id: 'plans.refresh',
      title: 'Plans: Refresh now',
      group: 'Plans',
      keywords: ['plans', 'intents', 'units', 'reload', 'read again'],
      run: ({ connection }) => void connection?.request('plans.refresh', {}).catch(() => {}),
    },
  ];
  if (openIntent) {
    const params = { projectId: openIntent.projectId, intentId: openIntent.intentId };
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
