import {
  alwaysStops,
  awaitedProviderKind,
  hostReadId,
  isLiveRunState,
  providerKindLabels,
  ruleProblems,
  type AppNotification,
  type CardState,
  type ChangeRequest,
  type DomainEvent,
  type HostRead,
  type RunEffect,
  type RunEvent,
  type RunOccurrence,
  type RunUnit,
  type ServerCommand,
  type StepGate,
  type Thread,
  type Workflow,
  type WorkflowChanges,
  type WorkflowRun,
  type WorkflowStep,
  type WorkingCopy,
} from '@wow/contracts';
import {
  advance,
  pendingGate,
  reviewedStepIndex,
  RunRejected,
  startRun,
  type ChecksReading,
  type EngineContext,
  type RunInput,
  type Transition,
} from '@wow/workflow-engine';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { resolveStored } from '../settings/service.js';
import { backlogFollowsRun } from './backlog.js';
import { folderSkillInvocation, skillToSend } from './skills.js';
import { decideThread } from './threads.js';
import { CommandRejected, type DecideContext, type ReadModel } from './orchestrator.js';

// Decisions for workflow definitions and runs. Run transitions come from the pure workflow
// engine; this file only looks things up, turns engine output into events and engine refusals
// into rejected commands.

type WorkflowCommand = Extract<
  ServerCommand,
  { type: `workflow.${string}` } | { type: `workflowRun.${string}` }
>;

export const engineCall = <T>(call: () => T): T => {
  try {
    return call();
  } catch (error) {
    if (error instanceof RunRejected) throw new CommandRejected('rejected', error.message);
    throw error;
  }
};

export const isWorkflowCommand = (command: ServerCommand): command is WorkflowCommand =>
  command.type.startsWith('workflow.') || command.type.startsWith('workflowRun.');

export function decideWorkflow(
  command: WorkflowCommand,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  switch (command.type) {
    case 'workflow.create': {
      if (read.workflow(command.workflowId)) {
        throw new CommandRejected('conflict', `Workflow ${command.workflowId} already exists`);
      }
      refuseConditions(command.steps, read, context);
      refuseRules(command.steps);
      return [
        {
          kind: 'workflow.created',
          aggregate: command.workflowId,
          payload: {
            id: command.workflowId,
            name: command.name,
            templateKind: command.templateKind ?? null,
            steps: command.steps,
            ...(command.ownWorkingCopy ? { ownWorkingCopy: true } : {}),
            ...(command.forUnits ? { forUnits: true } : {}),
            ...(typeof command.maxStepVisits === 'number'
              ? { maxStepVisits: command.maxStepVisits }
              : {}),
            createdAt: context.now,
            updatedAt: context.now,
          },
        },
      ];
    }
    case 'workflow.update': {
      const workflow = requireWorkflow(read, command.workflowId);
      const changes: Omit<WorkflowChanges, 'updatedAt'> = {};
      if (command.name !== undefined && command.name !== workflow.name) changes.name = command.name;
      if (command.templateKind !== undefined && command.templateKind !== workflow.templateKind) {
        changes.templateKind = command.templateKind;
      }
      if (command.steps !== undefined && !isDeepStrictEqual(command.steps, workflow.steps)) {
        // A live run follows its workflow's steps by position, so they cannot change under it.
        if (read.hasLiveRun(workflow.id)) {
          throw new CommandRejected(
            'conflict',
            `Workflow ${workflow.name} has a run in progress; stop it before changing the steps`,
          );
        }
        refuseConditions(command.steps, read, context);
        refuseRules(command.steps);
        changes.steps = command.steps;
      }
      // Read when a step is about to start, so a run that is going follows the new number.
      if (
        command.maxStepVisits !== undefined &&
        command.maxStepVisits !== (workflow.maxStepVisits ?? null)
      ) {
        changes.maxStepVisits = command.maxStepVisits;
      }
      // Runs that exist keep the folder they started in; the switch is read when a run starts.
      if (
        command.ownWorkingCopy !== undefined &&
        command.ownWorkingCopy !== (workflow.ownWorkingCopy ?? false)
      ) {
        changes.ownWorkingCopy = command.ownWorkingCopy;
      }
      // A plan run that is going keeps its workflow; the switch is read when one starts.
      if (command.forUnits !== undefined && command.forUnits !== (workflow.forUnits ?? false)) {
        changes.forUnits = command.forUnits;
      }
      if (Object.keys(changes).length === 0) return [];
      return [
        {
          kind: 'workflow.updated',
          aggregate: workflow.id,
          payload: { workflowId: workflow.id, changes: { ...changes, updatedAt: context.now } },
        },
      ];
    }
    case 'workflow.delete': {
      const workflow = requireWorkflow(read, command.workflowId);
      if (read.hasLiveRun(workflow.id)) {
        throw new CommandRejected(
          'conflict',
          `Workflow ${workflow.name} has a run in progress; stop it first`,
        );
      }
      return [
        { kind: 'workflow.deleted', aggregate: workflow.id, payload: { workflowId: workflow.id } },
      ];
    }
    case 'workflow.restore': {
      const { workflow } = command;
      if (read.workflow(workflow.id)) {
        throw new CommandRejected('conflict', `Workflow ${workflow.id} already exists`);
      }
      refuseConditions(workflow.steps, read, context);
      refuseRules(workflow.steps);
      return [{ kind: 'workflow.created', aggregate: workflow.id, payload: workflow }];
    }
    case 'workflowRun.start':
      return startRunEvents(command.type, command, read, context);
    case 'workflowRun.continue':
      return runInput(command.type, command.runId, { type: 'continue' }, read, context);
    case 'workflowRun.sendBack':
      return runInput(
        command.type,
        command.runId,
        { type: 'sendBack', note: command.note },
        read,
        context,
      );
    case 'workflowRun.stop':
      return runInput(command.type, command.runId, { type: 'stop' }, read, context);
    case 'workflowRun.stepCompleted':
      return runInput(
        command.type,
        command.runId,
        {
          type: 'stepCompleted',
          stepId: command.stepId,
          finalMessage: command.finalMessage,
          artifactsFound: command.artifactsFound,
          artifactsMissing: command.artifactsMissing,
          fileHashes: command.fileHashes,
          headSha: command.headSha,
        },
        read,
        context,
      );
    case 'workflowRun.checkGate': {
      const run = read.run(command.runId);
      if (!run) throw new CommandRejected('not_found', `No run ${command.runId}`);
      return gateChecksEvents(
        command.type,
        run,
        read.hostReads(run.projectId).find((row) => row.id === hostReadId('run', run.id)),
        read.changeRequests(run.projectId),
        read,
        context,
      );
    }
    case 'workflowRun.baseRecorded':
      return runInput(
        command.type,
        command.runId,
        { type: 'baseRecorded', baseSha: command.baseSha, files: command.files },
        read,
        context,
      );
    case 'workflowRun.stepFailed':
      return runInput(
        command.type,
        command.runId,
        {
          type: 'stepFailed',
          stepId: command.stepId,
          error: command.error,
          stopped: command.stopped,
        },
        read,
        context,
      );
    case 'workflowRun.sendHeldTurn':
      return heldTurnEvents(command.type, command.runId, command.stepId, read, context);
    case 'workflowRun.artifactsFound':
      return runInput(
        command.type,
        command.runId,
        { type: 'artifactsFound', found: command.found },
        read,
        context,
      );
    case 'workflowRun.workingCopyReady': {
      const { run, copy } = runWithCopy(read, command.runId, ['pending']);
      const { startSha, defaultBranch, note } = command;
      return [
        runChanged(command.type, {
          ...run,
          workingCopy: { ...copy, state: 'ready', startSha, defaultBranch, note },
        }),
      ];
    }
    case 'workflowRun.workingCopyFailed': {
      const { run, copy } = runWithCopy(read, command.runId, ['pending']);
      const failed: WorkflowRun = {
        ...run,
        workingCopy: { ...copy, state: 'failed', error: command.error },
      };
      // A run stopped while its working copy was being made has ended already.
      if (!isLiveRunState(run.state)) return [runChanged(command.type, failed)];
      const workflow = requireWorkflow(read, run.workflowId);
      const engineContext = runContext(read, context, run.projectId, null);
      const transition = engineCall(() =>
        advance(workflow, failed, { type: 'setupFailed', error: command.error }, engineContext),
      );
      return transitionEvents(command.type, workflow, run, transition, read, context);
    }
    case 'workflowRun.workingCopySettled': {
      const { run, copy } = runWithCopy(read, command.runId, ['ready', 'kept', 'failed']);
      if (isLiveRunState(run.state)) {
        throw new CommandRejected('rejected', `Run ${run.id} still works in its working copy`);
      }
      const { state, unpushed, error } = command;
      return [
        runChanged(command.type, { ...run, workingCopy: { ...copy, state, unpushed, error } }),
      ];
    }
  }
}

const ALWAYS_STOP_KEY = 'workflows.alwaysStopSkills';

// A condition belongs to a gate after a step, and never to the gate after a skill that plans or
// specifies (review loop spec 57). Workflows belong to no project, so the list is the one set
// for all projects; the engine applies the run's project's list again when a step ends.
function refuseConditions(
  steps: readonly WorkflowStep[],
  read: ReadModel,
  context: DecideContext,
): void {
  const listed = stringList(resolvedSetting(ALWAYS_STOP_KEY, read, context, undefined));
  for (const step of steps) {
    if (!step.gateAfterCondition) continue;
    if (!step.gateAfter) {
      throw new CommandRejected(
        'rejected',
        `Step ${step.skillName} has a condition but no gate after it: a condition lets a gate pass by itself, so add the gate or take the condition away`,
      );
    }
    if (alwaysStops(step.skillName, listed)) {
      throw new CommandRejected(
        'rejected',
        `The gate after ${step.skillName} always waits for you: skills that plan or specify cannot get a condition (${ALWAYS_STOP_KEY})`,
      );
    }
  }
}

// A workflow whose rules cannot be followed is not stored (workflow branches spec 16). The
// reason names the step and the rule, the way the builder marks it.
function refuseRules(steps: readonly WorkflowStep[]): void {
  const [problem] = ruleProblems(steps);
  if (!problem) return;
  const step = steps.find((entry) => entry.id === problem.stepId);
  throw new CommandRejected(
    'rejected',
    `Step ${step?.skillName ?? problem.stepId}, rule ${problem.rule + 1}: ${problem.reason}`,
  );
}

// What the host showed about the checks of the run's pull request since the step ended. Null
// when nothing was read since then: an older read says nothing about what the step pushed.
function checksReading(
  { since, headSha }: Pick<StepGate, 'since' | 'headSha'>,
  hostRead: HostRead | undefined,
  changeRequests: readonly ChangeRequest[],
): ChecksReading | null {
  if (!hostRead) return null;
  if (hostRead.error) {
    return hostRead.error.kind === 'notSetUp'
      ? { state: 'notSetUp', message: hostRead.error.message }
      : { state: 'unavailable', message: hostRead.error.message };
  }
  if (hostRead.fetchedAt === null || Date.parse(hostRead.fetchedAt) < Date.parse(since)) {
    return null;
  }
  const request = changeRequests.find((row) => hostRead.changeRequestIds.includes(row.id));
  if (!request) return { state: 'noPullRequest', branch: hostRead.branch, host: hostRead.host };
  // Checks for another commit say nothing about what the step left: the host may not have seen
  // the push yet, or the step did not push. Wait for a read of this commit, or for the wait to
  // run out.
  if (typeof headSha === 'string' && request.headSha !== headSha) return null;
  const { number, host } = request;
  const named = (state: 'success' | 'failure' | 'pending') =>
    request.checks.filter((check) => check.state === state).map((check) => check.name);
  switch (request.checkState) {
    case 'success':
      return { state: 'success', number, host, checks: named('success') };
    case 'failure':
      return { state: 'failure', number, host, failing: named('failure') };
    case 'pending':
      return { state: 'pending', number, host, running: named('pending') };
    case 'none':
      return { state: 'none', number, host };
  }
}

// A gate that waits for its pull request's checks is looked at again (review loop spec 56):
// after a host read, with the rows that read leaves, or when the wait has run out. A run that
// does not wait for checks is left alone.
export function gateChecksEvents(
  cause: string,
  run: WorkflowRun,
  hostRead: HostRead | undefined,
  changeRequests: readonly ChangeRequest[],
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const current = run.steps[run.currentStep];
  if (run.state !== 'waiting' || current?.gate?.state !== 'waitingForChecks') return [];
  return runInput(
    cause,
    run.id,
    {
      type: 'gateChecks',
      stepId: current.stepId,
      reading: checksReading(current.gate, hostRead, changeRequests),
    },
    read,
    context,
  );
}

// A change to the run that the engine has no part in: what became of its working copy.
const runChanged = (cause: string, run: WorkflowRun): DomainEvent => ({
  kind: 'workflowRun.changed',
  aggregate: run.id,
  payload: { cause, run, effects: [] },
});

function runWithCopy(read: ReadModel, runId: string, states: readonly WorkingCopy['state'][]) {
  const run = read.run(runId);
  if (!run) throw new CommandRejected('not_found', `No run ${runId}`);
  const copy = run.workingCopy;
  if (!copy) throw new CommandRejected('rejected', `Run ${runId} has no working copy`);
  if (!states.includes(copy.state)) {
    throw new CommandRejected('rejected', `The working copy of run ${runId} is ${copy.state}`);
  }
  return { run, copy };
}

const WORKSPACES_ROOT_KEY = 'workspaces.root';

// The project's name as a folder name: short, so the path stays well under what Windows allows.
const folderSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 16)
    .replace(/-+$/, '');

// Where a run's own working copy goes: `workspaces.root` (inside wow's own folder unless it is a
// full path) and a folder named after the project and the run. Decided here, without touching
// the disk, so the threads of the run's steps can be created with it as their `cwd`.
export function workingCopyPath(
  root: string,
  home: string | undefined,
  projectName: string,
  runId: string,
): string {
  if (!path.isAbsolute(root) && home === undefined) {
    throw new CommandRejected(
      'rejected',
      `${WORKSPACES_ROOT_KEY} is "${root}", which is not a full path, and this server has no folder of its own to put it in`,
    );
  }
  const id = createHash('sha256').update(runId).digest('hex').slice(0, 8);
  const slug = folderSlug(projectName);
  return path.join(path.resolve(home ?? '', root), slug === '' ? id : `${slug}-${id}`);
}

export interface RunStart {
  readonly runId: string;
  readonly workflowId: string;
  readonly projectId: string;
  readonly calendarItemId?: string | null | undefined;
  readonly backlogItemId?: string | null | undefined;
  // The unit the run delivers, when a plan run starts it.
  readonly unit?: RunUnit | undefined;
  // What started the run, when an event trigger did, and the working copy the pull request
  // already has, if any.
  readonly event?: RunEvent | undefined;
  readonly existingCopy?: { readonly run: WorkflowRun; readonly copy: WorkingCopy } | undefined;
  // The occurrence of a repeating card the run is for.
  readonly occurrence?: RunOccurrence | undefined;
}

// A new run of the workflow: a client's Run now, a card's Run now, a firing trigger or a plan
// run's next unit.
export function startRunEvents(
  cause: string,
  start: RunStart,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  if (read.run(start.runId)) {
    throw new CommandRejected('conflict', `Run ${start.runId} already exists`);
  }
  const workflow = requireWorkflow(read, start.workflowId);
  const project = read.project(start.projectId);
  if (!project) throw new CommandRejected('not_found', `No project ${start.projectId}`);
  for (const step of workflow.steps) {
    if (!read.providerInstance(step.providerInstanceId)) {
      const awaited = awaitedProviderKind(step.providerInstanceId);
      if (awaited) {
        throw new CommandRejected(
          'rejected',
          `Step ${step.skillName} has no ${providerKindLabels[awaited]} instance here yet: choose one for it in the workflow ${workflow.name}.`,
        );
      }
      throw new CommandRejected(
        'rejected',
        `Step ${step.skillName} uses provider instance ${step.providerInstanceId}, which does not exist`,
      );
    }
  }
  const backlogBody = backlogBodyOf(read, start.backlogItemId ?? null);
  const engineContext = runContext(read, context, start.projectId, backlogBody);
  const started = engineCall(() =>
    startRun(
      workflow,
      {
        runId: start.runId,
        projectId: start.projectId,
        calendarItemId: start.calendarItemId ?? null,
        backlogItemId: start.backlogItemId ?? null,
        unit: start.unit,
        event: start.event,
      },
      engineContext,
    ),
  );
  const transition = start.occurrence
    ? { ...started, run: { ...started.run, occurrence: start.occurrence } }
    : started;
  // A unit's run always works in its own working copy (review loop spec 40), and so does a run
  // an event started (spec 48).
  if (!workflow.ownWorkingCopy && !start.unit && !start.event) {
    return transitionEvents(cause, workflow, undefined, transition, read, context);
  }
  // The pull request's working copy is there already: the run works in it beside the run that
  // made it. Nothing is made, and the workspaces service removes it only when no run that
  // works in it is still going.
  if (start.existingCopy) {
    const { run: owner, copy } = start.existingCopy;
    const shared: WorkingCopy = {
      path: copy.path,
      state: 'ready',
      startSha: copy.startSha,
      defaultBranch: copy.defaultBranch,
      note: `This run works in the working copy that run ${owner.id} made for the pull request.`,
      unpushed: null,
      error: null,
    };
    const run = { ...transition.run, workingCopy: shared };
    return transitionEvents(cause, workflow, undefined, { ...transition, run }, read, context);
  }
  // The folder is only named here. The workspaces service makes it before the first step gets
  // its prompt, and the run fails there when it cannot (review loop spec 36, 38).
  const definition = context.registry[WORKSPACES_ROOT_KEY];
  if (!definition) throw new Error(`${WORKSPACES_ROOT_KEY} is missing from the settings registry`);
  const { value } = resolveStored(WORKSPACES_ROOT_KEY, definition, {}, (scope) =>
    read.setting(WORKSPACES_ROOT_KEY, scope),
  );
  const workingCopy: WorkingCopy = {
    path: workingCopyPath(
      typeof value === 'string' ? value : String(definition.default),
      context.home,
      project.name,
      start.runId,
    ),
    state: 'pending',
    startSha: null,
    defaultBranch: null,
    note: null,
    unpushed: null,
    error: null,
    // An event's run starts on the pull request's branch (spec 48).
    ...(start.event && start.event.branch !== '' ? { branch: start.event.branch } : {}),
  };
  const run = { ...transition.run, workingCopy };
  return transitionEvents(cause, workflow, undefined, { ...transition, run }, read, context);
}

export function runInput(
  cause: string,
  runId: string,
  input: RunInput,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const run = read.run(runId);
  if (!run) throw new CommandRejected('not_found', `No run ${runId}`);
  const workflow = requireWorkflow(read, run.workflowId);
  const engineContext = runContext(
    read,
    context,
    run.projectId,
    backlogBodyOf(read, run.backlogItemId),
  );
  const transition = engineCall(() => advance(workflow, run, input, engineContext));
  return transitionEvents(cause, workflow, run, transition, read, context);
}

function transitionEvents(
  cause: string,
  workflow: Workflow,
  before: WorkflowRun | undefined,
  transition: Transition,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const { run, effects } = transition;
  if (before && effects.length === 0 && isDeepStrictEqual(before, run)) return [];
  // A step that runs again gets its turn in its own thread in this commit. When the user asked
  // for that (Approve, Send back) and the thread cannot take it, the command is refused. When a
  // rule or the list got there by itself, nobody is there to refuse to: while the thread answers
  // a message the user typed there, the step's turn is held until that one ends; a thread that
  // is gone fails the step with the reason, so the run does not stay "running" without a turn.
  const rerun = effects.find((effect) => effect.type === 'sendBack');
  const refusal = rerun ? sendBackRefusal(rerun, read) : undefined;
  if (rerun && refusal !== undefined) {
    if (USER_CAUSES.has(cause)) throw new CommandRejected('rejected', refusal);
    if (read.thread(rerun.threadId) && read.runningTurn(rerun.threadId)) {
      const steps = run.steps.map((entry) =>
        entry.stepId === rerun.stepId ? { ...entry, heldPrompt: rerun.prompt } : entry,
      );
      return transitionEvents(
        cause,
        workflow,
        before,
        { run: { ...run, steps }, effects: effects.filter((effect) => effect !== rerun) },
        read,
        context,
      );
    }
    const engineContext = runContext(read, context, run.projectId, null);
    const failed = engineCall(() =>
      advance(
        workflow,
        run,
        // No rule for a failed step is followed: it could send the run straight back here.
        { type: 'stepFailed', stepId: rerun.stepId, error: refusal, stopped: true },
        engineContext,
      ),
    );
    const kept = effects.filter((effect) => effect !== rerun);
    return transitionEvents(
      cause,
      workflow,
      before,
      { run: failed.run, effects: [...kept, ...failed.effects] },
      read,
      context,
    );
  }
  const events: DomainEvent[] = [];
  const later: RunEffect[] = [];
  for (const effect of effects) {
    if (effect.type === 'setThreadState') {
      if (!read.thread(effect.threadId)) continue;
      events.push({
        kind: 'thread.stateChanged',
        aggregate: effect.threadId,
        payload: { threadId: effect.threadId, state: effect.state, updatedAt: context.now },
      });
      continue;
    }
    if (effect.type === 'sendBack') {
      events.push(...sendBackTurn(effect, read, context));
    }
    if (effect.type === 'startStep') {
      const step = workflow.steps.find((entry) => entry.id === effect.stepId) as WorkflowStep;
      events.push({
        kind: 'thread.created',
        aggregate: effect.threadId,
        payload: stepThread(workflow, run, step, effect.threadId, read, context),
      });
    }
    later.push(effect);
  }
  events.push({
    kind: 'workflowRun.changed',
    aggregate: run.id,
    payload: { cause, run, effects: later },
  });
  events.push(...cardFollowsRun(before, run, read, context));
  events.push(...runNotifications(workflow, run, effects, read, context));
  events.push(...backlogFollowsRun(run, read));
  return events;
}

const USER_CAUSES: ReadonlySet<string> = new Set(['workflowRun.continue', 'workflowRun.sendBack']);

// Why a step cannot run again in its thread right now, if it cannot.
function sendBackRefusal(
  effect: Extract<RunEffect, { type: 'sendBack' }>,
  read: ReadModel,
): string | undefined {
  if (!read.thread(effect.threadId)) {
    return `The thread of step ${effect.stepId} no longer exists, so it cannot be sent back`;
  }
  if (read.runningTurn(effect.threadId)) {
    return "The step's thread is still answering a message. Wait for it or stop that turn, then send back.";
  }
  return undefined;
}

// The turn of a step that runs again in its own thread: sent back at its gate (review loop spec
// 16), or reached again by a rule or the list (workflow branches spec 7, 8). It starts in the same commit as
// the run change and in the step's own thread, which is never created again. A step is running
// exactly while its own turn is, so the runner can take the next turn that ends in the thread as
// the step's outcome: a message the user typed at the gate has ended by now or refuses the send
// back here.
function sendBackTurn(
  effect: Extract<RunEffect, { type: 'sendBack' }>,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const refusal = sendBackRefusal(effect, read);
  if (refusal !== undefined) throw new CommandRejected('rejected', refusal);
  return decideThread(stepMessage(effect), read, context);
}

// A step's turn: the prompt as the engine made it. A prompt made with skills goes with the text
// the thread shows and the skills (wow skills spec 14); a run from before sends it as typed.
export function stepMessage(
  effect: Pick<
    Extract<RunEffect, { type: 'startStep' }>,
    'threadId' | 'prompt' | 'shown' | 'skills'
  >,
): Extract<ServerCommand, { type: 'thread.sendMessage' | 'thread.sendPrepared' }> {
  return effect.skills === undefined
    ? { type: 'thread.sendMessage', threadId: effect.threadId, text: effect.prompt }
    : {
        type: 'thread.sendPrepared',
        threadId: effect.threadId,
        text: effect.shown ?? effect.prompt,
        prompt: effect.prompt,
        skills: effect.skills,
      };
}

// The held turn of a step goes to its thread once the turn the user started there has ended.
// Anything else (the run moved on or was stopped, or the thread answers again) leaves it.
function heldTurnEvents(
  cause: string,
  runId: string,
  stepId: string,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const run = read.run(runId);
  const index = run?.steps.findIndex((entry) => entry.stepId === stepId) ?? -1;
  const held = run?.steps[index];
  if (
    !run ||
    run.state !== 'running' ||
    held?.state !== 'running' ||
    held.heldPrompt === undefined ||
    !held.threadId ||
    read.runningTurn(held.threadId)
  ) {
    return [];
  }
  const { heldPrompt: prompt, ...sent } = held;
  const effect = {
    type: 'sendBack' as const,
    runId,
    stepId,
    threadId: held.threadId,
    attempt: held.attempt ?? 1,
    prompt,
  };
  return [
    ...sendBackTurn(effect, read, context),
    runChanged(cause, {
      ...run,
      steps: run.steps.map((entry, at) => (at === index ? sent : entry)),
    }),
  ];
}

// Every run state has a card state of the same name; `waiting` is what the card shows as "needs
// you".
const cardStateOfRun = (state: WorkflowRun['state']): CardState => state;

// A card shows the state of the run it started (spec 8, 9). A card run again later follows the
// newer run, so an older run's late changes leave it alone.
function cardFollowsRun(
  before: WorkflowRun | undefined,
  run: WorkflowRun,
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  if (run.calendarItemId === null) return [];
  const card = read.calendarItem(run.calendarItemId);
  if (!card || card.source !== 'local') return [];
  if (before !== undefined && card.runId !== run.id) return [];
  const state = cardStateOfRun(run.state);
  if (card.state === state && card.runId === run.id) return [];
  return [
    {
      kind: 'card.stateChanged',
      aggregate: card.id,
      payload: { cardId: card.id, state, runId: run.id, updatedAt: context.now },
    },
  ];
}

const NOTIFICATIONS_KEY = 'scheduler.notifications';

// Whether a global on/off setting is on, as stored or by its default.
export function globalSettingOn(key: string, read: ReadModel, context: DecideContext): boolean {
  const definition = context.registry[key];
  if (!definition) return false;
  const { value } = resolveStored(key, definition, {}, (scope) => read.setting(key, scope));
  return value === true;
}

export const notificationsEnabled = (read: ReadModel, context: DecideContext): boolean =>
  globalSettingOn(NOTIFICATIONS_KEY, read, context);

export const runPath = (runId: string) => `/workflows/runs/${runId}`;

// A run waiting at a gate or failing tells the user through the notification channel (spec 9).
function runNotifications(
  workflow: Workflow,
  run: WorkflowRun,
  effects: readonly RunEffect[],
  read: ReadModel,
  context: DecideContext,
): DomainEvent[] {
  const notices = effects.filter(
    (effect): effect is Extract<RunEffect, { type: 'notify' }> =>
      effect.type === 'notify' && effect.reason !== 'done',
  );
  if (notices.length === 0 || !notificationsEnabled(read, context)) return [];
  const card = run.calendarItemId === null ? undefined : read.calendarItem(run.calendarItemId);
  return notices.map((notice): DomainEvent => {
    const step = workflow.steps.find((entry) => entry.id === notice.stepId);
    const body = [workflow.name, step?.skillName, card?.title].filter(Boolean).join(' · ');
    const waiting = notice.reason === 'waiting';
    const gate = pendingGate(run);
    // A step sent back waits again as a new attempt, which is told again (review loop spec 19).
    const reviewed = reviewedStepIndex(run);
    const attempt = reviewed === undefined ? undefined : run.steps[reviewed]?.attempt;
    // The limit can be reached again after the user let the step run once more.
    const held = gate ? run.steps[gate.stepIndex] : undefined;
    const limit = held?.gate?.state === 'waitingAtLimit' ? `:limit-${held.attempt ?? 1}` : '';
    // A run that a rule sent back waits again before a step it has already been at; without
    // the visit in the id the second wait would be dropped as a repeat of the first.
    const again =
      gate?.position === 'before' && held?.endedAt !== undefined
        ? `:visit-${run.path?.length ?? 0}`
        : '';
    const id = waiting
      ? `${run.id}:waiting:${notice.stepId ?? ''}:${gate?.position ?? ''}${
          attempt === undefined ? '' : `:attempt-${attempt}`
        }${limit}${again}`
      : `${run.id}:failed`;
    const notification: AppNotification = {
      id,
      at: context.now,
      kind: waiting ? 'waiting' : 'failed',
      title: waiting ? 'Waiting for you' : 'Workflow run failed',
      body,
      path: runPath(run.id),
      runId: run.id,
      calendarItemId: run.calendarItemId,
    };
    return { kind: 'notification.sent', aggregate: id, payload: notification };
  });
}

// The thread a step runs in, created idle; the runner sends the step's prompt as its first
// message. Model, effort and permission mode come from the step, then the provider instance
// defaults; the runner fails the step instead of starting a turn while one is still empty.
function stepThread(
  workflow: Workflow,
  run: WorkflowRun,
  step: WorkflowStep,
  threadId: string,
  read: ReadModel,
  context: DecideContext,
): Thread {
  const project = read.project(run.projectId);
  const instance = read.providerInstance(step.providerInstanceId);
  return {
    id: threadId,
    projectId: run.projectId,
    // A run with its own working copy never works in the project folder (review loop spec 36).
    cwd: run.workingCopy?.path ?? project?.cwd ?? '.',
    branch: null,
    providerInstanceId: step.providerInstanceId,
    providerSessionId: null,
    title: `${workflow.name}: ${step.skillName}`,
    model: step.model ?? instance?.defaultModel ?? project?.defaultModel ?? '',
    effort: step.effort ?? instance?.defaultEffort ?? '',
    permissionMode: step.permissionMode ?? instance?.defaultPermissionMode ?? '',
    state: 'idle',
    pinned: false,
    runId: run.id,
    stepId: step.id,
    createdAt: context.now,
    updatedAt: context.now,
  };
}

function runContext(
  read: ReadModel,
  context: DecideContext,
  projectId: string,
  backlogBody: string | null,
): EngineContext {
  return {
    now: context.now,
    handoverTemplate: resolvedTemplate(HANDOVER_KEY, read, context, projectId),
    sendBackTemplate: resolvedTemplate(SEND_BACK_KEY, read, context, projectId),
    unitPromptTemplate: resolvedTemplate(UNIT_PROMPT_KEY, read, context, projectId),
    goBackTemplate: resolvedTemplate(GO_BACK_KEY, read, context, projectId),
    verdictApprovedLine: resolvedTemplate(VERDICT_KEY, read, context, projectId),
    verdictChangesRequestedLine: resolvedTemplate(CHANGES_REQUESTED_KEY, read, context, projectId),
    verdictBlockedLine: resolvedTemplate(BLOCKED_KEY, read, context, projectId),
    maxStepVisits: Number(resolvedSetting(MAX_VISITS_KEY, read, context, projectId)),
    alwaysStopSkills: stringList(resolvedSetting(ALWAYS_STOP_KEY, read, context, projectId)),
    gateChecksTimeoutMinutes: Number(resolvedSetting(CHECKS_TIMEOUT_KEY, read, context, projectId)),
    invocationFor: (step) =>
      folderSkillInvocation(read.skills(), step.skillName, providerKindOf(read, step)),
    skillFor: (step, ref, values) =>
      skillToSend(read.skills(), ref, providerKindOf(read, step), values),
    attachBuiltInSkills: resolvedSetting(ATTACH_KEY, read, context, projectId) !== false,
    backlogBody,
  };
}

const HANDOVER_KEY = 'workflows.handoverTemplate';
const SEND_BACK_KEY = 'workflows.sendBackTemplate';
const UNIT_PROMPT_KEY = 'workflows.unitPromptTemplate';

const GO_BACK_KEY = 'workflows.goBackTemplate';
const VERDICT_KEY = 'workflows.verdictApprovedLine';
const CHANGES_REQUESTED_KEY = 'workflows.verdictChangesRequestedLine';
const BLOCKED_KEY = 'workflows.verdictBlockedLine';
const MAX_VISITS_KEY = 'workflows.maxStepVisits';
const CHECKS_TIMEOUT_KEY = 'workflows.gateChecksTimeoutMinutes';
const ATTACH_KEY = 'workflows.attachBuiltInSkills';

// The setting as it applies to the project, or to all projects without one.
function resolvedSetting(
  key: string,
  read: ReadModel,
  context: DecideContext,
  projectId: string | undefined,
): unknown {
  const definition = context.registry[key];
  if (!definition) throw new Error(`${key} is missing from the settings registry`);
  return resolveStored(key, definition, projectId === undefined ? {} : { projectId }, (scope) =>
    read.setting(key, scope),
  ).value;
}

function resolvedTemplate(key: string, read: ReadModel, context: DecideContext, projectId: string) {
  const value = resolvedSetting(key, read, context, projectId);
  return typeof value === 'string' ? value : String(context.registry[key]?.default);
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];

function providerKindOf(read: ReadModel, step: WorkflowStep) {
  const instance = read.providerInstance(step.providerInstanceId);
  if (!instance) {
    throw new CommandRejected('not_found', `No provider instance ${step.providerInstanceId}`);
  }
  return instance.kind;
}

function backlogBodyOf(read: ReadModel, backlogItemId: string | null): string | null {
  if (backlogItemId === null) return null;
  const item = read.backlogItem(backlogItemId);
  if (!item) throw new CommandRejected('not_found', `No backlog item ${backlogItemId}`);
  return item.body;
}

function requireWorkflow(read: ReadModel, workflowId: string): Workflow {
  const workflow = read.workflow(workflowId);
  if (!workflow) throw new CommandRejected('not_found', `No workflow ${workflowId}`);
  return workflow;
}
