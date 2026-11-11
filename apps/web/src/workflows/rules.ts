import {
  RuleCondition,
  ruleConditionText,
  ruleProblems,
  type RuleProblem,
  type RuleTarget,
  type StepRule,
} from '@wow/contracts';
import { createStore } from 'zustand';
import type { Choice } from '@/components/choice-select';
import { moveStep, parseGlobs, stepsOf, type DraftStep } from './model';

// The rules under "After this step" in the workflow builder (workflow branches spec 14, 16):
// pure helpers for the three selects of a rule row, and the small store that lets the buttons,
// the keys and the palette act on the same rule.

export type RuleFact = RuleCondition['fact'];

// "When <fact> <value>, go to <target>".
export const ruleFactLabels: Readonly<Record<RuleFact, string>> = {
  verdict: 'the verdict is',
  checks: 'the checks are',
  artifacts: 'the expected artifacts are',
  stepFailed: 'the step failed',
};

const ruleValues: Readonly<Record<RuleFact, readonly Choice[]>> = {
  verdict: [
    { value: 'approved', label: 'approved' },
    { value: 'changesRequested', label: 'changes requested' },
    { value: 'blocked', label: 'blocked' },
    { value: 'none', label: 'not given' },
  ],
  checks: [
    { value: 'successful', label: 'successful' },
    { value: 'failed', label: 'failed' },
  ],
  artifacts: [
    { value: 'found', label: 'found' },
    { value: 'missing', label: 'missing' },
  ],
  stepFailed: [],
};

const firstValue: Readonly<Record<RuleFact, RuleCondition>> = {
  verdict: { fact: 'verdict', is: 'changesRequested' },
  checks: { fact: 'checks', is: 'failed' },
  artifacts: { fact: 'artifacts', is: 'missing' },
  stepFailed: { fact: 'stepFailed' },
};

const expectsArtifacts = (step: Pick<DraftStep, 'artifactsText'>): boolean =>
  parseGlobs(step.artifactsText).length > 0;

// The facts a rule of this step can ask about. Artifacts are offered only when the step names
// expected artifacts; a rule that already asks about them keeps its choice, so the row can show
// what is stored next to the reason it is refused.
export function factChoices(step: Pick<DraftStep, 'artifactsText'>, current: RuleFact): Choice[] {
  return RuleCondition.options
    .map((option) => option.shape.fact.value)
    .filter((fact) => fact !== 'artifacts' || current === 'artifacts' || expectsArtifacts(step))
    .map((fact) => ({ value: fact, label: ruleFactLabels[fact] }));
}

export const valueChoices = (fact: RuleFact): readonly Choice[] => ruleValues[fact];

export const valueOf = (when: RuleCondition): string => ('is' in when ? when.is : '');

export const withFact = (rule: StepRule, fact: string): StepRule => {
  const picked = RuleCondition.options.find((option) => option.shape.fact.value === fact);
  return picked ? { ...rule, when: firstValue[picked.shape.fact.value] } : rule;
};

export function withValue(rule: StepRule, value: string): StepRule {
  const when = RuleCondition.safeParse({ fact: rule.when.fact, is: value });
  return when.success ? { ...rule, when: when.data } : rule;
}

const END = 'end';
const stepValue = (stepId: string) => `step:${stepId}`;

export const targetValue = (goTo: RuleTarget): string =>
  goTo.type === 'end' ? END : stepValue(goTo.stepId);

export const withTarget = (rule: StepRule, value: string): StepRule => ({
  ...rule,
  goTo: value === END ? { type: 'end' } : { type: 'step', stepId: value.slice('step:'.length) },
});

// "2. check-work", or "Step 2" while the step has no skill yet.
export const stepName = (step: Pick<DraftStep, 'skillName'>, index: number): string =>
  step.skillName.trim() === '' ? `Step ${index + 1}` : `${index + 1}. ${step.skillName.trim()}`;

export const missingStepLabel = 'A step that no longer exists';

// Every step and End. A rule whose step was removed keeps its target, named as missing.
export function targetChoices(steps: readonly DraftStep[], goTo: RuleTarget): Choice[] {
  const choices = steps.map((step, index) => ({
    value: stepValue(step.id),
    label: stepName(step, index),
  }));
  const missing =
    goTo.type === 'step' && !steps.some((step) => step.id === goTo.stepId)
      ? [{ value: stepValue(goTo.stepId), label: missingStepLabel }]
      : [];
  return [...missing, ...choices, { value: END, label: 'End' }];
}

const candidates: readonly RuleCondition[] = [
  { fact: 'verdict', is: 'changesRequested' },
  { fact: 'verdict', is: 'approved' },
  { fact: 'verdict', is: 'blocked' },
  { fact: 'verdict', is: 'none' },
  { fact: 'checks', is: 'failed' },
  { fact: 'checks', is: 'successful' },
  { fact: 'stepFailed' },
  { fact: 'artifacts', is: 'missing' },
  { fact: 'artifacts', is: 'found' },
];

// The rule "Add rule" starts with: the first condition the step has no rule for yet (the server
// refuses one condition twice), going back to the step before, or to End from the first step.
// Undefined once every condition has a rule.
export function newRule(steps: readonly DraftStep[], stepId: string): StepRule | undefined {
  const index = steps.findIndex((step) => step.id === stepId);
  const step = steps[index];
  if (!step) return undefined;
  const taken = new Set((step.rules ?? []).map((rule) => ruleConditionText(rule.when)));
  const when = candidates.find(
    (candidate) =>
      !taken.has(ruleConditionText(candidate)) &&
      (candidate.fact !== 'artifacts' || expectsArtifacts(step)),
  );
  const before = steps[index - 1];
  if (!when) return undefined;
  return { when, goTo: before ? { type: 'step', stepId: before.id } : { type: 'end' } };
}

// A step with these rules; a step without rules has no `rules` at all, as before rules existed.
export function withRules(step: DraftStep, rules: readonly StepRule[]): DraftStep {
  const { rules: _before, ...rest } = step;
  return rules.length > 0 ? { ...rest, rules: [...rules] } : rest;
}

// What the server would refuse about the rules as they stand (spec 16), per step and rule.
export const draftRuleProblems = (steps: readonly DraftStep[]): RuleProblem[] =>
  ruleProblems(stepsOf({ name: '', templateKind: null, steps }));

// "When the verdict is changes requested, go to 1. deliver-work", for the palette and for a
// row's accessible name.
export function ruleSentence(rule: StepRule, steps: readonly DraftStep[]): string {
  const value = valueChoices(rule.when.fact).find((choice) => choice.value === valueOf(rule.when));
  const target = targetChoices(steps, rule.goTo).find(
    (choice) => choice.value === targetValue(rule.goTo),
  );
  return `When ${[ruleFactLabels[rule.when.fact], value?.label].filter(Boolean).join(' ')}, go to ${target?.label ?? 'End'}`;
}

// The control of a rule row that takes the keyboard after the row was added or moved.
export type RulePart = 'fact' | 'value' | 'target' | 'up' | 'down' | 'remove';

export interface RulesState {
  // The builder on screen: its draft's steps, and how to give a step other rules (which also
  // opens the step). Undefined while no builder is open.
  readonly builder:
    | {
        readonly steps: readonly DraftStep[];
        setRules(stepId: string, rules: readonly StepRule[]): void;
        // Any other edit of a step (its skills from the palette); absent in older callers.
        changeStep?(stepId: string, changes: Partial<DraftStep>): void;
        // What decides the built-in skills wow attaches by itself (wow skills spec 12).
        readonly forUnits?: boolean;
        readonly attachBuiltIn?: boolean;
      }
    | undefined;
  // The step being edited and the rule that has, or last had, the keyboard.
  readonly at: { readonly stepId: string; readonly rule: number | undefined } | undefined;
  // A rule row that should take the keyboard once it is drawn.
  readonly focus:
    { readonly stepId: string; readonly rule: number; readonly part: RulePart } | undefined;
}

export const rulesStore = createStore<RulesState>(() => ({
  builder: undefined,
  at: undefined,
  focus: undefined,
}));

const place = (stepId: string, rule: number, part: RulePart): void =>
  rulesStore.setState({ at: { stepId, rule }, focus: { stepId, rule, part } });

// The step whose rules the keys and the palette act on, if it is still in the draft.
export function ruleStep(state: RulesState): { step: DraftStep; index: number } | undefined {
  const index = state.builder?.steps.findIndex((step) => step.id === state.at?.stepId) ?? -1;
  const step = state.builder?.steps[index];
  return step ? { step, index } : undefined;
}

export function addRule(stepId: string): void {
  const { builder } = rulesStore.getState();
  const step = builder?.steps.find((candidate) => candidate.id === stepId);
  const rule = builder && newRule(builder.steps, stepId);
  if (!builder || !step || !rule) return;
  const rules = [...(step.rules ?? []), rule];
  builder.setRules(stepId, rules);
  place(stepId, rules.length - 1, 'fact');
}

// Moves a rule one place up (-1) or down (1) and keeps the keyboard on it.
export function moveRule(stepId: string, rule: number, by: -1 | 1, part: RulePart = 'fact'): void {
  const { builder } = rulesStore.getState();
  const rules = builder?.steps.find((candidate) => candidate.id === stepId)?.rules ?? [];
  const to = rule + by;
  if (!builder || rule < 0 || rule >= rules.length || to < 0 || to >= rules.length) return;
  builder.setRules(stepId, moveStep(rules, rule, to));
  place(stepId, to, part);
}

export function removeRule(stepId: string, rule: number): void {
  const { builder } = rulesStore.getState();
  const rules = builder?.steps.find((candidate) => candidate.id === stepId)?.rules;
  if (!builder || !rules?.[rule]) return;
  const left = rules.filter((_, index) => index !== rule);
  builder.setRules(stepId, left);
  if (left.length > 0) place(stepId, Math.min(rule, left.length - 1), 'fact');
  else rulesStore.setState({ at: { stepId, rule: undefined }, focus: undefined });
}

export function changeRule(stepId: string, rule: number, next: StepRule): void {
  const { builder } = rulesStore.getState();
  const rules = builder?.steps.find((candidate) => candidate.id === stepId)?.rules;
  if (!builder || !rules?.[rule]) return;
  builder.setRules(
    stepId,
    rules.map((entry, index) => (index === rule ? next : entry)),
  );
}
