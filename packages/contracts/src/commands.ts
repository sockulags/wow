import { z } from 'zod';
import {
  Approval,
  Project,
  ProviderInstance,
  ProviderInstanceStatus,
  Question,
  Skill,
  Thread,
  ThreadItem,
  Turn,
  TurnState,
  Usage,
  Workflow,
  WorkflowRun,
} from './projections.js';
import {
  ApprovalDecision,
  ProviderEvent,
  ProviderKind,
  ProviderTestResult,
  ThreadState,
} from './provider.js';
import { SecretRef, SettingScopeRef } from './settings.js';
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
  z.object({
    type: z.literal('providerInstance.create'),
    providerInstanceId: Id,
    kind: ProviderKind,
    name: z.string().min(1),
    binaryPath: z.string(),
    configDir: z.string(),
    env: z.record(z.string(), z.union([z.string(), SecretRef])),
    launchArgs: z.array(z.string()),
    defaultModel: z.string().min(1).nullable().optional(),
    defaultEffort: z.string().min(1).nullable().optional(),
    defaultPermissionMode: z.string().min(1).nullable().optional(),
  }),
  // Changes what is given. A change to how the CLI starts clears the last "Test" result.
  z.object({
    type: z.literal('providerInstance.update'),
    providerInstanceId: Id,
    name: z.string().min(1).optional(),
    binaryPath: z.string().optional(),
    configDir: z.string().optional(),
    env: z.record(z.string(), z.union([z.string(), SecretRef])).optional(),
    launchArgs: z.array(z.string()).optional(),
    defaultModel: z.string().min(1).nullable().optional(),
    defaultEffort: z.string().min(1).nullable().optional(),
    defaultPermissionMode: z.string().min(1).nullable().optional(),
  }),
  // Refused while a thread uses the instance, so no thread loses the provider it resumes on.
  z.object({ type: z.literal('providerInstance.delete'), providerInstanceId: Id }),
  z.object({
    type: z.literal('thread.create'),
    threadId: Id,
    providerInstanceId: Id,
    projectId: Id.optional(),
    cwd: z.string().min(1),
    branch: z.string().min(1).optional(),
    title: z.string().optional(),
    model: z.string().min(1),
    effort: z.string().min(1),
    permissionMode: z.string().min(1),
  }),
  // Starts a turn with the thread's current model, effort and permission mode (spec 14, 17).
  z.object({ type: z.literal('thread.sendMessage'), threadId: Id, text: z.string().min(1) }),
  // Stops the running turn; what it produced so far stays (spec 23).
  z.object({ type: z.literal('thread.interrupt'), threadId: Id }),
  z.object({
    type: z.literal('thread.configure'),
    threadId: Id,
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    permissionMode: z.string().min(1).optional(),
  }),
  // Pinned threads sort above the others in their sidebar group (spec 21).
  z.object({ type: z.literal('thread.setPinned'), threadId: Id, pinned: z.boolean() }),
  z.object({ type: z.literal('approval.answer'), approvalId: Id, decision: ApprovalDecision }),
  z.object({ type: z.literal('question.answer'), questionId: Id, answer: z.string() }),
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
]);
export type Command = z.infer<typeof Command>;
export type CommandType = Command['type'];

// Commands only the server issues: what provider adapters report, and test results. They go
// through the same pipeline as client commands but are not accepted over RPC.
export const InternalCommand = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('provider.events'),
    threadId: Id,
    events: z.array(ProviderEvent).min(1),
  }),
  z.object({
    type: z.literal('providerInstance.recordTest'),
    providerInstanceId: Id,
    result: ProviderTestResult,
  }),
  // Replaces the skills projection with a fresh scan; the server's skills watcher sends it.
  z.object({ type: z.literal('skills.sync'), skills: z.array(Skill) }),
  // What the workflow runner reports after a step's turn ended.
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
export type InternalCommand = z.infer<typeof InternalCommand>;

export type ServerCommand = Command | InternalCommand;

export const ProjectChanges = Project.pick({
  name: true,
  cwd: true,
  defaultProviderInstanceId: true,
  defaultModel: true,
}).partial();
export type ProjectChanges = z.infer<typeof ProjectChanges>;

export const ProviderInstanceChanges = ProviderInstance.pick({
  name: true,
  binaryPath: true,
  configDir: true,
  env: true,
  launchArgs: true,
  defaultModel: true,
  defaultEffort: true,
  defaultPermissionMode: true,
  status: true,
  account: true,
  version: true,
  statusMessage: true,
}).partial();
export type ProviderInstanceChanges = z.infer<typeof ProviderInstanceChanges>;

export const ThreadChanges = Thread.pick({
  model: true,
  effort: true,
  permissionMode: true,
}).partial();
export type ThreadChanges = z.infer<typeof ThreadChanges>;

export const WorkflowChanges = Workflow.pick({ name: true, templateKind: true, steps: true })
  .partial()
  .extend({ updatedAt: Workflow.shape.updatedAt });
export type WorkflowChanges = z.infer<typeof WorkflowChanges>;

const Timestamp = z.iso.datetime({ offset: true });

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
    kind: z.literal('providerInstance.created'),
    aggregate: Id,
    payload: ProviderInstance,
  }),
  z.object({
    kind: z.literal('providerInstance.updated'),
    aggregate: Id,
    payload: z.object({
      providerInstanceId: Id,
      changes: ProviderInstanceChanges,
      // Secret store entries the instance no longer references; the server deletes them.
      releasedSecrets: z.array(z.string().min(1)),
    }),
  }),
  z.object({
    kind: z.literal('providerInstance.deleted'),
    aggregate: Id,
    payload: z.object({ providerInstanceId: Id, releasedSecrets: z.array(z.string().min(1)) }),
  }),
  z.object({
    kind: z.literal('providerInstance.tested'),
    aggregate: Id,
    payload: z.object({
      providerInstanceId: Id,
      status: ProviderInstanceStatus,
      account: z.string().nullable(),
      version: z.string().nullable(),
      statusMessage: z.string().nullable(),
    }),
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
    kind: z.literal('thread.configured'),
    aggregate: Id,
    payload: z.object({
      threadId: Id,
      providerInstanceId: Id,
      changes: ThreadChanges,
      updatedAt: Timestamp,
    }),
  }),
  z.object({
    kind: z.literal('thread.sessionStarted'),
    aggregate: Id,
    payload: z.object({ threadId: Id, providerSessionId: z.string().min(1), updatedAt: Timestamp }),
  }),
  z.object({
    kind: z.literal('thread.pinned'),
    aggregate: Id,
    payload: z.object({ threadId: Id, pinned: z.boolean() }),
  }),
  z.object({
    kind: z.literal('thread.stateChanged'),
    aggregate: Id,
    payload: z.object({ threadId: Id, state: ThreadState, updatedAt: Timestamp }),
  }),
  z.object({
    kind: z.literal('turn.started'),
    aggregate: Id,
    payload: z.object({
      turn: Turn,
      item: ThreadItem,
      providerInstanceId: Id,
      // What the provider gets, so the effect does not read the projection again.
      start: z.object({
        cwd: z.string().min(1),
        prompt: z.string(),
        model: z.string().min(1),
        effort: z.string().min(1),
        permissionMode: z.string().min(1),
        resumeId: z.string().min(1).nullable(),
      }),
    }),
  }),
  z.object({
    kind: z.literal('turn.interruptRequested'),
    aggregate: Id,
    payload: z.object({ threadId: Id, turnId: Id, providerInstanceId: Id }),
  }),
  z.object({
    kind: z.literal('turn.usageRecorded'),
    aggregate: Id,
    payload: z.object({ turnId: Id, usage: Usage }),
  }),
  z.object({
    kind: z.literal('turn.ended'),
    aggregate: Id,
    payload: z.object({
      threadId: Id,
      turnId: Id,
      state: TurnState.exclude(['running']),
      threadState: ThreadState,
      endedAt: Timestamp,
    }),
  }),
  z.object({ kind: z.literal('threadItem.added'), aggregate: Id, payload: ThreadItem }),
  // Streaming text grows by appending, so the history does not store every intermediate text.
  z.object({
    kind: z.literal('threadItem.appended'),
    aggregate: Id,
    payload: z.object({ itemId: Id, field: z.enum(['text', 'output']), delta: z.string() }),
  }),
  // Shallow-merges into the item's payload.
  z.object({
    kind: z.literal('threadItem.patched'),
    aggregate: Id,
    payload: z.object({
      itemId: Id,
      patch: z.record(z.string(), z.unknown()),
      streaming: z.boolean().optional(),
    }),
  }),
  z.object({
    kind: z.literal('approval.requested'),
    aggregate: Id,
    payload: z.object({ approval: Approval, item: ThreadItem }),
  }),
  z.object({
    kind: z.literal('approval.answered'),
    aggregate: Id,
    payload: z.object({
      approvalId: Id,
      threadId: Id,
      providerInstanceId: Id,
      providerApprovalId: Id,
      decision: ApprovalDecision,
      decidedAt: Timestamp,
    }),
  }),
  z.object({
    kind: z.literal('question.asked'),
    aggregate: Id,
    payload: z.object({ question: Question, item: ThreadItem }),
  }),
  z.object({
    kind: z.literal('question.answered'),
    aggregate: Id,
    payload: z.object({
      questionId: Id,
      threadId: Id,
      providerInstanceId: Id,
      providerQuestionId: Id,
      answer: z.string(),
      answeredAt: Timestamp,
    }),
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
