import type { PathVisit, StepFacts, StepRule, Verdict, WorkflowStep } from '@wow/contracts';
import { verdictLine } from './gate.js';

// Rules on a step (workflow branches spec 1 to 6). Pure: a rule holds or not from the facts the
// server reported when the step ended, never because a model said so.

export interface RuleSettings {
  // The `workflows.verdictChangesRequestedLine` and `workflows.verdictBlockedLine` settings for
  // the run's project; the approved line is the one gates use.
  readonly verdictChangesRequestedLine: string;
  readonly verdictBlockedLine: string;
  // The `workflows.goBackTemplate` setting for the run's project.
  readonly goBackTemplate: string;
  // The `workflows.maxStepVisits` setting for the run's project; a workflow's own number wins.
  readonly maxStepVisits: number;
}

export interface VerdictLines {
  readonly verdictApprovedLine: string;
  readonly verdictChangesRequestedLine: string;
  readonly verdictBlockedLine: string;
}

// The verdict a final message ends with: its last non-empty line, without backticks or bold,
// is one of the three lines, or there is no verdict.
export function readVerdict(message: string, lines: VerdictLines): Verdict {
  const line = verdictLine(message);
  if (line === '') return 'none';
  if (line === lines.verdictApprovedLine.trim()) return 'approved';
  if (line === lines.verdictChangesRequestedLine.trim()) return 'changesRequested';
  if (line === lines.verdictBlockedLine.trim()) return 'blocked';
  return 'none';
}

export const hasRules = (step: WorkflowStep): boolean => (step.rules?.length ?? 0) > 0;

// Whether a rule of the step asks about the fact, so the server knows what to read at its end.
export const ruleAsksAbout = (step: WorkflowStep, fact: StepRule['when']['fact']): boolean =>
  step.rules?.some((rule) => rule.when.fact === fact) ?? false;

// The first rule that holds, `none` when no rule does, or `needsChecks` when a rule on checks
// comes before any rule that holds and the checks were not read yet. A rule for a failed step
// never holds here: the step ended.
export function ruleThatHolds(
  rules: readonly StepRule[],
  facts: StepFacts,
): StepRule | 'none' | 'needsChecks' {
  for (const rule of rules) {
    const { when } = rule;
    switch (when.fact) {
      case 'verdict':
        if (facts.verdict === when.is) return rule;
        break;
      case 'artifacts':
        if (facts.artifacts === when.is) return rule;
        break;
      case 'checks':
        if (facts.checks === undefined) return 'needsChecks';
        if (facts.checks === when.is) return rule;
        break;
      case 'stepFailed':
        break;
    }
  }
  return 'none';
}

export const failedRule = (rules: readonly StepRule[]): StepRule | undefined =>
  rules.find((rule) => rule.when.fact === 'stepFailed');

export const limitSentence = (skillName: string, starts: number): string =>
  `${skillName} has run ${starts} time${starts === 1 ? '' : 's'}: the limit`;

export const lastVisit = (path: readonly PathVisit[] | null | undefined): PathVisit | undefined =>
  path?.at(-1);
