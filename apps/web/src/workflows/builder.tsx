import type { ProviderInstance, Skill, Workflow } from '@wow/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  GripVerticalIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useRuntime, useSetting } from '@/app/runtime';
import { errorMessage, useDispatch, useModels, useTopic } from '@/chat/data';
import { ThreadSettings } from '@/chat/thread-settings';
import { ChoiceSelect } from '@/components/choice-select';
import { Combobox } from '@/components/combobox';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  applyStepChanges,
  blocking,
  draftFromTemplate,
  draftOf,
  emptyDraft,
  moveStep,
  newStep,
  runStateDotClass,
  runStateLabels,
  sameJson,
  skillKnown,
  sortRuns,
  stepDefaults,
  stepsOf,
  validateDraft,
  type DraftProblem,
  type DraftStep,
  type WorkflowDraft,
} from './model';

const textareaClass =
  'w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30';

// The value a step stores for a skill: its name, or plugin:name for a Claude plugin's skill.
const skillValue = (skill: Skill): string => skill.invocations.claude.replace(/^\//, '');

function skillChoices(skills: readonly Skill[]): Skill[] {
  const seen = new Set<string>();
  return skills
    .toSorted((a, b) => skillValue(a).localeCompare(skillValue(b)))
    .filter((skill) => {
      const value = skillValue(skill);
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
      {label}
      {children}
    </label>
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

interface StepEditorProps {
  readonly step: DraftStep;
  readonly index: number;
  readonly count: number;
  readonly instances: readonly ProviderInstance[];
  readonly skills: readonly Skill[];
  readonly problems: readonly DraftProblem[];
  readonly dragging: boolean;
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
  count,
  instances,
  skills,
  problems,
  dragging,
  onChange,
  onRemove,
  onMove,
  onDragStart,
  onDragEnd,
  onDrop,
}: StepEditorProps) {
  const instance = instances.find((candidate) => candidate.id === step.providerInstanceId);
  const change = useCallback(
    (changes: Partial<DraftStep>) => onChange(step.id, changes),
    [onChange, step.id],
  );
  useStepDefaults(step, instance, change);
  const choices = skillChoices(skills);
  const known = skillKnown(step.skillName, skills);
  const selected = choices.find((skill) => skillValue(skill) === step.skillName);
  const label = `Step ${index + 1}`;
  return (
    <li
      aria-label={label}
      data-testid="workflow-step"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(index);
      }}
      className={cn(
        'flex flex-col gap-2 rounded-md border border-border bg-card p-3',
        dragging && 'opacity-50',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          draggable
          aria-hidden
          title="Drag to reorder"
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
        <span className="text-xs font-medium">{label}</span>
        <Combobox
          label={`${label} skill`}
          size="sm"
          className="min-w-48"
          value={step.skillName}
          placeholder="Pick a skill…"
          searchPlaceholder="Search skills…"
          emptyText="No matching skill."
          choices={[
            ...(step.skillName !== '' && !known
              ? [{ value: step.skillName, label: `${step.skillName} (not found)` }]
              : []),
            ...choices.map((skill) => ({
              value: skillValue(skill),
              label: `${skillValue(skill)}${skill.manualOnly ? ' (manual only)' : ''}`,
            })),
          ]}
          onValueChange={(skillName) => change({ skillName })}
        />
        <div className="ml-auto flex items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={`Move ${label.toLowerCase()} up`}
            disabled={index === 0}
            onClick={() => onMove(index, index - 1)}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={`Move ${label.toLowerCase()} down`}
            disabled={index === count - 1}
            onClick={() => onMove(index, index + 1)}
          >
            <ArrowDownIcon />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={`Remove ${label.toLowerCase()}`}
            onClick={() => onRemove(step.id)}
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>
      {selected && selected.description !== '' && (
        <p className="pl-6 text-xs text-muted-foreground">{selected.description}</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 pl-6">
        <ChoiceSelect
          label={`${label} provider instance`}
          size="sm"
          className="w-auto data-[size=sm]:h-7"
          value={step.providerInstanceId}
          placeholder="Pick a provider…"
          choices={instances.map((candidate) => ({
            value: candidate.id,
            label: `${candidate.name} (${candidate.kind})`,
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
      <div className="flex flex-wrap items-center gap-4 pl-6 text-xs">
        <label className="flex items-center gap-1.5">
          <Checkbox
            checked={step.gateBefore}
            onCheckedChange={(checked) => change({ gateBefore: checked === true })}
            aria-label={`${label} gate before`}
          />
          Gate before
        </label>
        <label className="flex items-center gap-1.5">
          <Checkbox
            checked={step.gateAfter}
            onCheckedChange={(checked) => change({ gateAfter: checked === true })}
            aria-label={`${label} gate after`}
          />
          Gate after
        </label>
      </div>
      <div className="grid gap-2 pl-6 md:grid-cols-2">
        <Field label="Extra prompt">
          <textarea
            aria-label={`${label} extra prompt`}
            rows={2}
            className={textareaClass}
            value={step.extraPrompt ?? ''}
            placeholder="Added after the skill invocation"
            onChange={(event) => change({ extraPrompt: event.target.value })}
          />
        </Field>
        <Field label="Expected artifacts (one glob per line)">
          <textarea
            aria-label={`${label} expected artifacts`}
            rows={2}
            className={cn(textareaClass, 'font-mono')}
            value={step.artifactsText}
            placeholder="intents/*/spec.md"
            onChange={(event) => change({ artifactsText: event.target.value })}
          />
        </Field>
      </div>
      {problems.length > 0 && (
        <div className="pl-6">
          <Problems problems={problems} />
        </div>
      )}
    </li>
  );
}

function RunPanel({ workflow, runnable }: { workflow: Workflow; runnable: boolean }) {
  const send = useDispatch();
  const navigate = useNavigate();
  const projects = useTopic('projects') ?? [];
  const runs = (useTopic('workflowRuns') ?? []).filter((run) => run.workflowId === workflow.id);
  const [projectId, setProjectId] = useState<string>('');
  const [error, setError] = useState<string>();
  const project = projects.find((candidate) => candidate.id === projectId) ?? projects[0];

  const start = async () => {
    if (!project) return;
    setError(undefined);
    const runId = globalThis.crypto.randomUUID();
    try {
      await send({
        type: 'workflowRun.start',
        runId,
        workflowId: workflow.id,
        projectId: project.id,
      });
      await navigate({ to: '/workflows/runs/$runId', params: { runId } });
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return (
    <section aria-label="Run" className="flex flex-col gap-2 border-t border-border px-4 py-3">
      <h3 className="text-xs font-medium">Run</h3>
      <div className="flex flex-wrap items-center gap-2">
        <ChoiceSelect
          label="Run in project"
          size="sm"
          className="w-auto min-w-40"
          value={project?.id ?? ''}
          placeholder="No projects"
          disabled={projects.length === 0}
          choices={projects.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
          onValueChange={setProjectId}
        />
        <Button size="sm" disabled={!project || !runnable} onClick={() => void start()}>
          <PlayIcon />
          Run now
        </Button>
        {!runnable && (
          <span className="text-xs text-muted-foreground">Save the changes to run them.</span>
        )}
        {error && (
          <span role="alert" className="text-xs text-destructive">
            {error}
          </span>
        )}
      </div>
      {runs.length > 0 && (
        <ul aria-label="Runs of this workflow" className="flex flex-col gap-0.5">
          {sortRuns(runs).map((run) => (
            <li key={run.id}>
              <Link
                to="/workflows/runs/$runId"
                params={{ runId: run.id }}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent"
              >
                <span
                  aria-hidden
                  className={cn('size-1.5 rounded-full', runStateDotClass[run.state])}
                />
                <span>{runStateLabels[run.state]}</span>
                <span className="text-muted-foreground">
                  {projects.find((candidate) => candidate.id === run.projectId)?.name ??
                    run.projectId}{' '}
                  · {new Date(run.startedAt).toLocaleString()}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
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
  const { connection } = useRuntime();
  const send = useDispatch();
  const navigate = useNavigate();
  const skills = useTopic('skills') ?? [];
  const templates = useSetting('workflows.templates');
  const [draft, setDraft] = useState<WorkflowDraft>(initial);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragIndex, setDragIndex] = useState<number>();
  const [refreshing, setRefreshing] = useState(false);

  const problems = validateDraft(draft, instances, skills);
  const shown = attempted ? problems : problems.filter((problem) => problem.warning);
  const steps = stepsOf(draft);
  const dirty =
    !workflow ||
    workflow.name !== draft.name.trim() ||
    workflow.templateKind !== draft.templateKind ||
    !sameJson(workflow.steps, steps);
  const firstInstance = instances[0]?.id ?? '';

  const [changeStep] = useState(
    () => (stepId: string, changes: Partial<DraftStep>) =>
      setDraft((current) => ({
        ...current,
        steps: current.steps.map((step) =>
          step.id === stepId ? applyStepChanges(step, changes) : step,
        ),
      })),
  );

  const move = (from: number, to: number) =>
    setDraft((current) => ({ ...current, steps: moveStep(current.steps, from, to) }));

  const save = async () => {
    setAttempted(true);
    setError(undefined);
    if (blocking(problems).length > 0) return;
    setSaving(true);
    try {
      if (workflow) {
        await send({
          type: 'workflow.update',
          workflowId: workflow.id,
          name: draft.name.trim(),
          templateKind: draft.templateKind,
          steps,
        });
      } else {
        const workflowId = globalThis.crypto.randomUUID();
        await send({
          type: 'workflow.create',
          workflowId,
          name: draft.name.trim(),
          ...(draft.templateKind === null ? {} : { templateKind: draft.templateKind }),
          steps,
        });
        await navigate({ to: '/workflows/$workflowId', params: { workflowId } });
      }
      setAttempted(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!workflow) return;
    try {
      await send({ type: 'workflow.delete', workflowId: workflow.id });
      await navigate({ to: '/workflows' });
    } catch (failure) {
      setError(errorMessage(failure));
      setConfirmDelete(false);
    }
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
        <header className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">{workflow ? 'Edit workflow' : 'New workflow'}</h2>
            <div className="ml-auto flex items-center gap-1">
              {workflow &&
                (confirmDelete ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => void remove()}
                    >
                      Delete {workflow.name}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmDelete(false)}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2Icon />
                    Delete
                  </Button>
                ))}
              <Button type="submit" size="sm" disabled={saving || !dirty}>
                {workflow ? 'Save' : 'Create workflow'}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Name">
              <Input
                aria-label="Workflow name"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                className="h-8 w-64"
              />
            </Field>
            <Field label="Template kind">
              <ChoiceSelect
                label="Template kind"
                size="sm"
                className="w-auto min-w-32"
                value={draft.templateKind ?? ''}
                choices={[
                  { value: '', label: 'None' },
                  ...(draft.templateKind !== null &&
                  !templates.some((template) => template.kind === draft.templateKind)
                    ? [{ value: draft.templateKind, label: draft.templateKind }]
                    : []),
                  ...templates.map((template) => ({ value: template.kind, label: template.name })),
                ]}
                onValueChange={(kind) =>
                  setDraft({ ...draft, templateKind: kind === '' ? null : kind })
                }
              />
            </Field>
            <div
              role="group"
              aria-label="Start from template"
              className="flex items-center gap-1 pb-0.5"
            >
              <span className="text-[11px] text-muted-foreground">Start from</span>
              {templates.map((template) => (
                <Button
                  key={template.kind}
                  type="button"
                  size="sm"
                  variant="outline"
                  title={template.steps.map((step) => step.skillName).join(' → ')}
                  onClick={() =>
                    setDraft(draftFromTemplate(template, firstInstance, workflow ? draft.name : ''))
                  }
                >
                  {template.name}
                </Button>
              ))}
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto"
              disabled={!connection || refreshing}
              onClick={() => void refreshSkills()}
            >
              <RefreshCwIcon className={cn(refreshing && 'animate-spin')} />
              Refresh skills
            </Button>
          </div>
          <Problems problems={shown.filter((problem) => problem.stepId === undefined)} />
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <ol aria-label="Steps" className="flex flex-col gap-2">
            {draft.steps.map((step, index) => (
              <StepEditor
                key={step.id}
                step={step}
                index={index}
                count={draft.steps.length}
                instances={instances}
                skills={skills}
                problems={shown.filter((problem) => problem.stepId === step.id)}
                dragging={dragIndex === index}
                onChange={changeStep}
                onRemove={(stepId) =>
                  setDraft((current) => ({
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
            ))}
          </ol>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() =>
              setDraft((current) => ({
                ...current,
                steps: [...current.steps, newStep(firstInstance)],
              }))
            }
          >
            <PlusIcon />
            Add step
          </Button>
        </div>
      </form>
      {workflow && <RunPanel workflow={workflow} runnable={!dirty} />}
    </div>
  );
}

// The builder for a new workflow, blank or from a template (`?template=<kind>`).
export function NewWorkflowView({ template }: { template: string | undefined }) {
  const instances = useTopic('providerInstances');
  const templates = useSetting('workflows.templates');
  if (!instances) return null;
  const chosen = templates.find((candidate) => candidate.kind === template);
  const initial = chosen ? draftFromTemplate(chosen, instances[0]?.id ?? '', '') : emptyDraft;
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
      <section className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <h2 className="text-sm font-medium">Workflow not found</h2>
        <Link to="/workflows" className="text-xs text-muted-foreground underline">
          Back to the workflows
        </Link>
      </section>
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
