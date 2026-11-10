import type {
  ChangeRequest,
  Project,
  RunDiffFile,
  Workflow,
  WorkflowRun,
  WorkflowTemplate,
} from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import type { AppCommand } from '@/app/commands';
import { safeHref } from '@/components/markdown';
import { openFile } from '@/panel/viewer';
import {
  fileStatusLabels,
  refreshChanges,
  runTabs,
  validateRunSearch,
  type RunSearch,
} from './changes';
import { cancelSendBack, canSendBack, confirmSendBack, openSendBack } from './gate';
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
        // The run's pull request as the host last showed it, if it has one.
        readonly pullRequest?: ChangeRequest | undefined;
      }
    | undefined;
  // The run whose send back note is being written, if any (from the gate store).
  readonly sendBackRunId?: string | undefined;
  // "14:39" for a run's start, in the calendar's zone.
  readonly formatWhen?: (iso: string) => string;
}

// The review tabs beside Steps and Changes (review loop spec 14), and the way back to Steps from
// one of them. Steps and Changes switch with `keybindings.runChanges` below.
function tabCommands(runId: string, current: RunSearch): AppCommand[] {
  const to = '/workflows/runs/$runId' as const;
  const commands: AppCommand[] = [];
  for (const { id, label } of runTabs) {
    if (id === 'changes' || id === current.tab) continue;
    if (id === 'steps' && (current.tab === undefined || current.tab === 'changes')) continue;
    commands.push({
      id: `workflowRun.tab.${id}`,
      title: `Run: show ${label.toLowerCase()}`,
      group: 'Workflows',
      keywords: ['tab', 'review', 'gate'],
      run: ({ navigate }) =>
        void navigate({
          to,
          params: { runId },
          search: id === 'steps' ? {} : { tab: id },
          replace: true,
        }),
    });
  }
  return commands;
}

// The run's pull request (review loop spec 28 and 30): ask the host once, and open it there.
function pullRequestCommands({
  runId,
  pullRequest,
}: NonNullable<WorkflowCommandData['runView']>): AppCommand[] {
  const commands: AppCommand[] = [
    {
      id: 'workflowRun.pullRequest.refresh',
      title: 'Run: refresh pull request now',
      group: 'Workflows',
      keywords: ['host', 'github', 'checks', 'review', 'fetch', 'poll'],
      run: ({ connection }) => void connection?.request('hosts.refresh', { runId }).catch(() => {}),
    },
  ];
  const url = safeHref(pullRequest?.url);
  if (pullRequest && url !== undefined) {
    commands.push({
      id: 'workflowRun.pullRequest.open',
      title: `Run: open pull request #${pullRequest.number} on the host`,
      group: 'Workflows',
      keywords: ['host', 'github', 'browser', 'review'],
      run: () => void window.open(url, '_blank', 'noreferrer'),
    });
  }
  return commands;
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
      ...tabCommands(runId, current),
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
    ...tabCommands(runId, current),
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
// workflow and run, refresh skills, and Approve, Send back and Stop for the open run.
export function workflowCommands({
  workflows,
  runs,
  templates,
  openRun,
  runView,
  sendBackRunId,
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
    const writing = sendBackRunId === runId && canSendBack(openRun);
    // While a note is being written the Approve key is off, so it cannot approve by accident;
    // the Send back key sends the note.
    if (gateOf(openRun) && !writing) {
      commands.push({
        id: 'workflowRun.approve',
        title: 'Run: approve',
        group: 'Workflows',
        keywords: ['gate', 'continue', 'next step', 'resume', 'accept'],
        keybinding: 'keybindings.gateApprove',
        run: ({ connection }) => {
          if (connection) void dispatch(connection, { type: 'workflowRun.continue', runId });
        },
      });
    }
    if (writing) {
      commands.push(
        {
          id: 'workflowRun.sendBack',
          title: 'Run: send back with this note',
          group: 'Workflows',
          keywords: ['gate', 'reject', 'again', 'retry', 'confirm'],
          keybinding: 'keybindings.gateSendBack',
          run: ({ connection }) => {
            if (connection) void confirmSendBack((command) => dispatch(connection, command));
          },
        },
        {
          id: 'workflowRun.sendBack.cancel',
          title: 'Run: cancel send back',
          group: 'Workflows',
          keywords: ['gate', 'note', 'close'],
          run: cancelSendBack,
        },
      );
    } else if (canSendBack(openRun)) {
      commands.push({
        id: 'workflowRun.sendBack',
        title: 'Run: send back',
        group: 'Workflows',
        keywords: ['gate', 'reject', 'again', 'retry', 'note', 'changes requested'],
        keybinding: 'keybindings.gateSendBack',
        run: () => openSendBack(runId),
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

  if (runView) commands.push(...changesCommands(runView), ...pullRequestCommands(runView));

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
