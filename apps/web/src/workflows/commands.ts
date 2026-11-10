import type { Project, RunDiffFile, Workflow, WorkflowRun, WorkflowTemplate } from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import type { AppCommand } from '@/app/commands';
import { openFile } from '@/panel/viewer';
import { fileStatusLabels, refreshChanges, validateRunSearch, type RunSearch } from './changes';
import { artifactPath, gateOf, isLive, runStateLabels, sortRuns } from './model';

export interface WorkflowCommandData {
  readonly workflows: readonly Workflow[];
  readonly runs: readonly WorkflowRun[];
  readonly templates: readonly WorkflowTemplate[];
  // The run open in the run view, or the run waiting at a gate after the open thread's step.
  readonly openRun: WorkflowRun | undefined;
  // The run view on screen: its run, its address's search, and the changed files its Changes
  // tab last read. Absent on every other view.
  readonly runView?:
    | {
        readonly runId: string;
        readonly search: Record<string, unknown>;
        readonly changedFiles: readonly RunDiffFile[];
        readonly project: Project | undefined;
      }
    | undefined;
  // "14:39" for a run's start, in the calendar's zone.
  readonly formatWhen?: (iso: string) => string;
}

// The run view's tabs and its Changes tab (review loop spec 11): switch between Steps and
// Changes, narrow to the step under review, read again, pick a changed file, and open the chosen
// one in the side panel.
function changesCommands({
  runId,
  search,
  changedFiles,
  project,
}: NonNullable<WorkflowCommandData['runView']>): AppCommand[] {
  const current = validateRunSearch(search);
  const to = '/workflows/runs/$runId' as const;
  const show = (next: RunSearch): AppCommand['run'] => {
    return ({ navigate }) => void navigate({ to, params: { runId }, search: next, replace: true });
  };
  if (current.tab !== 'changes') {
    return [
      {
        id: 'workflowRun.changes',
        title: 'Run: show changes',
        group: 'Workflows',
        keywords: ['diff', 'files', 'changed', 'review', 'tab'],
        keybinding: 'keybindings.runChanges',
        run: show({ tab: 'changes' }),
      },
    ];
  }
  const stepOnly = current.stepOnly === true;
  const keep = stepOnly ? { stepOnly: true as const } : {};
  const commands: AppCommand[] = [
    {
      id: 'workflowRun.changes',
      title: 'Run: show steps',
      group: 'Workflows',
      keywords: ['changes', 'tab', 'back'],
      keybinding: 'keybindings.runChanges',
      run: show({}),
    },
    {
      id: 'workflowRun.changes.stepOnly',
      title: stepOnly ? 'Changes: every step' : 'Changes: this step only',
      group: 'Workflows',
      keywords: ['diff', 'filter', 'narrow', 'step under review'],
      keybinding: 'keybindings.changesStepOnly',
      run: show({
        tab: 'changes',
        ...(current.file === undefined ? {} : { file: current.file }),
        ...(stepOnly ? {} : { stepOnly: true as const }),
      }),
    },
    {
      id: 'workflowRun.changes.refresh',
      title: 'Refresh changes',
      group: 'Workflows',
      keywords: ['diff', 'reload', 'read again'],
      run: refreshChanges,
    },
  ];
  for (const file of changedFiles) {
    commands.push({
      id: `workflowRun.changes.file.${file.path}`,
      title: `Changed file: ${file.path}`,
      group: 'Workflows',
      keywords: ['diff', 'changes', file.status],
      detail: fileStatusLabels[file.status],
      searchOnly: true,
      run: show({ tab: 'changes', file: file.path, ...keep }),
    });
  }
  const chosen = changedFiles.find((file) => file.path === current.file);
  if (chosen && chosen.status !== 'deleted') {
    commands.push({
      id: 'workflowRun.changes.open',
      title: `Open changed file: ${chosen.path}`,
      group: 'Workflows',
      keywords: ['viewer', 'side panel', 'file'],
      run: ({ settings, layout }) =>
        openFile(
          { settings, layout },
          {
            runId,
            path: chosen.path,
            fullPath: project ? artifactPath(project.cwd, chosen.path) : chosen.path,
            from: `/workflows/runs/${runId}`,
          },
        ),
    });
  }
  return commands;
}

// Palette commands for workflows (spec 22): new workflow (blank or from a template), every
// workflow and run, refresh skills, and Continue and Stop for the open run.
export function workflowCommands({
  workflows,
  runs,
  templates,
  openRun,
  runView,
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

  if (runView) commands.push(...changesCommands(runView));

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
