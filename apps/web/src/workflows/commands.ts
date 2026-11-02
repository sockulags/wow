import type { Workflow, WorkflowRun, WorkflowTemplate } from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import type { AppCommand } from '@/app/commands';
import { gateOf, isLive, runStateLabels, sortRuns } from './model';

export interface WorkflowCommandData {
  readonly workflows: readonly Workflow[];
  readonly runs: readonly WorkflowRun[];
  readonly templates: readonly WorkflowTemplate[];
  // The run open in the run view, or the run waiting at a gate after the open thread's step.
  readonly openRun: WorkflowRun | undefined;
  // "14:39" for a run's start, in the calendar's zone.
  readonly formatWhen?: (iso: string) => string;
}

// Palette commands for workflows (spec 22): new workflow (blank or from a template), every
// workflow and run, refresh skills, and Continue and Stop for the open run.
export function workflowCommands({
  workflows,
  runs,
  templates,
  openRun,
  formatWhen = (iso) => iso,
}: WorkflowCommandData): AppCommand[] {
  const commands: AppCommand[] = [
    {
      id: 'workflows.new',
      title: 'New workflow',
      group: 'Workflows',
      keywords: ['workflow', 'builder', 'create'],
      run: ({ navigate }) => void navigate({ to: '/workflows/new' }),
    },
    {
      id: 'workflows.refreshSkills',
      title: 'Refresh skills',
      group: 'Workflows',
      keywords: ['skills', 'scan', 'rescan', 'reload'],
      run: ({ connection }) => void connection?.request('skills.refresh', {}).catch(() => {}),
    },
  ];
  for (const template of templates) {
    commands.push({
      id: `workflows.new.${template.kind}`,
      title: `New workflow from template: ${template.name}`,
      value: `New workflow from template ${template.name} ${template.kind}`,
      group: 'Workflows',
      keywords: ['workflow', 'template', template.kind],
      run: ({ navigate }) =>
        void navigate({ to: '/workflows/new', search: { template: template.kind } }),
    });
  }

  if (openRun && isLive(openRun)) {
    const runId = openRun.id;
    if (gateOf(openRun)) {
      commands.push({
        id: 'workflowRun.continue',
        title: 'Continue run',
        group: 'Workflows',
        keywords: ['gate', 'next step', 'resume'],
        keybinding: 'keybindings.continueRun',
        run: ({ connection }) => {
          if (connection) void dispatch(connection, { type: 'workflowRun.continue', runId });
        },
      });
    }
    commands.push({
      id: 'workflowRun.stop',
      title: 'Stop run',
      group: 'Workflows',
      keywords: ['cancel', 'abort', 'gate'],
      keybinding: 'keybindings.stopRun',
      run: ({ connection }) => {
        if (connection) void dispatch(connection, { type: 'workflowRun.stop', runId });
      },
    });
  }

  for (const workflow of workflows) {
    commands.push({
      id: `workflow.${workflow.id}`,
      title: workflow.name,
      value: `Workflow ${workflow.name} ${workflow.id}`,
      group: 'Workflows',
      keywords: ['workflow', 'edit', 'run'],
      detail: 'Workflow',
      searchOnly: true,
      run: ({ navigate }) =>
        void navigate({ to: '/workflows/$workflowId', params: { workflowId: workflow.id } }),
    });
  }
  const names = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
  for (const run of sortRuns(runs)) {
    const name = names.get(run.workflowId) ?? 'Workflow';
    commands.push({
      id: `workflowRun.${run.id}`,
      title: name,
      value: `Run ${name} ${run.state} ${run.id}`,
      group: 'Workflows',
      keywords: ['run', 'workflow', run.state],
      detail: `Run · ${runStateLabels[run.state]} · ${formatWhen(run.startedAt)}`,
      needsYou: run.state === 'waiting',
      recentAt: run.startedAt,
      run: ({ navigate }) =>
        void navigate({ to: '/workflows/runs/$runId', params: { runId: run.id } }),
    });
  }
  return commands;
}
