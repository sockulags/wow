import { z } from 'zod';

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
});
export type StepRun = z.infer<typeof StepRun>;
