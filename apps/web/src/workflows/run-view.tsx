import type { Project, StepRun, WorkflowStep } from '@wow/contracts';
import { Link } from '@tanstack/react-router';
import {
  CalendarIcon,
  HourglassIcon,
  ListTodoIcon,
  MessageSquareIcon,
  SearchXIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRuntime } from '@/app/runtime';
import { useTopic } from '@/chat/data';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { isoDate, localDate } from '@/calendar/time';
import { formatDuration, useDateFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Artifact } from './artifact-link';
import { GateBar } from './gate-bar';
import {
  gateOf,
  runStateDotClass,
  runStateLabels,
  stepDisplayState,
  stepDurationMs,
  stepStateDotClass,
  stepStateLabels,
} from './model';

function StepRow({
  index,
  step,
  stepRun,
  project,
  instanceName,
  waitsAfter,
}: {
  index: number;
  step: WorkflowStep | undefined;
  stepRun: StepRun;
  project: Project | undefined;
  instanceName: string | undefined;
  // The run waits for the user right after this step.
  waitsAfter: boolean;
}) {
  const { when } = useDateFormat();
  const name = step?.skillName ?? stepRun.stepId;
  const state = stepDisplayState(stepRun);
  const duration = stepDurationMs(stepRun);
  return (
    <>
      <li
        aria-label={`Step ${index + 1}: ${name}`}
        data-testid="run-step"
        className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3"
      >
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={cn('size-2 shrink-0 rounded-full', stepStateDotClass[state])}
          />
          <span className="text-xs text-muted-foreground tabular-nums">{index + 1}.</span>
          <span className="text-sm font-medium">{name}</span>
          <span data-testid="step-state" className="ml-auto text-xs">
            {stepStateLabels[state]}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-4 text-xs text-muted-foreground">
          {instanceName && (
            <span>
              {instanceName}
              {step?.model ? ` · ${step.model}` : ''}
            </span>
          )}
          {stepRun.startedAt && <span>Started {when(stepRun.startedAt)}</span>}
          {duration !== undefined && (
            <span className="tabular-nums">Took {formatDuration(duration)}</span>
          )}
          {stepRun.threadId && (
            <Link
              to="/chat/$threadId"
              params={{ threadId: stepRun.threadId }}
              className="inline-flex items-center gap-1 rounded-sm text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MessageSquareIcon className="size-3.5" aria-hidden />
              Open thread
            </Link>
          )}
        </div>
        {stepRun.error && (
          <p role="alert" className="pl-4 text-xs text-destructive">
            {stepRun.error}
          </p>
        )}
        {step && step.expectedArtifacts.length > 0 && (
          <div className="pl-4 text-xs">
            <span className="text-muted-foreground">
              Expected: <span className="font-mono">{step.expectedArtifacts.join(', ')}</span>
            </span>
            {stepRun.artifactsFound.length > 0 && project ? (
              <ul aria-label={`Artifacts of ${name}`} className="mt-1 flex flex-col gap-0.5">
                {stepRun.artifactsFound.map((path) => (
                  <Artifact key={path} cwd={project.cwd} path={path} />
                ))}
              </ul>
            ) : (
              <span className="ml-2 text-muted-foreground">none found yet</span>
            )}
          </div>
        )}
      </li>
      {waitsAfter && (
        <li
          aria-label="Waiting for you"
          data-testid="gate-marker"
          className="flex items-center gap-2 px-3 text-xs font-medium"
        >
          <HourglassIcon aria-hidden className="size-3.5 text-state-needs-you" />
          Waiting for you
          <span
            aria-hidden
            className="h-px flex-1 border-t border-dashed border-state-needs-you/60"
          />
        </li>
      )}
    </>
  );
}

// Behavior 26: every step's state, its thread and the expected artifacts found in the project.
export function RunView({ runId }: { runId: string }) {
  const { connection } = useRuntime();
  const runs = useTopic('workflowRuns');
  const workflows = useTopic('workflows') ?? [];
  const projects = useTopic('projects') ?? [];
  const instances = useTopic('providerInstances') ?? [];
  const cards = useTopic('calendarItems') ?? [];
  const backlog = useTopic('backlogItems') ?? [];
  const { when, zone } = useDateFormat();
  const [error, setError] = useState<string>();

  // Artifacts may have appeared since the step ended; the server looks again and stores them.
  useEffect(() => {
    if (!connection) return;
    connection.request('workflowRuns.detectArtifacts', { runId }).catch(() => {});
  }, [connection, runId]);

  if (!runs) return null;
  const run = runs.find((candidate) => candidate.id === runId);
  if (!run) {
    return (
      <EmptyState
        icon={SearchXIcon}
        title="Run not found"
        description="It may belong to a workflow that was deleted."
        action={
          <Button asChild size="sm" variant="outline">
            <Link to="/workflows">Back to the workflows</Link>
          </Button>
        }
      />
    );
  }
  const workflow = workflows.find((candidate) => candidate.id === run.workflowId);
  const project = projects.find((candidate) => candidate.id === run.projectId);
  const card = cards.find((candidate) => candidate.id === run.calendarItemId);
  const item = backlog.find((candidate) => candidate.id === run.backlogItemId);
  const gate = gateOf(run);
  const linkClass =
    'inline-flex items-center gap-1 rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden className={cn('size-2 rounded-full', runStateDotClass[run.state])} />
          <h2 className="min-w-0 truncate text-sm font-medium">
            {workflow ? (
              <Link
                to="/workflows/$workflowId"
                params={{ workflowId: workflow.id }}
                className={linkClass}
              >
                {workflow.name}
              </Link>
            ) : (
              'Workflow run'
            )}
          </h2>
          <span data-testid="run-state" className="shrink-0 text-xs text-muted-foreground">
            {runStateLabels[run.state]}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span data-testid="run-context">
            {project?.name ?? run.projectId} · started {when(run.startedAt)}
            {run.endedAt ? ` · ended ${when(run.endedAt)}` : ''}
          </span>
          {card && (
            <Link
              to="/calendar"
              search={{ view: 'day', date: isoDate(localDate(new Date(card.start), zone)) }}
              className={linkClass}
            >
              <CalendarIcon aria-hidden className="size-3.5" />
              {card.title || 'Card'}
            </Link>
          )}
          {item && (
            <Link to="/backlog/$itemId" params={{ itemId: item.id }} className={linkClass}>
              <ListTodoIcon aria-hidden className="size-3.5" />
              {item.title}
            </Link>
          )}
        </div>
        <GateBar run={run} workflow={workflow} project={project} onError={setError} />
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <ol aria-label="Run steps" className="flex flex-col gap-2">
          {run.steps.map((stepRun, index) => {
            const step = workflow?.steps.find((candidate) => candidate.id === stepRun.stepId);
            return (
              <StepRow
                key={stepRun.stepId}
                index={index}
                step={step}
                stepRun={stepRun}
                project={project}
                instanceName={
                  instances.find((candidate) => candidate.id === step?.providerInstanceId)?.name
                }
                waitsAfter={
                  gate !== undefined &&
                  (gate.position === 'after'
                    ? gate.stepIndex === index
                    : gate.stepIndex - 1 === index)
                }
              />
            );
          })}
        </ol>
      </div>
    </div>
  );
}
