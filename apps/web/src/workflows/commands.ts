import {
  changeRequestName,
  gatePartLabels,
  type ChangeRequest,
  type HostRead,
  type Ticket,
  type Project,
  type ProjectGit,
  type RunDiffFile,
  type Skill,
  type Trigger,
  type Workflow,
  type WorkflowRun,
  type WorkflowTemplate,
} from '@wow/contracts';
import { dispatch } from '@wow/client-runtime';
import type { AppCommand } from '@/app/commands';
import { safeHref } from '@/components/markdown';
import { openInEditor } from '@/panel/editor';
import { openFile } from '@/panel/viewer';
import {
  fileStatusLabels,
  refreshChanges,
  runTabs,
  validateRunSearch,
  type RunSearch,
} from './changes';
import { cancelSendBack, canSendBack, confirmSendBack, openSendBack } from './gate';
import {
  artifactPath,
  conditionOffered,
  gateOf,
  gatePartChoices,
  gateParts,
  isLive,
  runStateLabel,
  sortRuns,
  toggleGatePart,
} from './model';
import { addRule, moveRule, removeRule, ruleSentence, ruleStep, type RulesState } from './rules';
import {
  attachedSkills,
  refKey,
  skillChoices,
  stepSkillRef,
  toggledLeaveOut,
  withAlsoFollow,
  withoutAlsoFollow,
} from './step-skills';
import {
  openNewTrigger,
  removeTrigger,
  setTriggerEnabled,
  triggerGroups,
  triggersPath,
  triggerTitle,
} from './triggers';
import { askRemoveWorkingCopy, canRemoveWorkingCopy, workingCopyStatus } from './working-copy';

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
        // The folder the run works in: its own working copy, else the project folder.
        readonly folder?: string | undefined;
        // The run's pull request as the host last showed it, if it has one.
        readonly pullRequest?: ChangeRequest | undefined;
        // The run's Jira ticket as the host last showed it, if it has one.
        readonly ticket?: Ticket | undefined;
      }
    | undefined;
  // Every trigger row and the projects, for the event triggers' commands; whether the Triggers
  // tab is the open view.
  readonly triggers?: readonly Trigger[] | undefined;
  readonly projects?: readonly Project[] | undefined;
  // The host reads, which say whether a project's code host is GitLab.
  readonly hostReads?: readonly HostRead[] | undefined;
  // Each project's git data, which names its code host before the first host read.
  readonly projectsGit?: ReadonlyMap<string, ProjectGit> | undefined;
  readonly onTriggers?: boolean | undefined;
  // The `workflows.alwaysStopSkills` setting: gates after these skills get no condition.
  readonly alwaysStopSkills?: readonly string[] | undefined;
  // The open builder's steps and the rule that has the keyboard (from the rules store).
  readonly rules?: RulesState | undefined;
  // Every skill, for the step's "Also follow" commands.
  readonly skills?: readonly Skill[] | undefined;
  // The run whose send back note is being written, if any (from the gate store).
  readonly sendBackRunId?: string | undefined;
  // "14:39" for a run's start, in the calendar's zone.
  readonly formatWhen?: (iso: string) => string;
}

// The tabs beside Steps and Changes (review loop spec 14; Path: workflow branches spec 18), and
// the way back to Steps from one of them. Steps and Changes switch with
// `keybindings.runChanges` below, Steps and Path with `keybindings.runPath`.
function tabCommands(runId: string, current: RunSearch): AppCommand[] {
  const to = '/workflows/runs/$runId' as const;
  const commands: AppCommand[] = [];
  for (const { id, label } of runTabs) {
    if (id === 'changes' || id === current.tab) continue;
    if (id === 'steps' && (current.tab === undefined || current.tab === 'changes')) continue;
    // On Path the same key goes back to Steps, as `keybindings.runChanges` does on Changes.
    const pathKey =
      id === 'path' || (id === 'steps' && current.tab === 'path')
        ? { keybinding: 'keybindings.runPath' as const }
        : {};
    commands.push({
      id: `workflowRun.tab.${id}`,
      title: `Run: show ${label.toLowerCase()}`,
      group: 'Workflows',
      keywords:
        id === 'path' ? ['tab', 'visits', 'attempts', 'loop', 'why'] : ['tab', 'review', 'gate'],
      ...pathKey,
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

// The builder's "Pass by itself when" checkboxes (review loop spec 54, 57): one command per
// part of each gate after a step, none for a skill that always stops.
function conditionCommands(workflow: Workflow, alwaysStop: readonly string[]): AppCommand[] {
  const commands: AppCommand[] = [];
  workflow.steps.forEach((step, index) => {
    if (!conditionOffered(step, alwaysStop)) return;
    for (const part of gateParts) {
      const on = step.gateAfterCondition?.includes(part) ?? false;
      const label = gatePartLabels[part].toLowerCase();
      commands.push({
        id: `workflow.gateCondition.${workflow.id}.${step.id}.${part}`,
        title: on
          ? `${workflow.name}: gate after ${step.skillName} no longer needs ${label}`
          : `${workflow.name}: gate after ${step.skillName} passes by itself with ${label}`,
        value: `Workflow ${workflow.name} step ${index + 1} ${step.skillName} gate condition ${part} ${on ? 'off' : 'on'} ${workflow.id}`,
        group: 'Workflows',
        keywords: ['workflow', 'gate', 'condition', 'pass by itself', 'verdict', 'checks'],
        detail: `Pass by itself when: ${gatePartChoices[part]} (${on ? 'on' : 'off'})`,
        searchOnly: true,
        run: ({ connection }) => {
          if (!connection) return;
          void dispatch(connection, {
            type: 'workflow.update',
            workflowId: workflow.id,
            steps: workflow.steps.map((entry) =>
              entry.id === step.id ? toggleGatePart(entry, part) : entry,
            ),
          });
        },
      });
    }
  });
  return commands;
}

// The rules of the open builder's draft (workflow branches spec 14): add a rule to the step
// being edited, or to any other step by search, and move or remove the rule that has, or last
// had, the keyboard. They change the draft; Save stores it.
const stepWords = (step: { readonly skillName: string }, index: number): string =>
  step.skillName.trim() === ''
    ? `step ${index + 1}`
    : `step ${index + 1} (${step.skillName.trim()})`;

function ruleCommands(rules: RulesState | undefined): AppCommand[] {
  if (!rules?.builder) return [];
  const { steps } = rules.builder;
  const current = ruleStep(rules);
  const keywords = ['rule', 'after this step', 'branch', 'loop', 'path', 'builder', 'workflow'];
  const commands: AppCommand[] = steps.map((step, index) => {
    const edited = step.id === current?.step.id;
    return {
      id: edited ? 'workflow.rule.add' : `workflow.rule.add.${step.id}`,
      title: `Rule: add to ${stepWords(step, index)}`,
      group: 'Workflows',
      keywords,
      ...(edited ? { keybinding: 'keybindings.ruleAdd' as const } : { searchOnly: true }),
      run: () => addRule(step.id),
    };
  });
  const at = rules.at?.rule;
  const rule = at === undefined ? undefined : current?.step.rules?.[at];
  if (!current || at === undefined || !rule) return commands;
  const { step, index } = current;
  const count = step.rules?.length ?? 0;
  const detail = `Rule ${at + 1} of ${stepWords(step, index)}: ${ruleSentence(rule, steps)}`;
  if (at > 0) {
    commands.push({
      id: 'workflow.rule.moveUp',
      title: 'Rule: move up',
      group: 'Workflows',
      keywords: [...keywords, 'order', 'earlier'],
      keybinding: 'keybindings.ruleMoveUp',
      detail,
      run: () => moveRule(step.id, at, -1),
    });
  }
  if (at < count - 1) {
    commands.push({
      id: 'workflow.rule.moveDown',
      title: 'Rule: move down',
      group: 'Workflows',
      keywords: [...keywords, 'order', 'later'],
      keybinding: 'keybindings.ruleMoveDown',
      detail,
      run: () => moveRule(step.id, at, 1),
    });
  }
  commands.push({
    id: 'workflow.rule.remove',
    title: 'Rule: remove',
    group: 'Workflows',
    keywords: [...keywords, 'delete'],
    detail,
    run: () => removeRule(step.id, at),
  });
  return commands;
}

// The skills of the step being edited in the builder (wow skills spec 11, 12): follow another
// skill or stop following one, and leave out a built-in skill wow would attach or attach it
// again. They change the draft; Save stores it.
function stepSkillCommands(rules: RulesState | undefined, skills: readonly Skill[]): AppCommand[] {
  const builder = rules?.builder;
  const current = rules && ruleStep(rules);
  const changeStep = builder?.changeStep;
  if (!builder || !current || !changeStep) return [];
  const { step, index } = current;
  const where = stepWords(step, index);
  const keywords = ['skill', 'also follow', 'builder', 'workflow', 'step'];
  const choices = skillChoices(skills);
  const own = refKey(stepSkillRef(step));
  const following = step.alsoFollow ?? [];
  const commands: AppCommand[] = [];
  for (const choice of choices) {
    if (choice.value === own || following.some((ref) => refKey(ref) === choice.value)) continue;
    commands.push({
      id: `workflow.alsoFollow.add.${choice.value}`,
      title: `Also follow ${choice.label} in ${where}`,
      group: 'Workflows',
      keywords,
      ...(choice.detail ? { detail: choice.detail } : {}),
      searchOnly: true,
      run: () => changeStep(step.id, withAlsoFollow(step, choice.ref)),
    });
  }
  for (const ref of following) {
    commands.push({
      id: `workflow.alsoFollow.remove.${refKey(ref)}`,
      title: `Stop following ${ref.name} in ${where}`,
      group: 'Workflows',
      keywords: [...keywords, 'remove'],
      run: () => changeStep(step.id, withoutAlsoFollow(step, ref)),
    });
  }
  const attached = attachedSkills(step, {
    on: builder.attachBuiltIn ?? true,
    forUnits: builder.forUnits ?? false,
    skills,
  });
  for (const skill of attached) {
    commands.push({
      id: `workflow.leaveOut.${skill.name}`,
      title: skill.left
        ? `Attach ${skill.name} to ${where} again`
        : `Leave ${skill.name} out of ${where}`,
      group: 'Workflows',
      keywords: [...keywords, 'built-in', 'attached', 'automatically', 'leave out'],
      detail: `Because ${skill.reason}`,
      run: () => changeStep(step.id, toggledLeaveOut(step, skill.name)),
    });
  }
  return commands;
}

// The run's pull request and ticket (review loop spec 28, 30 and 33): ask the hosts once, and
// open either there.
function pullRequestCommands({
  runId,
  pullRequest,
  ticket,
}: NonNullable<WorkflowCommandData['runView']>): AppCommand[] {
  const commands: AppCommand[] = [
    {
      id: 'workflowRun.pullRequest.refresh',
      title: 'Run: refresh pull request and ticket now',
      group: 'Workflows',
      keywords: [
        'host',
        'github',
        'jira',
        'ticket',
        'confluence',
        'pages',
        'checks',
        'review',
        'fetch',
        'poll',
      ],
      run: ({ connection }) => void connection?.request('hosts.refresh', { runId }).catch(() => {}),
    },
  ];
  const url = safeHref(pullRequest?.url);
  const ticketUrl = safeHref(ticket?.url ?? undefined);
  if (ticket && ticketUrl !== undefined) {
    commands.push({
      id: 'workflowRun.ticket.open',
      title: `Run: open ticket ${ticket.key} on the host`,
      group: 'Workflows',
      keywords: ['host', 'jira', 'issue', 'browser'],
      run: () => void window.open(ticketUrl, '_blank', 'noreferrer'),
    });
  }
  if (pullRequest && url !== undefined) {
    commands.push({
      id: 'workflowRun.pullRequest.open',
      title: `Run: open ${changeRequestName(pullRequest).toLowerCase()} on the host`,
      group: 'Workflows',
      keywords: ['host', 'github', 'gitlab', 'merge request', 'browser', 'review'],
      run: () => void window.open(url, '_blank', 'noreferrer'),
    });
  }
  return commands;
}

// The Triggers tab (review loop spec 48): open it, make a trigger, and switch or delete each
// one. A single trigger's commands are listed without typing only while the tab is open.
function triggerCommands({
  triggers = [],
  projects = [],
  workflows,
  hostReads = [],
  projectsGit,
  onTriggers = false,
}: WorkflowCommandData): AppCommand[] {
  const commands: AppCommand[] = [
    {
      id: 'workflows.triggers',
      title: 'Go to event triggers',
      group: 'Workflows',
      keywords: ['trigger', 'event', 'pull request', 'merged', 'checks', 'review comment', 'tab'],
      run: ({ navigate }) => void navigate({ to: triggersPath }),
    },
    {
      id: 'workflows.runs',
      title: 'Go to runs',
      group: 'Workflows',
      keywords: ['runs', 'waiting', 'live', 'running', 'gate', 'tab'],
      run: ({ navigate }) => void navigate({ to: '/workflows/runs' }),
    },
    {
      id: 'trigger.new',
      title: 'New event trigger',
      group: 'Workflows',
      keywords: ['trigger', 'event', 'pull request', 'merged', 'checks failed', 'review comment'],
      run: ({ navigate }) => {
        openNewTrigger();
        void navigate({ to: triggersPath });
      },
    },
  ];
  for (const group of triggerGroups(triggers, projects, workflows, hostReads, projectsGit)) {
    for (const row of group.rows) {
      const { trigger } = row;
      const name = `${group.project} · ${triggerTitle(row)}`;
      commands.push(
        {
          id: `trigger.toggle.${trigger.id}`,
          title: `${trigger.enabled ? 'Turn off' : 'Turn on'} trigger: ${name}`,
          value: `Trigger ${name} ${trigger.enabled ? 'off' : 'on'} ${trigger.id}`,
          group: 'Workflows',
          keywords: ['trigger', 'event', 'switch', 'enable', 'disable'],
          detail: trigger.enabled ? 'Trigger is on' : 'Trigger is off',
          searchOnly: !onTriggers,
          run: ({ connection }) => {
            if (!connection) return;
            void setTriggerEnabled(
              (command) => dispatch(connection, command),
              trigger,
              !trigger.enabled,
            );
          },
        },
        {
          id: `trigger.delete.${trigger.id}`,
          title: `Delete trigger: ${name}`,
          value: `Delete trigger ${name} ${trigger.id}`,
          group: 'Workflows',
          keywords: ['trigger', 'event', 'remove'],
          detail: 'Event trigger',
          searchOnly: !onTriggers,
          run: ({ connection }) => {
            if (connection) void removeTrigger((command) => dispatch(connection, command), row);
          },
        },
      );
    }
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
  folder = project?.cwd,
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
            fullPath: folder === undefined ? chosen.path : artifactPath(folder, chosen.path),
            from: `/workflows/runs/${runId}`,
          },
        ),
    });
    commands.push({
      id: 'workflowRun.changes.openInEditor',
      title: `Open in editor: ${chosen.path}`,
      group: 'Workflows',
      keywords: ['editor', 'code', 'ide', 'file'],
      run: ({ connection }) =>
        void openInEditor(connection, { scope: { runId }, path: chosen.path }),
    });
  }
  return commands;
}

// Palette commands for workflows (spec 22): new workflow (blank or from a template), every
// workflow and run, refresh skills, and Approve, Send back and Stop for the open run.
export function workflowCommands(data: WorkflowCommandData): AppCommand[] {
  const {
    workflows,
    runs,
    templates,
    openRun,
    runView,
    sendBackRunId,
    formatWhen = (iso) => iso,
  } = data;
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
    const gate = gateOf(openRun);
    if (gate && !writing) {
      commands.push({
        id: 'workflowRun.approve',
        // At the limit of a loop, Approve lets the step run once more (workflow branches spec 9).
        title: gate.limit === undefined ? 'Run: approve' : 'Run: run once more',
        group: 'Workflows',
        keywords: ['gate', 'continue', 'next step', 'resume', 'accept', 'limit', 'again'],
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
        run: () => openSendBack(openRun),
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
  commands.push(...ruleCommands(data.rules), ...stepSkillCommands(data.rules, data.skills ?? []));
  commands.push(...triggerCommands(data));

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
    // The builder's "Own working copy" switch (review loop spec 36, 39).
    const own = workflow.ownWorkingCopy ?? false;
    commands.push({
      id: `workflow.ownWorkingCopy.${workflow.id}`,
      title: own
        ? `${workflow.name}: run in the project folder`
        : `${workflow.name}: run in an own working copy`,
      value: `Workflow ${workflow.name} own working copy ${own ? 'off' : 'on'} ${workflow.id}`,
      group: 'Workflows',
      keywords: ['workflow', 'working copy', 'worktree', 'project folder', 'switch'],
      detail: own ? 'Own working copy is on' : 'Own working copy is off',
      searchOnly: true,
      run: ({ connection }) => {
        if (!connection) return;
        void dispatch(connection, {
          type: 'workflow.update',
          workflowId: workflow.id,
          ownWorkingCopy: !own,
        });
      },
    });
    // The builder's "For units" switch (review loop spec 40).
    const forUnits = workflow.forUnits ?? false;
    commands.push({
      id: `workflow.forUnits.${workflow.id}`,
      title: forUnits
        ? `${workflow.name}: no longer for plan units`
        : `${workflow.name}: use for plan units`,
      value: `Workflow ${workflow.name} for units ${forUnits ? 'off' : 'on'} ${workflow.id}`,
      group: 'Workflows',
      keywords: ['workflow', 'for units', 'plan run', 'units', 'switch'],
      detail: forUnits ? 'For units is on' : 'For units is off',
      searchOnly: true,
      run: ({ connection }) => {
        if (!connection) return;
        void dispatch(connection, {
          type: 'workflow.update',
          workflowId: workflow.id,
          forUnits: !forUnits,
        });
      },
    });
    commands.push(...conditionCommands(workflow, data.alwaysStopSkills ?? []));
  }
  const names = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
  for (const run of sortRuns(runs)) {
    const name = names.get(run.workflowId) ?? 'Workflow';
    // Every kept working copy is listed here; the run view asks before it removes one (review
    // loop spec 37).
    if (canRemoveWorkingCopy(run)) {
      commands.push({
        id: `workflowRun.removeWorkingCopy.${run.id}`,
        title: `Remove working copy: ${name}`,
        value: `Remove working copy ${name} ${run.id} ${run.workingCopy?.path ?? ''}`,
        group: 'Workflows',
        keywords: ['working copy', 'worktree', 'delete', 'kept', 'unpushed', 'folder'],
        detail: `${workingCopyStatus(run) ?? ''} · ${formatWhen(run.startedAt)}`,
        searchOnly: run.id !== runView?.runId,
        run: ({ navigate }) => {
          askRemoveWorkingCopy(run.id);
          void navigate({ to: '/workflows/runs/$runId', params: { runId: run.id } });
        },
      });
    }
    commands.push({
      id: `workflowRun.${run.id}`,
      title: name,
      value: `Run ${name} ${run.state} ${run.id}`,
      group: 'Workflows',
      keywords: ['run', 'workflow', run.state],
      detail: `Run · ${runStateLabel(run)} · ${formatWhen(run.startedAt)}`,
      needsYou: run.state === 'waiting',
      recentAt: run.startedAt,
      run: ({ navigate }) =>
        void navigate({ to: '/workflows/runs/$runId', params: { runId: run.id } }),
    });
  }
  return commands;
}
