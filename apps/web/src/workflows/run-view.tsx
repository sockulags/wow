import type { Project, StepRun, Workflow, WorkflowRun, WorkflowStep } from '@wow/contracts';
import { Link } from '@tanstack/react-router';
import { CopyIcon, ExternalLinkIcon, MessageSquareIcon, PlayIcon, SquareIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRuntime } from '@/app/runtime';
import { errorMessage, useDispatch, useTopic } from '@/chat/data';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  artifactPath,
  artifactUrl,
  gateMessage,
  gateOf,
  isLive,
  runStateDotClass,
  runStateLabels,
  stepStateDotClass,
  stepStateLabels,
} from './model';

const time = (value: string | undefined | null) =>
  value ? new Date(value).toLocaleString() : undefined;

function Artifact({ cwd, path }: { cwd: string; path: string }) {
  const full = artifactPath(cwd, path);
  return (
    <li className="flex items-center gap-1.5">
      <a
        href={artifactUrl(cwd, path)}
        target="_blank"
        rel="noreferrer"
        title={full}
        className="inline-flex items-center gap-1 font-mono underline-offset-2 hover:underline"
      >
        <ExternalLinkIcon className="size-3" aria-hidden />
        <span>Open {path}</span>
      </a>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6"
        aria-label={`Copy path of ${path}`}
        onClick={() => void navigator.clipboard?.writeText(full).catch(() => {})}
      >
        <CopyIcon className="size-3" />
      </Button>
    </li>
  );
}

function StepRow({
  index,
  step,
  stepRun,
  project,
  instanceName,
}: {
  index: number;
  step: WorkflowStep | undefined;
  stepRun: StepRun;
  project: Project | undefined;
  instanceName: string | undefined;
}) {
  const name = step?.skillName ?? stepRun.stepId;
  return (
    <li
      aria-label={`Step ${index + 1}: ${name}`}
      data-testid="run-step"
      className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn('size-2 shrink-0 rounded-full', stepStateDotClass[stepRun.state])}
        />
        <span className="text-xs text-muted-foreground">{index + 1}.</span>
        <span className="text-sm font-medium">{name}</span>
        {step?.gateBefore && (
          <span className="rounded border border-border px-1 text-[10px] text-muted-foreground">
            gate before
          </span>
        )}
        {step?.gateAfter && (
          <span className="rounded border border-border px-1 text-[10px] text-muted-foreground">
            gate after
          </span>
        )}
        <span data-testid="step-state" className="ml-auto text-xs">
          {stepRunLabel(stepRun)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-4 text-xs text-muted-foreground">
        {instanceName && (
          <span>
            {instanceName}
            {step?.model ? ` · ${step.model}` : ''}
          </span>
        )}
        {stepRun.startedAt && <span>Started {time(stepRun.startedAt)}</span>}
        {stepRun.endedAt && <span>Ended {time(stepRun.endedAt)}</span>}
        {stepRun.threadId && (
          <Link
            to="/chat/$threadId"
            params={{ threadId: stepRun.threadId }}
            className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
          >
            <MessageSquareIcon className="size-3" aria-hidden />
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
  );
}

const stepRunLabel = (stepRun: StepRun) => stepStateLabels[stepRun.state];

function GateBar({
  run,
  workflow,
  onError,
}: {
  run: WorkflowRun;
  workflow: Workflow | undefined;
  onError(message: string | undefined): void;
}) {
  const send = useDispatch();
  const [busy, setBusy] = useState(false);
  const gate = gateOf(run);
  if (!isLive(run)) return null;
  const act = async (type: 'workflowRun.continue' | 'workflowRun.stop') => {
    setBusy(true);
    onError(undefined);
    try {
      await send({ type, runId: run.id });
    } catch (failure) {
      onError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      role="region"
      aria-label={gate ? 'Gate' : 'Run controls'}
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm',
        gate ? 'border-state-needs-you/60 bg-state-needs-you/10' : 'border-border',
      )}
    >
      <span className="min-w-0 flex-1">
        {gate ? gateMessage(gate, workflow) : 'The run is working on its current step.'}
      </span>
      {gate && (
        <Button size="sm" disabled={busy} onClick={() => void act('workflowRun.continue')}>
          <PlayIcon />
          Continue
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void act('workflowRun.stop')}
      >
        <SquareIcon />
        Stop
      </Button>
    </div>
  );
}

// Behavior 26: every step's state, its thread and the expected artifacts found in the project.
export function RunView({ runId }: { runId: string }) {
  const { connection } = useRuntime();
  const runs = useTopic('workflowRuns');
  const workflows = useTopic('workflows') ?? [];
  const projects = useTopic('projects') ?? [];
  const instances = useTopic('providerInstances') ?? [];
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
      <section className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <h2 className="text-sm font-medium">Run not found</h2>
        <Link to="/workflows" className="text-xs text-muted-foreground underline">
          Back to the workflows
        </Link>
      </section>
    );
  }
  const workflow = workflows.find((candidate) => candidate.id === run.workflowId);
  const project = projects.find((candidate) => candidate.id === run.projectId);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <span aria-hidden className={cn('size-2 rounded-full', runStateDotClass[run.state])} />
          <h2 className="min-w-0 truncate text-sm font-medium">
            {workflow ? (
              <Link
                to="/workflows/$workflowId"
                params={{ workflowId: workflow.id }}
                className="underline-offset-2 hover:underline"
              >
                {workflow.name}
              </Link>
            ) : (
              'Workflow run'
            )}
          </h2>
          <span data-testid="run-state" className="text-xs text-muted-foreground">
            {runStateLabels[run.state]}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {project?.name ?? run.projectId} · started {time(run.startedAt)}
            {run.endedAt ? ` · ended ${time(run.endedAt)}` : ''}
          </span>
        </div>
        <GateBar run={run} workflow={workflow} onError={setError} />
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
              />
            );
          })}
        </ol>
      </div>
    </div>
  );
}
