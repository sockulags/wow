import {
  alwaysStops,
  awaitedProviderKind,
  lacksRequiredModel,
  missingModelSentence,
  ruleProblems,
  type DomainEvent,
  type ServerCommand,
  type Workflow,
  type WorkflowChanges,
  type WorkflowStep,
} from '@wow/contracts';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { resolveStored } from '../settings/service.js';
import { CommandRejected, type DecideContext, type ReadModel } from './orchestrator.js';

// Decisions for stored workflow definitions, and the settings helpers the other deciders share.

type WorkflowCommand = Extract<ServerCommand, { type: `workflow.${string}` }>;

export const isWorkflowCommand = (command: ServerCommand): command is WorkflowCommand =>
  command.type.startsWith('workflow.');

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
      const steps = withRequiredModels(command.steps, read, context);
      return [
        {
          kind: 'workflow.created',
          aggregate: command.workflowId,
          payload: {
            id: command.workflowId,
            name: command.name,
            templateKind: command.templateKind ?? null,
            steps,
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
        refuseConditions(command.steps, read, context);
        refuseRules(command.steps);
        changes.steps = withRequiredModels(command.steps, read, context);
      }
      if (
        command.maxStepVisits !== undefined &&
        command.maxStepVisits !== (workflow.maxStepVisits ?? null)
      ) {
        changes.maxStepVisits = command.maxStepVisits;
      }
      if (
        command.ownWorkingCopy !== undefined &&
        command.ownWorkingCopy !== (workflow.ownWorkingCopy ?? false)
      ) {
        changes.ownWorkingCopy = command.ownWorkingCopy;
      }
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
  }
}

const ALWAYS_STOP_KEY = 'workflows.alwaysStopSkills';

// A condition belongs to a gate after a step, and never to the gate after a skill that plans or
// specifies (review loop spec 57). Workflows belong to no project, so the list is the one set
// for all projects.
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

// A step on a provider that needs a model gets the instance's default model when it names none,
// and is refused when there is no default (questions and models spec 17). A workflow restored
// as it was stored and an undo keep such a step as it was; a setup file keeps it when there is
// no default, marked (spec 19, 20). A step whose instance is not here yet is judged by the kind
// it waits for.
function withRequiredModels(
  steps: readonly WorkflowStep[],
  read: ReadModel,
  context: DecideContext,
): WorkflowStep[] {
  if (context.putBackSteps) return [...steps];
  return steps.map((step) => {
    const instance = read.providerInstance(step.providerInstanceId);
    const kind = instance?.kind ?? awaitedProviderKind(step.providerInstanceId);
    if (!lacksRequiredModel(step, kind)) return step;
    if (instance?.defaultModel) return { ...step, model: instance.defaultModel };
    if (context.keepStepsWithoutModel || !instance) return step;
    throw new CommandRejected('rejected', missingModelSentence(step.skillName, instance));
  });
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

const WORKSPACES_ROOT_KEY = 'workspaces.root';

// The project's name as a folder name: short, so the path stays well under what Windows allows.
const folderSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 16)
    .replace(/-+$/, '');

// Where a chat thread's own working copy goes (thread work spec 11): `workspaces.root` (inside
// wow's own folder unless it is a full path) and a folder named after the project and the
// thread, with `t` before the id as the copies of runs stored before had none.
export function threadWorkingCopyPath(
  root: string,
  home: string | undefined,
  projectName: string,
  threadId: string,
): string {
  return copyFolder(root, home, projectName, threadId, 't');
}

function copyFolder(
  root: string,
  home: string | undefined,
  projectName: string,
  ownerId: string,
  mark: string,
): string {
  if (!path.isAbsolute(root) && home === undefined) {
    throw new CommandRejected(
      'rejected',
      `${WORKSPACES_ROOT_KEY} is "${root}", which is not a full path, and this server has no folder of its own to put it in`,
    );
  }
  const id = mark + createHash('sha256').update(ownerId).digest('hex').slice(0, 8);
  const slug = folderSlug(projectName);
  return path.join(path.resolve(home ?? '', root), slug === '' ? id : `${slug}-${id}`);
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

// The setting as it applies to the project, or to all projects without one.
export function resolvedSetting(
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

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];

function requireWorkflow(read: ReadModel, workflowId: string): Workflow {
  const workflow = read.workflow(workflowId);
  if (!workflow) throw new CommandRejected('not_found', `No workflow ${workflowId}`);
  return workflow;
}
