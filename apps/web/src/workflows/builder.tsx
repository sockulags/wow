import type {
  GatePart,
  ProviderInstance,
  RuleProblem,
  Skill,
  StepRule,
  Workflow,
  WorkflowTemplate,
} from '@wow/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  GripVerticalIcon,
  HourglassIcon,
  PlayIcon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  ReplaceIcon,
  BookmarkPlusIcon,
  SearchXIcon,
  SparklesIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useRuntime, useSetting } from '@/app/runtime';
import { errorMessage, useDispatch, useModels, useTopic } from '@/chat/data';
import { ThreadSettings } from '@/chat/thread-settings';
import { providerLabel } from '@/chat/view-model';
import { ChoiceSelect } from '@/components/choice-select';
import { Combobox } from '@/components/combobox';
import { FormField } from '@/components/form-field';
import { IconButton, WithTooltip } from '@/components/hint';
import { MermaidDiagram } from '@/components/mermaid-diagram';
import { EmptyState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { notify, offerUndo } from '@/lib/feedback';
import { useDateFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  applyStepChanges,
  blocking,
  conditionOffered,
  draftFromTemplate,
  draftOf,
  emptyDraft,
  gatePartChoices,
  gateParts,
  moveStep,
  newStep,
  parseGlobs,
  runStateDotClass,
  runStateLabels,
  sameJson,
  saveAsTemplate,
  setGate,
  skillKnown,
  sortRuns,
  stepDefaults,
  stepsOf,
  toggleGatePart,
  validateDraft,
  waitsAt,
  type DraftProblem,
  type DraftStep,
  type WorkflowDraft,
} from './model';
import { diagramText, pathsDiagram } from './paths-diagram';
import { draftRuleProblems, rulesStore, withRules } from './rules';
import { StepRules } from './step-rules';
import {
  attachedSkills,
  refKey,
  skillChoices,
  stepSkillRef,
  toggledLeaveOut,
  withAlsoFollow,
  withoutAlsoFollow,
  withStepSkill,
} from './step-skills';

// New steps run on the first instance whose test passed, else the first (audit C-03). A
// workflow outlives any one chat, so the last thread's instance is not a good guess here.
function preferredInstance(instances: readonly ProviderInstance[]): string {
  return instances.find((instance) => instance.status === 'ready')?.id ?? instances[0]?.id ?? '';
}

function Problems({ problems }: { problems: readonly DraftProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {problems.map((problem) => (
        <li
          key={problem.message}
          role={problem.warning ? undefined : 'alert'}
          className={problem.warning ? 'text-muted-foreground' : 'text-destructive'}
        >
          {problem.message}
        </li>
      ))}
    </ul>
  );
}

// Fills the model, effort and permission mode a step leaves empty with what its instance starts
// with, once the provider has listed its models.
function useStepDefaults(
  step: DraftStep,
  instance: ProviderInstance | undefined,
  onChange: (changes: Partial<DraftStep>) => void,
) {
  const { models } = useModels(instance?.id);
  useEffect(() => {
    if (!instance) return;
    const defaults = stepDefaults(instance, models);
    const missing: Partial<DraftStep> = {};
    if (!step.model && defaults.model !== '') missing.model = defaults.model;
    if (!step.effort && defaults.effort !== '') missing.effort = defaults.effort;
    if (!step.permissionMode && defaults.permissionMode !== '') {
      missing.permissionMode = defaults.permissionMode;
    }
    if (Object.keys(missing).length > 0) onChange(missing);
  }, [instance, models, step.model, step.effort, step.permissionMode, onChange]);
}

// "Matches 2 files in Demo": the step's globs against the project chosen to run in (D-07).
function useArtifactMatches(globs: readonly string[], projectId: string | undefined) {
  const { connection } = useRuntime();
  const key = globs.join('\n');
  const [state, setState] = useState<{ key: string; files: readonly string[] }>();
  useEffect(() => {
    if (!connection || !projectId || key === '') return undefined;
    let current = true;
    connection.request('workflows.matchArtifacts', { projectId, globs: key.split('\n') }).then(
      (result) => {
        const files = (result as { files?: unknown }).files;
        if (current && Array.isArray(files)) {
          setState({ key: `${projectId}:${key}`, files: files.map(String) });
        }
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [connection, projectId, key]);
  return state?.key === `${projectId}:${key}` ? state.files : undefined;
}

// Between two steps (and before the first and after the last): whether the run waits for you
// there. One toggle per position, so a gate is a visible stop in the chain, not a checkbox.
function GateDivider({
  on,
  label,
  onToggle,
  children,
}: {
  on: boolean;
  label: string;
  onToggle(): void;
  children?: ReactNode;
}) {
  return (
    <li className="group/gate flex flex-col gap-1 px-3 py-0.5" data-testid="gate-divider">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn(
            'h-px flex-1 border-t',
            on ? 'border-dashed border-state-needs-you/70' : 'border-transparent',
          )}
        />
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-pressed={on}
          aria-label={label}
          onClick={onToggle}
          className={cn(
            on
              ? 'text-foreground [&_svg]:text-state-needs-you'
              : 'text-muted-foreground opacity-40 group-hover/gate:opacity-100 focus-visible:opacity-100',
          )}
        >
          <HourglassIcon />
          {on ? 'Waits for you' : 'Add a gate'}
        </Button>
        <span
          aria-hidden
          className={cn(
            'h-px flex-1 border-t',
            on ? 'border-dashed border-state-needs-you/70' : 'border-transparent',
          )}
        />
      </div>
      {children}
    </li>
  );
}

// "Pass by itself when" for the gate after a step (review loop spec 54, 57): three parts to
// choose from. A skill that plans or specifies gets no choice, only the reason.
function GateConditionEditor({
  step,
  number,
  alwaysStop,
  onToggle,
}: {
  step: DraftStep | undefined;
  // The step's place in the chain, counted from one.
  number: number;
  alwaysStop: readonly string[];
  onToggle(part: GatePart): void;
}) {
  const id = useId();
  if (!step?.gateAfter) return null;
  if (!conditionOffered(step, alwaysStop)) {
    return (
      <p data-testid="gate-always-stops" className="text-center text-xs text-muted-foreground">
        {step.skillName} plans or specifies, so this gate always waits for you.
      </p>
    );
  }
  const chosen = step.gateAfterCondition ?? [];
  const noArtifacts = chosen.includes('artifacts') && parseGlobs(step.artifactsText).length === 0;
  return (
    <fieldset
      data-testid="gate-condition-editor"
      aria-describedby={noArtifacts ? `${id}-hint` : undefined}
      className="mx-auto flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs"
    >
      <legend className="sr-only">{`Pass the gate after step ${number} by itself when`}</legend>
      <span aria-hidden className="basis-full font-medium">
        Pass by itself when
      </span>
      {gateParts.map((part) => (
        <span key={part} className="flex items-center gap-1.5">
          <Checkbox
            id={`${id}-${part}`}
            checked={chosen.includes(part)}
            onCheckedChange={() => onToggle(part)}
          />
          <Label htmlFor={`${id}-${part}`} className="text-xs font-normal">
            {gatePartChoices[part]}
          </Label>
        </span>
      ))}
      {noArtifacts && (
        <p id={`${id}-hint`} className="basis-full text-muted-foreground">
          Step {number} names no expected artifacts yet, so this part cannot hold.
        </p>
      )}
    </fieldset>
  );
}

interface StepEditorProps {
  readonly step: DraftStep;
  readonly index: number;
  // Every step of the draft, for the targets of this step's rules.
  readonly steps: readonly DraftStep[];
  readonly instances: readonly ProviderInstance[];
  readonly skills: readonly Skill[];
  readonly problems: readonly DraftProblem[];
  // What the server would refuse about this step's rules.
  readonly ruleProblems: readonly RuleProblem[];
  readonly dragging: boolean;
  readonly expanded: boolean;
  readonly runProject: { readonly id: string; readonly name: string } | undefined;
  // The workflow's "For units" and the `workflows.attachBuiltInSkills` setting, for the built-in
  // skills wow attaches by itself.
  readonly forUnits: boolean;
  readonly attachBuiltIn: boolean;
  onToggle(): void;
  onChange(stepId: string, changes: Partial<DraftStep>): void;
  onRemove(stepId: string): void;
  onMove(from: number, to: number): void;
  onDragStart(index: number): void;
  onDragEnd(): void;
  onDrop(index: number): void;
}

function StepEditor({
  step,
  index,
  steps,
  instances,
  skills,
  problems,
  ruleProblems,
  dragging,
  expanded,
  runProject,
  forUnits,
  attachBuiltIn,
  onToggle,
  onChange,
  onRemove,
  onMove,
  onDragStart,
  onDragEnd,
  onDrop,
}: StepEditorProps) {
  const id = useId();
  const instance = instances.find((candidate) => candidate.id === step.providerInstanceId);
  const change = useCallback(
    (changes: Partial<DraftStep>) => onChange(step.id, changes),
    [onChange, step.id],
  );
  useStepDefaults(step, instance, change);
  const choices = skillChoices(skills);
  const known = skillKnown(step.skillName, skills);
  const current = refKey(stepSkillRef(step));
  const selected = choices.find((choice) => choice.value === current);
  const following = step.alsoFollow ?? [];
  const followable = choices.filter(
    (choice) => choice.value !== current && !following.some((ref) => refKey(ref) === choice.value),
  );
  const attached = attachedSkills(step, { on: attachBuiltIn, forUnits, skills });
  const globs = parseGlobs(step.artifactsText);
  const matches = useArtifactMatches(globs, runProject?.id);
  const label = `Step ${index + 1}`;
  const count = steps.length;
  const ruleCount = step.rules?.length ?? 0;
  const summary = [
    instance ? providerLabel(instance, instances) : 'No provider',
    step.model,
    globs.length > 0 ? `${globs.length} artifact${globs.length === 1 ? '' : 's'}` : undefined,
    ruleCount > 0 ? `${ruleCount} rule${ruleCount === 1 ? '' : 's'}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  // An open step marks the rule itself; a closed one says it on its line.
  const shownProblems = expanded
    ? problems
    : [
        ...problems,
        ...ruleProblems.map(({ rule, reason }) => ({ message: `Rule ${rule + 1}: ${reason}.` })),
      ];
  return (
    <li
      aria-label={label}
      data-testid="workflow-step"
      onFocus={() => {
        // The step being edited is the one the rule keys and palette commands add to.
        if (rulesStore.getState().at?.stepId !== step.id) {
          rulesStore.setState({ at: { stepId: step.id, rule: undefined } });
        }
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(index);
      }}
      className={cn(
        'flex flex-col rounded-md border bg-card',
        problems.some((problem) => !problem.warning) || ruleProblems.length > 0
          ? 'border-destructive/60'
          : 'border-border',
        dragging && 'opacity-50',
      )}
    >
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span
          draggable
          aria-hidden
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', step.id);
            onDragStart(index);
          }}
          onDragEnd={onDragEnd}
          className="cursor-grab text-muted-foreground active:cursor-grabbing"
        >
          <GripVerticalIcon className="size-4" />
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label.toLowerCase()}`}
          onClick={onToggle}
          className="h-7 min-w-0 flex-1 justify-start gap-2 px-1.5 font-normal"
        >
          <ChevronRightIcon
            className={cn('size-4 shrink-0 transition-transform', expanded && 'rotate-90')}
          />
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{index + 1}</span>
          <span className="shrink-0 font-medium">{step.skillName || 'Pick a skill'}</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span>
        </Button>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            label={`Move ${label.toLowerCase()} up`}
            size="icon-xs"
            disabled={index === 0}
            onClick={() => onMove(index, index - 1)}
          >
            <ArrowUpIcon />
          </IconButton>
          <IconButton
            label={`Move ${label.toLowerCase()} down`}
            size="icon-xs"
            disabled={index === count - 1}
            onClick={() => onMove(index, index + 1)}
          >
            <ArrowDownIcon />
          </IconButton>
          <IconButton
            label={`Remove ${label.toLowerCase()}`}
            size="icon-xs"
            className="text-destructive hover:text-destructive"
            onClick={() => onRemove(step.id)}
          >
            <Trash2Icon />
          </IconButton>
        </div>
      </div>
      {expanded && (
        <div className="flex flex-col gap-4 border-t border-border px-3 pt-3 pb-3 pl-9">
          <FormField
            id={`${id}-skill`}
            label="Skill"
            help={selected && selected.description !== '' ? selected.description : undefined}
          >
            <Combobox
              label={`${label} skill`}
              size="sm"
              className="w-full max-w-sm"
              value={current}
              placeholder="Pick a skill…"
              searchPlaceholder="Search skills…"
              emptyText="No matching skill."
              choices={[
                ...(step.skillName !== '' && !known
                  ? [{ value: current, label: step.skillName, detail: 'Not found' }]
                  : []),
                ...choices,
              ]}
              onValueChange={(value) => {
                const picked = choices.find((choice) => choice.value === value);
                if (picked) change(withStepSkill(picked.ref));
              }}
            />
          </FormField>
          <FormField
            id={`${id}-also`}
            label="Also follow"
            help="Sent after the step's skill, in this order, before the extra prompt."
            group
          >
            <div className="flex flex-wrap items-center gap-1.5" data-testid="also-follow">
              {following.map((ref) => (
                <Badge key={refKey(ref)} variant="outline" className="gap-1 pr-0.5">
                  <span className="font-mono">{ref.name}</span>
                  <span className="text-muted-foreground">
                    {choices.find((choice) => choice.value === refKey(ref))?.detail ?? 'Not found'}
                  </span>
                  <IconButton
                    label={`Stop following ${ref.name} in ${label.toLowerCase()}`}
                    size="icon-xs"
                    onClick={() => change(withoutAlsoFollow(step, ref))}
                  >
                    <XIcon />
                  </IconButton>
                </Badge>
              ))}
              <Combobox
                label={`${label} also follow`}
                size="sm"
                className="w-auto"
                value=""
                placeholder="Add a skill…"
                searchPlaceholder="Search skills…"
                emptyText="No other skill."
                choices={followable}
                onValueChange={(value) => {
                  const picked = followable.find((choice) => choice.value === value);
                  if (picked) change(withAlsoFollow(step, picked.ref));
                }}
              />
            </div>
          </FormField>
          {attached.length > 0 && (
            <section
              aria-label={`${label} skills attached by wow`}
              data-testid="attached-skills"
              className="flex flex-col gap-1"
            >
              <h4 className="text-xs font-medium">Attached automatically</h4>
              <ul className="flex flex-col gap-1 text-xs">
                {attached.map((skill) => (
                  <li
                    key={skill.name}
                    data-testid="attached-skill"
                    data-left={skill.left || undefined}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <Badge variant={skill.left ? 'outline' : 'secondary'}>
                      <SparklesIcon />
                      <span className={cn('font-mono', skill.left && 'line-through')}>
                        {skill.name}
                      </span>
                    </Badge>
                    <span className="text-muted-foreground">
                      {skill.left
                        ? `Left out; wow would attach it because ${skill.reason}.`
                        : `Because ${skill.reason}.`}
                    </span>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      aria-label={
                        skill.left
                          ? `Attach ${skill.name} to ${label.toLowerCase()} again`
                          : `Leave ${skill.name} out of ${label.toLowerCase()}`
                      }
                      onClick={() => change(toggledLeaveOut(step, skill.name))}
                    >
                      {skill.left ? 'Attach again' : 'Leave out'}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <FormField id={`${id}-agent`} label="Agent" group>
            <div className="flex flex-wrap items-center gap-1.5">
              <ChoiceSelect
                label={`${label} provider instance`}
                size="sm"
                className="w-auto data-[size=sm]:h-7"
                value={step.providerInstanceId}
                placeholder="Pick a provider…"
                choices={instances.map((candidate) => ({
                  value: candidate.id,
                  label: providerLabel(candidate, instances),
                }))}
                onValueChange={(providerInstanceId) => change({ providerInstanceId })}
              />
              {instance && (
                <ThreadSettings
                  providerInstanceId={instance.id}
                  kind={instance.kind}
                  value={{
                    model: step.model ?? '',
                    effort: step.effort ?? '',
                    permissionMode: step.permissionMode ?? '',
                  }}
                  onChange={change}
                />
              )}
            </div>
          </FormField>
          <div className="grid gap-4 md:grid-cols-2">
            <FormField id={`${id}-prompt`} label="Extra prompt" help="Sent after the skills.">
              <Textarea
                aria-label={`${label} extra prompt`}
                rows={2}
                className="text-xs"
                value={step.extraPrompt ?? ''}
                onChange={(event) => change({ extraPrompt: event.target.value })}
              />
            </FormField>
            <FormField
              id={`${id}-artifacts`}
              label="Expected artifacts"
              help={
                runProject && globs.length > 0 && matches
                  ? `Matches ${matches.length} file${matches.length === 1 ? '' : 's'} in ${runProject.name} now.`
                  : 'One path or glob per line, relative to the project folder.'
              }
            >
              <Textarea
                aria-label={`${label} expected artifacts`}
                rows={2}
                className="font-mono text-xs placeholder:font-sans"
                value={step.artifactsText}
                placeholder="For example docs/*.md"
                onChange={(event) => change({ artifactsText: event.target.value })}
              />
            </FormField>
          </div>
          <StepRules step={step} index={index} steps={steps} problems={ruleProblems} />
        </div>
      )}
      {shownProblems.length > 0 && (
        <div className="px-3 pb-2 pl-9">
          <Problems problems={shownProblems} />
        </div>
      )}
    </li>
  );
}

function RunsOfWorkflow({ workflow }: { workflow: Workflow }) {
  const projects = useTopic('projects') ?? [];
  const runs = (useTopic('workflowRuns') ?? []).filter((run) => run.workflowId === workflow.id);
  const { when } = useDateFormat();
  if (runs.length === 0) return null;
  return (
    <section aria-label="Runs of this workflow" className="mt-6 flex flex-col gap-1">
      <h3 className="px-2 text-xs font-medium text-muted-foreground">Runs</h3>
      <ul className="flex flex-col gap-0.5">
        {sortRuns(runs).map((run) => (
          <li key={run.id}>
            <Link
              to="/workflows/runs/$runId"
              params={{ runId: run.id }}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                aria-hidden
                className={cn('size-1.5 rounded-full', runStateDotClass[run.state])}
              />
              <span>{runStateLabels[run.state]}</span>
              <span className="text-muted-foreground">
                {projects.find((candidate) => candidate.id === run.projectId)?.name ??
                  run.projectId}{' '}
                · {when(run.startedAt)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Builder({
  workflow,
  initial,
  instances,
}: {
  workflow: Workflow | undefined;
  initial: WorkflowDraft;
  instances: readonly ProviderInstance[];
}) {
  const { connection, settings } = useRuntime();
  const send = useDispatch();
  const navigate = useNavigate();
  const skills = useTopic('skills') ?? [];
  const projects = useTopic('projects') ?? [];
  const templates = useSetting('workflows.templates');
  const [draft, setDraft] = useState<WorkflowDraft>(initial);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [templateName, setTemplateName] = useState<string>();
  const [templateError, setTemplateError] = useState<string>();
  const [dragIndex, setDragIndex] = useState<number>();
  const [refreshing, setRefreshing] = useState(false);
  const [projectId, setProjectId] = useState<string>('');
  const [starting, setStarting] = useState(false);
  // New workflows open every step; an existing one shows the chain, one line per step.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(workflow ? [] : initial.steps.map((step) => step.id)),
  );

  const problems = validateDraft(draft, instances, skills);
  const shown = attempted ? problems : problems.filter((problem) => problem.warning);
  const alwaysStop = useSetting('workflows.alwaysStopSkills');
  const attachBuiltIn = useSetting('workflows.attachBuiltInSkills');
  const steps = stepsOf(draft, alwaysStop);
  const ownWorkingCopy = draft.ownWorkingCopy ?? false;
  // The palette switches it on the stored workflow; the draft follows so Save does not undo it.
  const storedOwnCopy = workflow?.ownWorkingCopy ?? false;
  useEffect(() => {
    setDraft((current) => ({ ...current, ownWorkingCopy: storedOwnCopy }));
  }, [storedOwnCopy]);
  const forUnits = draft.forUnits ?? false;
  const storedForUnits = workflow?.forUnits ?? false;
  useEffect(() => {
    setDraft((current) => ({ ...current, forUnits: storedForUnits }));
  }, [storedForUnits]);
  const dirty =
    !workflow ||
    workflow.name !== draft.name.trim() ||
    workflow.templateKind !== draft.templateKind ||
    (workflow.ownWorkingCopy ?? false) !== ownWorkingCopy ||
    (workflow.forUnits ?? false) !== forUnits ||
    !sameJson(workflow.steps, steps);
  const firstInstance = preferredInstance(instances);
  const runProject = projects.find((candidate) => candidate.id === projectId) ?? projects[0];
  const basedOn = templates.find((candidate) => candidate.kind === draft.templateKind);
  const blockedReason =
    instances.length === 0
      ? 'Add a provider instance first'
      : draft.name.trim() === ''
        ? 'Give the workflow a name first'
        : draft.steps.length === 0
          ? 'Add at least one step first'
          : undefined;

  const [changeStep] = useState(() => (stepId: string, changes: Partial<DraftStep>) => {
    setSaved(false);
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.id === stepId ? applyStepChanges(step, changes) : step,
      ),
    }));
  });

  const edit = (next: (current: WorkflowDraft) => WorkflowDraft) => {
    setSaved(false);
    setDraft(next);
  };
  const move = (from: number, to: number) =>
    edit((current) => ({ ...current, steps: moveStep(current.steps, from, to) }));
  const toggleCondition = (stepIndex: number, part: GatePart) =>
    edit((current) => ({
      ...current,
      steps: current.steps.map((step, index) =>
        index === stepIndex ? toggleGatePart(step, part) : step,
      ),
    }));
  // The rules' buttons, keys and palette commands change the draft through the rules store, and
  // a step whose rules change opens.
  const [setRules] = useState(() => (stepId: string, rules: readonly StepRule[]) => {
    setSaved(false);
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step) => (step.id === stepId ? withRules(step, rules) : step)),
    }));
    setExpanded((current) => (current.has(stepId) ? current : new Set([...current, stepId])));
  });
  useEffect(() => {
    rulesStore.setState({
      builder: { steps: draft.steps, setRules, changeStep, forUnits, attachBuiltIn },
    });
  }, [draft.steps, setRules, changeStep, forUnits, attachBuiltIn]);
  useEffect(
    () => () => rulesStore.setState({ builder: undefined, at: undefined, focus: undefined }),
    [],
  );
  const ruleProblems = useMemo(() => draftRuleProblems(draft.steps), [draft.steps]);
  const diagram = useMemo(() => pathsDiagram(draft.steps), [draft.steps]);
  const toggle = (stepId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });

  const applyTemplate = (chosen: WorkflowTemplate | undefined) => {
    const next = {
      ...(chosen
        ? draftFromTemplate(chosen, firstInstance, draft.name)
        : { ...emptyDraft, name: draft.name }),
      ownWorkingCopy,
      forUnits,
    };
    edit(() => next);
    setExpanded(new Set(workflow ? [] : next.steps.map((step) => step.id)));
    setReplacing(false);
  };

  const save = async () => {
    setAttempted(true);
    setError(undefined);
    if (blocking(problems).length > 0) {
      // Open the steps that need attention.
      setExpanded(
        (current) =>
          new Set([
            ...current,
            ...problems.flatMap((problem) =>
              problem.stepId && !problem.warning ? [problem.stepId] : [],
            ),
          ]),
      );
      return;
    }
    setSaving(true);
    try {
      if (workflow) {
        await send({
          type: 'workflow.update',
          workflowId: workflow.id,
          name: draft.name.trim(),
          templateKind: draft.templateKind,
          steps,
          ownWorkingCopy,
          forUnits,
        });
        setSaved(true);
      } else {
        const workflowId = globalThis.crypto.randomUUID();
        await send({
          type: 'workflow.create',
          workflowId,
          name: draft.name.trim(),
          ...(draft.templateKind === null ? {} : { templateKind: draft.templateKind }),
          steps,
          ...(ownWorkingCopy ? { ownWorkingCopy } : {}),
          ...(forUnits ? { forUnits } : {}),
        });
        notify.success(`Workflow ${draft.name.trim()} created`);
        await navigate({ to: '/workflows/$workflowId', params: { workflowId } });
      }
      setAttempted(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  // Deleted at once; Undo puts the same row back (owner decision F-9).
  const remove = async () => {
    if (!workflow) return;
    try {
      await send({ type: 'workflow.delete', workflowId: workflow.id });
      offerUndo({
        message: `Workflow ${workflow.name} deleted`,
        undoneMessage: `Workflow ${workflow.name} restored`,
        undo: () => send({ type: 'workflow.restore', workflow }),
      });
      await navigate({ to: '/workflows' });
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  const run = async () => {
    if (!workflow || !runProject) return;
    setError(undefined);
    setStarting(true);
    const runId = globalThis.crypto.randomUUID();
    try {
      await send({
        type: 'workflowRun.start',
        runId,
        workflowId: workflow.id,
        projectId: runProject.id,
      });
      await navigate({ to: '/workflows/runs/$runId', params: { runId } });
    } catch (failure) {
      setError(errorMessage(failure));
      setStarting(false);
    }
  };

  // Templates are edited here as well as in Settings (audit E-05); the JSON editor there stays
  // for what this does not cover, such as deleting one.
  const saveTemplate = async () => {
    const result = saveAsTemplate(templates, draft, templateName ?? '');
    if (typeof result === 'string') return setTemplateError(result);
    const written = await settings.write('workflows.templates', result.templates);
    if (!written.ok) return setTemplateError(written.issues.join('; '));
    notify.success(`Template ${(templateName ?? '').trim()} saved`, {
      description: 'New workflows can start from it.',
    });
    setTemplateName(undefined);
    setTemplateError(undefined);
  };

  const refreshSkills = async () => {
    if (!connection) return;
    setRefreshing(true);
    try {
      await connection.request('skills.refresh', {});
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setRefreshing(false);
    }
  };

  const saveButton = (
    <Button
      type="submit"
      size="sm"
      variant={workflow ? 'outline' : 'default'}
      disabled={saving || !dirty || blockedReason !== undefined}
    >
      {workflow ? 'Save' : 'Create workflow'}
    </Button>
  );
  const runBlocked = !runProject
    ? 'Add a project to run in'
    : dirty
      ? 'Save the changes to run them'
      : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        aria-label="Workflow builder"
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className="flex shrink-0 flex-col gap-3 border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium">{workflow ? 'Edit workflow' : 'New workflow'}</h2>
            {workflow && basedOn && (
              <span data-testid="based-on" className="text-xs text-muted-foreground">
                Based on {basedOn.name}
              </span>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {saved && !dirty && (
                <span role="status" className="text-xs text-muted-foreground">
                  Saved
                </span>
              )}
              {workflow && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => void remove()}
                >
                  <Trash2Icon />
                  Delete
                </Button>
              )}
              {blockedReason ? (
                <WithTooltip label={blockedReason}>
                  <span tabIndex={0} className="rounded-md">
                    {saveButton}
                  </span>
                </WithTooltip>
              ) : (
                saveButton
              )}
              {workflow && (
                <div role="group" aria-label="Run" className="flex items-center">
                  <ChoiceSelect
                    label="Run in project"
                    size="sm"
                    className="w-auto max-w-40 rounded-r-none border-r-0"
                    value={runProject?.id ?? ''}
                    placeholder="No projects"
                    disabled={projects.length === 0}
                    choices={projects.map((candidate) => ({
                      value: candidate.id,
                      label: candidate.name,
                    }))}
                    onValueChange={setProjectId}
                  />
                  <WithTooltip label={runBlocked ?? `Run in ${runProject?.name ?? ''}`}>
                    <span tabIndex={runBlocked ? 0 : -1} className="rounded-md">
                      <Button
                        type="button"
                        size="sm"
                        className="rounded-l-none"
                        disabled={runBlocked !== undefined || starting}
                        onClick={() => void run()}
                      >
                        <PlayIcon />
                        Run now
                      </Button>
                    </span>
                  </WithTooltip>
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <FormField id="workflow-name" label="Workflow name" className="w-72">
              <Input
                autoFocus={!workflow}
                value={draft.name}
                placeholder={workflow ? undefined : 'For example Feature: search panel'}
                onChange={(event) => edit((current) => ({ ...current, name: event.target.value }))}
                className="h-8"
              />
            </FormField>
            {!workflow && (
              <FormField id="workflow-template" label="Start from" group>
                <div role="group" aria-label="Start from template" className="flex gap-1">
                  {[undefined, ...templates].map((candidate) => {
                    const pressed =
                      candidate === undefined
                        ? draft.templateKind === null
                        : draft.templateKind === candidate.kind;
                    const button = (
                      <Button
                        type="button"
                        size="sm"
                        variant={pressed ? 'secondary' : 'outline'}
                        aria-pressed={pressed}
                        onClick={() => applyTemplate(candidate)}
                      >
                        {candidate?.name ?? 'Blank'}
                      </Button>
                    );
                    return candidate ? (
                      <WithTooltip
                        key={candidate.kind}
                        label={candidate.steps.map((step) => step.skillName).join(' → ')}
                      >
                        {button}
                      </WithTooltip>
                    ) : (
                      <span key="blank">{button}</span>
                    );
                  })}
                </div>
              </FormField>
            )}
            <WithTooltip label="Each run works in its own Git working copy under the working copies folder, made at the newest commit of the default branch. Your project folder is left alone.">
              <div className="flex h-8 items-center gap-2">
                <Switch
                  id="workflow-own-copy"
                  checked={ownWorkingCopy}
                  onCheckedChange={(checked) =>
                    edit((current) => ({ ...current, ownWorkingCopy: checked }))
                  }
                />
                <Label htmlFor="workflow-own-copy" className="text-xs font-normal">
                  Own working copy
                </Label>
              </div>
            </WithTooltip>
            <WithTooltip label="A plan run may use this workflow: “Run ready units” in the Plans view runs it once for each ready unit, always in an own working copy, and tells every step which unit it works on.">
              <div className="flex h-8 items-center gap-2">
                <Switch
                  id="workflow-for-units"
                  checked={forUnits}
                  onCheckedChange={(checked) =>
                    edit((current) => ({ ...current, forUnits: checked }))
                  }
                />
                <Label htmlFor="workflow-for-units" className="text-xs font-normal">
                  For units
                </Label>
              </div>
            </WithTooltip>
            <div className="ml-auto flex items-center gap-1">
              {workflow && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-expanded={replacing}
                  onClick={() => setReplacing(!replacing)}
                >
                  <ReplaceIcon />
                  Replace steps with template…
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-expanded={templateName !== undefined}
                disabled={draft.steps.length === 0}
                onClick={() =>
                  setTemplateName(
                    templateName === undefined ? (basedOn?.name ?? draft.name) : undefined,
                  )
                }
              >
                <BookmarkPlusIcon />
                Save as template…
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!connection || refreshing}
                onClick={() => void refreshSkills()}
              >
                <RefreshCwIcon className={cn(refreshing && 'animate-spin')} />
                Refresh skills
              </Button>
            </div>
          </div>
          {templateName !== undefined && (
            <div
              role="group"
              aria-label="Save as template"
              className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
            >
              <FormField
                id="template-name"
                label="Template name"
                help="Saves the skills, gates and expected artifacts. A template with this name is replaced."
                error={templateError}
                className="min-w-64 flex-1"
              >
                <Input
                  autoFocus
                  value={templateName}
                  onChange={(event) => {
                    setTemplateName(event.target.value);
                    setTemplateError(undefined);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void saveTemplate();
                    }
                  }}
                  className="h-8"
                />
              </FormField>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setTemplateName(undefined)}
              >
                Cancel
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void saveTemplate()}>
                Save template
              </Button>
            </div>
          )}
          {replacing && workflow && (
            <div
              role="group"
              aria-label="Replace steps with template"
              className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1">
                This replaces all {draft.steps.length} steps. Nothing changes until you save.
              </span>
              {templates.map((candidate) => (
                <Button
                  key={candidate.kind}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => applyTemplate(candidate)}
                >
                  {candidate.name}
                </Button>
              ))}
              <Button type="button" size="sm" variant="ghost" onClick={() => setReplacing(false)}>
                Cancel
              </Button>
            </div>
          )}
          {instances.length === 0 && (
            <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <PlugIcon aria-hidden className="size-3.5" />
              Every step runs on a provider instance.{' '}
              <Link
                to="/settings/$group"
                params={{ group: 'providers' }}
                className="text-foreground underline underline-offset-2"
              >
                Add a provider instance
              </Link>
            </p>
          )}
          <Problems problems={shown.filter((problem) => problem.stepId === undefined)} />
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </header>
        {/* Wide enough, the steps and the diagram scroll side by side, each on its own. */}
        <div className="@container flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto @3xl:flex-row @3xl:overflow-hidden">
            <div className="min-w-0 shrink-0 px-4 py-3 @3xl:flex-1 @3xl:shrink @3xl:overflow-y-auto">
              <ol aria-label="Steps" className="flex flex-col">
                {draft.steps.map((step, index) => (
                  <StepPosition
                    key={step.id}
                    draft={draft}
                    index={index}
                    alwaysStop={alwaysStop}
                    onToggleGate={() => edit((current) => setGate(current, index))}
                    onTogglePart={toggleCondition}
                  >
                    <StepEditor
                      step={step}
                      index={index}
                      steps={draft.steps}
                      instances={instances}
                      skills={skills}
                      problems={shown.filter((problem) => problem.stepId === step.id)}
                      ruleProblems={ruleProblems.filter((problem) => problem.stepId === step.id)}
                      dragging={dragIndex === index}
                      expanded={expanded.has(step.id)}
                      runProject={runProject}
                      forUnits={forUnits}
                      attachBuiltIn={attachBuiltIn}
                      onToggle={() => toggle(step.id)}
                      onChange={changeStep}
                      onRemove={(stepId) =>
                        edit((current) => ({
                          ...current,
                          steps: current.steps.filter((candidate) => candidate.id !== stepId),
                        }))
                      }
                      onMove={move}
                      onDragStart={setDragIndex}
                      onDragEnd={() => setDragIndex(undefined)}
                      onDrop={(to) => {
                        if (dragIndex !== undefined) move(dragIndex, to);
                        setDragIndex(undefined);
                      }}
                    />
                  </StepPosition>
                ))}
                {draft.steps.length > 0 && (
                  <GateDivider
                    on={waitsAt(draft, draft.steps.length)}
                    label="Gate after the last step"
                    onToggle={() => edit((current) => setGate(current, current.steps.length))}
                  >
                    <GateConditionEditor
                      step={draft.steps.at(-1)}
                      number={draft.steps.length}
                      alwaysStop={alwaysStop}
                      onToggle={(part) => toggleCondition(draft.steps.length - 1, part)}
                    />
                  </GateDivider>
                )}
              </ol>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => {
                  const step = newStep(firstInstance);
                  edit((current) => ({ ...current, steps: [...current.steps, step] }));
                  setExpanded((current) => new Set([...current, step.id]));
                }}
              >
                <PlusIcon />
                Add step
              </Button>
              {workflow && <RunsOfWorkflow workflow={workflow} />}
            </div>
            {draft.steps.length > 0 && (
              <section
                aria-label="Paths"
                data-testid="paths-diagram"
                className="flex shrink-0 flex-col gap-1 px-4 py-3 @3xl:w-80 @3xl:overflow-y-auto @3xl:pl-0"
              >
                <h3 className="px-2 text-xs font-medium text-muted-foreground">
                  Paths a run can take
                </h3>
                <MermaidDiagram source={diagram} shown={diagramText} />
              </section>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

// The gate before a step, then the step. The gate is stored on the step before it, and so is
// its condition.
function StepPosition({
  draft,
  index,
  alwaysStop,
  onToggleGate,
  onTogglePart,
  children,
}: {
  draft: WorkflowDraft;
  index: number;
  alwaysStop: readonly string[];
  onToggleGate(): void;
  onTogglePart(stepIndex: number, part: GatePart): void;
  children: ReactNode;
}) {
  return (
    <>
      <GateDivider
        on={waitsAt(draft, index)}
        label={
          index === 0 ? 'Gate before step 1' : `Gate between step ${index} and step ${index + 1}`
        }
        onToggle={onToggleGate}
      >
        {index > 0 && (
          <GateConditionEditor
            step={draft.steps[index - 1]}
            number={index}
            alwaysStop={alwaysStop}
            onToggle={(part) => onTogglePart(index - 1, part)}
          />
        )}
      </GateDivider>
      {children}
    </>
  );
}

// The builder for a new workflow, blank or from a template (`?template=<kind>`).
export function NewWorkflowView({ template }: { template: string | undefined }) {
  const instances = useTopic('providerInstances');
  const templates = useSetting('workflows.templates');
  if (!instances) return null;
  const chosen = templates.find((candidate) => candidate.kind === template);
  const initial = chosen ? draftFromTemplate(chosen, preferredInstance(instances), '') : emptyDraft;
  return (
    <Builder key={template ?? ''} workflow={undefined} initial={initial} instances={instances} />
  );
}

export function EditWorkflowView({ workflowId }: { workflowId: string }) {
  const instances = useTopic('providerInstances');
  const workflows = useTopic('workflows');
  if (!instances || !workflows) return null;
  const workflow = workflows.find((candidate) => candidate.id === workflowId);
  if (!workflow) {
    return (
      <EmptyState
        icon={SearchXIcon}
        title="Workflow not found"
        description="It may have been deleted."
        action={
          <Button asChild size="sm" variant="outline">
            <Link to="/workflows">Back to the workflows</Link>
          </Button>
        }
      />
    );
  }
  return (
    <Builder
      key={workflow.id}
      workflow={workflow}
      initial={draftOf(workflow)}
      instances={instances}
    />
  );
}
