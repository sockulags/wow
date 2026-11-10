import type { Project, Workflow, WorkflowRun } from '@wow/contracts';
import { ChevronRightIcon, PlayIcon, SquareIcon } from 'lucide-react';
import { useState } from 'react';
import { useSetting } from '@/app/runtime';
import { errorMessage, useDispatch } from '@/chat/data';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { WithTooltip } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Artifact } from './artifact-link';
import { gateMessage, gateOf, isLive, reviewedStep } from './model';

// Continue and Stop for a live run (behaviors 9 to 11). The run view shows it with what to review
// (the step's last message and the artifacts it produced); a step's thread shows it above its
// composer, where the thread itself is what to review.
export function GateBar({
  run,
  workflow,
  project,
  review = true,
  onError,
}: {
  run: WorkflowRun;
  workflow: Workflow | undefined;
  project?: Project | undefined;
  // Show the reviewed step's final message and artifacts inside the bar.
  review?: boolean;
  onError?(message: string | undefined): void;
}) {
  const send = useDispatch();
  const continueBinding = useSetting('keybindings.continueRun');
  const stopBinding = useSetting('keybindings.stopRun');
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState<string>();
  const gate = gateOf(run);
  if (!isLive(run)) return null;
  const reviewed = reviewedStep(run);
  const reportError = (message: string | undefined) => {
    setError(message);
    onError?.(message);
  };
  const act = async (type: 'workflowRun.continue' | 'workflowRun.stop') => {
    setBusy(true);
    reportError(undefined);
    try {
      await send({ type, runId: run.id });
    } catch (failure) {
      reportError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      role="region"
      aria-label={gate ? 'Gate' : 'Run controls'}
      aria-live="polite"
      className={cn(
        'flex flex-col gap-2 rounded-md border px-3 py-2 text-sm',
        gate ? 'border-state-needs-you/60 bg-state-needs-you/10' : 'border-border',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">
          {gate ? gateMessage(gate, workflow) : 'The run is working on its current step.'}
        </span>
        {gate && (
          <WithTooltip label="Continue run" binding={continueBinding}>
            <Button size="sm" disabled={busy} onClick={() => void act('workflowRun.continue')}>
              <PlayIcon />
              Continue
            </Button>
          </WithTooltip>
        )}
        <WithTooltip label="Stop run" binding={stopBinding}>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmStop(true)}>
            <SquareIcon className="size-3 fill-current" />
            Stop
          </Button>
        </WithTooltip>
      </div>
      {review && gate && reviewed?.finalMessage && (
        <details data-testid="gate-review" className="group text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground select-none">
            <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
            Last message from{' '}
            {workflow?.steps.find((step) => step.id === reviewed.stepId)?.skillName ?? 'the step'}
          </summary>
          <p className="mt-1 max-h-60 overflow-y-auto border-l border-border pl-3 whitespace-pre-wrap text-foreground">
            {reviewed.finalMessage}
          </p>
        </details>
      )}
      {review && gate && reviewed && reviewed.artifactsFound.length > 0 && project && (
        <ul aria-label="Artifacts to review" className="flex flex-col gap-0.5 text-xs">
          {reviewed.artifactsFound.map((path) => (
            <Artifact key={path} runId={run.id} cwd={project.cwd} path={path} />
          ))}
        </ul>
      )}
      {error && !onError && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirmStop}
        title={`Stop ${workflow?.name ?? 'this run'}?`}
        description="The current step is interrupted and no later step starts. A stopped run cannot be continued; its threads are kept."
        confirmLabel="Stop run"
        onCancel={() => setConfirmStop(false)}
        onConfirm={() => {
          setConfirmStop(false);
          void act('workflowRun.stop');
        }}
      />
    </div>
  );
}
