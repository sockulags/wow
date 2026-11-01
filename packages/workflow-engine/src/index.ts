import type { StepRun, WorkflowStep } from '@wow/contracts';

// Placeholder until U7 adds the engine.
export function initialStepRuns(steps: readonly WorkflowStep[]): StepRun[] {
  return steps.map((step) => ({ stepId: step.id, state: 'not_started', artifactsFound: [] }));
}
