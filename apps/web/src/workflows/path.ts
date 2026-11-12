import {
  ruleConditionText,
  type PathVisit,
  type StepFacts,
  type StepRun,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
} from '@wow/contracts';
import { gateOf, gateStanding } from './model';

// The Path tab of a run (workflow branches spec 18): one row per time a step started, in the
// order it happened, with how the visit ended and why the run went where it went next. All of
// it is read from `run.path`, which the engine writes; nothing here decides anything.

export type VisitState = 'running' | NonNullable<PathVisit['ended']>;

export const visitStateLabels: Readonly<Record<VisitState, string>> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

export const visitStateDotClass: Readonly<Record<VisitState, string>> = {
  running: 'bg-state-working',
  done: 'bg-state-done',
  failed: 'bg-state-failed',
  stopped: 'bg-muted-foreground/50',
};

export interface PathRow {
  // The visit's place in the path, from 1.
  readonly number: number;
  readonly stepId: string;
  readonly stepName: string;
  // The step's place in the workflow's list, from 1; undefined when the step is gone.
  readonly stepNumber: number | undefined;
  readonly attempt: number;
  readonly state: VisitState;
  // Why the run went where it went next, or what it waits for; undefined while the step runs.
  readonly why: string | undefined;
  // The limit sentence, when the run waited for the user because the next step had reached it.
  readonly limit: string | undefined;
  readonly threadId: string | undefined;
  readonly startedAt: string;
  readonly durationMs: number | undefined;
}

// What the step's rules asked about and what was found, for the visit that left these facts:
// "verdict approved", "checks failed, artifacts found".
export function factsText(step: WorkflowStep | undefined, facts: StepFacts): string {
  const asked = new Set((step?.rules ?? []).map((rule) => rule.when.fact));
  const found: string[] = [];
  if (asked.has('verdict')) found.push(ruleConditionText({ fact: 'verdict', is: facts.verdict }));
  if (asked.has('checks') && facts.checks !== undefined) found.push(`checks ${facts.checks}`);
  if (asked.has('artifacts')) {
    found.push(ruleConditionText({ fact: 'artifacts', is: facts.artifacts }));
  }
  return found.join(', ');
}

// A step keeps the facts of its latest attempt only, so they belong to its last visit.
const factsOf = (visit: PathVisit, stepRun: StepRun | undefined): StepFacts | undefined =>
  stepRun?.facts !== undefined && visit.ended === 'done' && (stepRun.attempt ?? 1) === visit.attempt
    ? stepRun.facts
    : undefined;

function whyOf(
  run: WorkflowRun,
  visit: PathVisit,
  last: boolean,
  step: WorkflowStep | undefined,
  stepRun: StepRun | undefined,
): string | undefined {
  if (visit.reason === null) {
    if (visit.ended !== 'done' || !last || run.state !== 'waiting') return undefined;
    return gateStanding(run)?.waitsFor === 'checks' ? 'Waiting for checks' : 'Waiting for you';
  }
  const parts = [visit.reason];
  // When the list decided, the rule that held is not in the reason: say what was found.
  const facts = visit.next?.by === 'list' ? factsOf(visit, stepRun) : undefined;
  const found = facts ? factsText(step, facts) : '';
  if (found !== '') parts[0] = `${found}: ${visit.reason}`;
  if (visit.limit !== undefined) {
    const waits = last && gateOf(run)?.limit !== undefined;
    parts.push(waits ? 'limit reached, waiting for you' : 'limit reached, waited for you');
  }
  return parts.join(' · ');
}

// Undefined for a run from before paths were kept.
export function pathRows(run: WorkflowRun, workflow: Workflow | undefined): PathRow[] | undefined {
  if (!run.path) return undefined;
  const path = run.path;
  return path.map((visit, index) => {
    const at = run.steps.findIndex((entry) => entry.stepId === visit.stepId);
    const step = workflow?.steps.find((candidate) => candidate.id === visit.stepId);
    const stepRun = run.steps[at];
    return {
      number: index + 1,
      stepId: visit.stepId,
      stepName: step?.skillName ?? visit.stepId,
      stepNumber: at >= 0 ? at + 1 : undefined,
      attempt: visit.attempt,
      state: visit.ended ?? 'running',
      why: whyOf(run, visit, index === path.length - 1, step, stepRun),
      limit: visit.limit,
      threadId: stepRun?.threadId,
      startedAt: visit.startedAt,
      durationMs:
        visit.endedAt === null
          ? undefined
          : new Date(visit.endedAt).getTime() - new Date(visit.startedAt).getTime(),
    };
  });
}
