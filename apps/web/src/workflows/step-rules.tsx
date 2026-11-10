import type { RuleProblem, StepRule } from '@wow/contracts';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useId, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';
import { eventToBinding, normalizeBinding } from '@/app/keybindings';
import { useSetting } from '@/app/runtime';
import { ChoiceSelect } from '@/components/choice-select';
import { IconButton, ShortcutHint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import type { DraftStep } from './model';
import {
  addRule,
  changeRule,
  factChoices,
  moveRule,
  newRule,
  removeRule,
  rulesStore,
  ruleSentence,
  targetChoices,
  targetValue,
  valueChoices,
  valueOf,
  withFact,
  withTarget,
  withValue,
  type RulePart,
} from './rules';

// "After this step" in a step of the workflow builder (workflow branches spec 14, 16): the
// step's rules in the order they are tried, each "When <fact> <value>, go to <step or End>",
// and the fixed last line. A rule the server would refuse is marked with the server's reason.
//
//   <StepRules step={step} index={1} steps={draft.steps} problems={problems} />

const parts: readonly RulePart[] = ['fact', 'value', 'target', 'up', 'down', 'remove'];

interface RuleRowProps {
  readonly id: string;
  readonly step: DraftStep;
  readonly steps: readonly DraftStep[];
  readonly rule: StepRule;
  readonly at: number;
  readonly count: number;
  readonly label: string;
  readonly reasons: readonly string[];
}

function RuleRow({ id, step, steps, rule, at, count, label, reasons }: RuleRowProps) {
  const up = useSetting('keybindings.ruleMoveUp');
  const down = useSetting('keybindings.ruleMoveDown');
  const name = `${label} rule ${at + 1}`;
  const invalid = reasons.length > 0;
  const values = valueChoices(rule.when.fact);
  const change = (next: StepRule) => changeRule(step.id, at, next);

  // The list of a select opens on an arrow key before the app's own key handler sees it, so the
  // move keys are taken here, on their way down to the control.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLLIElement>) => {
    if (!(event.target instanceof HTMLElement) || !event.currentTarget.contains(event.target)) {
      return;
    }
    const pressed = eventToBinding(event.nativeEvent);
    if (pressed === undefined) return;
    const by = [up, down].findIndex(
      (binding) => binding !== '' && normalizeBinding(binding) === pressed,
    );
    if (by === -1) return;
    event.preventDefault();
    event.stopPropagation();
    const part = parts.find(
      (candidate) =>
        event.target instanceof HTMLElement && event.target.id === `${id}-${candidate}`,
    );
    moveRule(step.id, at, by === 0 ? -1 : 1, part);
  };

  return (
    <li
      aria-label={ruleSentence(rule, steps)}
      data-testid="step-rule"
      data-invalid={invalid || undefined}
      onFocus={() => rulesStore.setState({ at: { stepId: step.id, rule: at } })}
      onKeyDownCapture={onKeyDownCapture}
      className="flex flex-col gap-1"
    >
      <div className="flex items-start gap-1.5 text-xs">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground">When</span>
          <ChoiceSelect
            id={`${id}-fact`}
            label={`${name} fact`}
            size="sm"
            className="w-auto data-[size=sm]:h-7"
            invalid={invalid}
            describedBy={invalid ? `${id}-reason` : undefined}
            value={rule.when.fact}
            choices={factChoices(step, rule.when.fact)}
            onValueChange={(fact) => change(withFact(rule, fact))}
          />
          {values.length > 0 && (
            <ChoiceSelect
              id={`${id}-value`}
              label={`${name} value`}
              size="sm"
              className="w-auto data-[size=sm]:h-7"
              invalid={invalid}
              value={valueOf(rule.when)}
              choices={values}
              onValueChange={(value) => change(withValue(rule, value))}
            />
          )}
          <span className="text-muted-foreground">go to</span>
          <ChoiceSelect
            id={`${id}-target`}
            label={`${name} target`}
            size="sm"
            className="w-auto max-w-56 data-[size=sm]:h-7"
            invalid={invalid}
            value={targetValue(rule.goTo)}
            choices={targetChoices(steps, rule.goTo)}
            onValueChange={(value) => change(withTarget(rule, value))}
          />
        </div>
        <div className="flex h-7 shrink-0 items-center gap-0.5">
          <IconButton
            id={`${id}-up`}
            label={`Move ${name.toLowerCase()} up`}
            shortcut="keybindings.ruleMoveUp"
            size="icon-xs"
            disabled={at === 0}
            onClick={() => moveRule(step.id, at, -1, 'up')}
          >
            <ArrowUpIcon />
          </IconButton>
          <IconButton
            id={`${id}-down`}
            label={`Move ${name.toLowerCase()} down`}
            shortcut="keybindings.ruleMoveDown"
            size="icon-xs"
            disabled={at === count - 1}
            onClick={() => moveRule(step.id, at, 1, 'down')}
          >
            <ArrowDownIcon />
          </IconButton>
          <IconButton
            id={`${id}-remove`}
            label={`Remove ${name.toLowerCase()}`}
            size="icon-xs"
            className="text-destructive hover:text-destructive"
            onClick={() => removeRule(step.id, at)}
          >
            <Trash2Icon />
          </IconButton>
        </div>
      </div>
      {invalid && (
        <p id={`${id}-reason`} role="alert" className="text-xs text-destructive">
          {reasons.join('. ')}
        </p>
      )}
    </li>
  );
}

export function StepRules({
  step,
  index,
  steps,
  problems,
}: {
  readonly step: DraftStep;
  readonly index: number;
  readonly steps: readonly DraftStep[];
  // What the server would refuse about this step's rules.
  readonly problems: readonly RuleProblem[];
}) {
  const id = useId();
  const label = `Step ${index + 1}`;
  const rules = step.rules ?? [];
  const focus = useStore(rulesStore, (state) =>
    state.focus?.stepId === step.id ? state.focus : undefined,
  );
  useEffect(() => {
    if (!focus) return;
    const control = (part: RulePart) => document.getElementById(`${id}-${focus.rule}-${part}`);
    const first = control('fact');
    // The row is drawn with the draft, which may follow the request by one render.
    if (!first) return;
    const wanted = control(focus.part);
    // A move button at the end of the list is off; the row's first select takes the keyboard.
    const off = wanted instanceof HTMLButtonElement && wanted.disabled;
    (wanted && !off ? wanted : first).focus();
    rulesStore.setState({ focus: undefined });
  }, [focus, id, rules.length]);

  const last = index === steps.length - 1;
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-1.5">
      <h4 id={`${id}-title`} className="text-sm leading-none font-medium">
        After this step
      </h4>
      <ol aria-label={`${label} rules`} className="flex flex-col gap-1.5">
        {rules.map((rule, at) => (
          <RuleRow
            // Rules have no id of their own; a moved rule takes the keyboard again by its place.
            // oxlint-disable-next-line react/no-array-index-key
            key={at}
            id={`${id}-${at}`}
            step={step}
            steps={steps}
            rule={rule}
            at={at}
            count={rules.length}
            label={label}
            reasons={problems.filter((problem) => problem.rule === at).map(({ reason }) => reason)}
          />
        ))}
        <li data-testid="rule-otherwise" className="text-xs text-muted-foreground">
          Otherwise: the next step
          {last && ' (this is the last step, so the run ends)'}
        </li>
      </ol>
      <div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={newRule(steps, step.id) === undefined}
          onClick={() => addRule(step.id)}
        >
          <PlusIcon />
          Add rule
          <ShortcutHint shortcut="keybindings.ruleAdd" />
        </Button>
      </div>
    </section>
  );
}
