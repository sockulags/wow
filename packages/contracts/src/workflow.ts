import { z } from 'zod';
import { ThreadState } from './provider.js';

export const WorkflowStep = z.object({
  id: z.string().min(1),
  skillName: z.string().min(1),
  providerInstanceId: z.string().min(1),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  permissionMode: z.string().min(1).optional(),
  gateBefore: z.boolean(),
  gateAfter: z.boolean(),
  extraPrompt: z.string().optional(),
  expectedArtifacts: z.array(z.string().min(1)),
});
export type WorkflowStep = z.infer<typeof WorkflowStep>;

// Spec behavior 26: not started, running, waiting, done or failed.
export const StepRunState = z.enum(['not_started', 'running', 'waiting', 'done', 'failed']);
export type StepRunState = z.infer<typeof StepRunState>;

export const StepRun = z.object({
  stepId: z.string().min(1),
  state: StepRunState,
  threadId: z.string().min(1).optional(),
  startedAt: z.iso.datetime().optional(),
  endedAt: z.iso.datetime().optional(),
  artifactsFound: z.array(z.string()),
  // The step's final assistant message, kept for the next step's handover.
  finalMessage: z.string().optional(),
  error: z.string().optional(),
});
export type StepRun = z.infer<typeof StepRun>;

// 'waiting' is "waiting for you" at a gate (behavior 9); 'stopped' is the user pressing Stop.
export const WorkflowRunState = z.enum(['running', 'waiting', 'done', 'failed', 'stopped']);
export type WorkflowRunState = z.infer<typeof WorkflowRunState>;

export const isLiveRunState = (state: WorkflowRunState): boolean =>
  state === 'running' || state === 'waiting';

// What the server does once a run transition has committed. The workflow engine decides them;
// the server performs them and reports outcomes back as commands.
export const RunEffect = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('startStep'),
    runId: z.string().min(1),
    stepId: z.string().min(1),
    threadId: z.string().min(1),
    prompt: z.string(),
  }),
  z.object({ type: z.literal('interrupt'), threadId: z.string().min(1) }),
  z.object({
    type: z.literal('setThreadState'),
    threadId: z.string().min(1),
    state: ThreadState,
  }),
  z.object({
    type: z.literal('notify'),
    runId: z.string().min(1),
    stepId: z.string().min(1).nullable(),
    reason: z.enum(['waiting', 'failed', 'done']),
  }),
]);
export type RunEffect = z.infer<typeof RunEffect>;

// A starting point offered by the builder (behavior 25). Templates carry no provider instance;
// the user picks one per step when building from a template.
export const WorkflowTemplateStep = z.object({
  skillName: z.string().min(1),
  gateBefore: z.boolean(),
  gateAfter: z.boolean(),
  expectedArtifacts: z.array(z.string().min(1)),
});
export type WorkflowTemplateStep = z.infer<typeof WorkflowTemplateStep>;

export const WorkflowTemplate = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  steps: z.array(WorkflowTemplateStep).min(1),
});
export type WorkflowTemplate = z.infer<typeof WorkflowTemplate>;
