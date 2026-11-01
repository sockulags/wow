import { z } from 'zod';
import { ThreadState } from './provider.js';
import { Project, Skill, Thread, Workflow, WorkflowRun } from './projections.js';
import { SettingScopeRef } from './settings.js';
import { RunEffect, WorkflowStep } from './workflow.js';

// Commands are what clients ask for; events are what the server decided happened. Later units
// add their own members to both unions.

const Id = z.string().min(1);

const WorkflowSteps = z
  .array(WorkflowStep)
  .refine((steps) => new Set(steps.map((step) => step.id)).size === steps.length, {
    message: 'Step ids must be unique',
  });

export const CommandId = z.string().min(1).max(200);
export type CommandId = z.infer<typeof CommandId>;

export const Command = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('project.create'),
    projectId: Id,
    name: z.string().min(1),
    cwd: z.string().min(1),
    defaultProviderInstanceId: Id.optional(),
    defaultModel: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('project.update'),
    projectId: Id,
    name: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    defaultProviderInstanceId: Id.nullable().optional(),
    defaultModel: z.string().min(1).nullable().optional(),
  }),
  z.object({ type: z.literal('project.delete'), projectId: Id }),
  z.object({
    type: z.literal('setting.set'),
    key: z.string().min(1),
    scope: SettingScopeRef,
    value: z.unknown(),
  }),
  z.object({ type: z.literal('setting.reset'), key: z.string().min(1), scope: SettingScopeRef }),
  // Replaces the skills projection with a fresh scan; the server's skills watcher sends it.
  z.object({ type: z.literal('skills.sync'), skills: z.array(Skill) }),
  z.object({
    type: z.literal('workflow.create'),
    workflowId: Id,
    name: z.string().min(1),
    templateKind: z.string().min(1).optional(),
    steps: WorkflowSteps,
  }),
  z.object({
    type: z.literal('workflow.update'),
    workflowId: Id,
    name: z.string().min(1).optional(),
    templateKind: z.string().min(1).nullable().optional(),
    steps: WorkflowSteps.optional(),
  }),
  z.object({ type: z.literal('workflow.delete'), workflowId: Id }),
  z.object({
    type: z.literal('workflowRun.start'),
    runId: Id,
    workflowId: Id,
    projectId: Id,
    calendarItemId: Id.optional(),
    backlogItemId: Id.optional(),
  }),
  // The user's answer at a gate (behaviors 9 to 11).
  z.object({ type: z.literal('workflowRun.continue'), runId: Id }),
  z.object({ type: z.literal('workflowRun.stop'), runId: Id }),
  // Outcomes the server reports back after performing a step.
  z.object({
    type: z.literal('workflowRun.stepCompleted'),
    runId: Id,
    stepId: Id,
    finalMessage: z.string(),
    artifactsFound: z.array(z.string()),
  }),
  z.object({
    type: z.literal('workflowRun.stepFailed'),
    runId: Id,
    stepId: Id,
    error: z.string(),
  }),
  z.object({
    type: z.literal('workflowRun.artifactsFound'),
    runId: Id,
    found: z.array(z.object({ stepId: Id, paths: z.array(z.string()) })),
  }),
]);
export type Command = z.infer<typeof Command>;
export type CommandType = Command['type'];

export const ProjectChanges = Project.pick({
  name: true,
  cwd: true,
  defaultProviderInstanceId: true,
  defaultModel: true,
}).partial();
export type ProjectChanges = z.infer<typeof ProjectChanges>;

export const WorkflowChanges = Workflow.pick({ name: true, templateKind: true, steps: true })
  .partial()
  .extend({ updatedAt: Workflow.shape.updatedAt });
export type WorkflowChanges = z.infer<typeof WorkflowChanges>;

export const DomainEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project.created'), aggregate: Id, payload: Project }),
  z.object({
    kind: z.literal('project.updated'),
    aggregate: Id,
    payload: z.object({ projectId: Id, changes: ProjectChanges }),
  }),
  z.object({
    kind: z.literal('project.deleted'),
    aggregate: Id,
    payload: z.object({ projectId: Id }),
  }),
  z.object({
    kind: z.literal('setting.changed'),
    aggregate: Id,
    payload: z.object({ key: z.string().min(1), scope: SettingScopeRef, value: z.unknown() }),
  }),
  z.object({
    kind: z.literal('setting.reset'),
    aggregate: Id,
    payload: z.object({ key: z.string().min(1), scope: SettingScopeRef }),
  }),
  z.object({
    kind: z.literal('skills.synced'),
    aggregate: z.literal('skills'),
    payload: z.object({ upserted: z.array(Skill), removed: z.array(Id) }),
  }),
  z.object({ kind: z.literal('workflow.created'), aggregate: Id, payload: Workflow }),
  z.object({
    kind: z.literal('workflow.updated'),
    aggregate: Id,
    payload: z.object({ workflowId: Id, changes: WorkflowChanges }),
  }),
  z.object({
    kind: z.literal('workflow.deleted'),
    aggregate: Id,
    payload: z.object({ workflowId: Id }),
  }),
  // One per run transition: the run as it now is, what caused it, and the effects the server
  // performs after commit.
  z.object({
    kind: z.literal('workflowRun.changed'),
    aggregate: Id,
    payload: z.object({ cause: z.string().min(1), run: WorkflowRun, effects: z.array(RunEffect) }),
  }),
  z.object({ kind: z.literal('thread.created'), aggregate: Id, payload: Thread }),
  z.object({
    kind: z.literal('thread.stateChanged'),
    aggregate: Id,
    payload: z.object({ threadId: Id, state: ThreadState, updatedAt: Thread.shape.updatedAt }),
  }),
]);
export type DomainEvent = z.infer<typeof DomainEvent>;
export type DomainEventKind = DomainEvent['kind'];

export const DispatchResult = z.object({
  commandId: CommandId,
  // Sequence numbers of the events this command appended; empty when it changed nothing.
  seqs: z.array(z.number().int().positive()),
  // True when the command id had already been applied and this is the stored receipt.
  duplicate: z.boolean(),
});
export type DispatchResult = z.infer<typeof DispatchResult>;
