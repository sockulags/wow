import {
  gatePartLabels,
  runFolder,
  type GatePartResult,
  type Project,
  type Workflow,
  type WorkflowRun,
} from '@wow/contracts';
import {
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  RepeatIcon,
  SquareIcon,
  Undo2Icon,
  XIcon,
} from 'lucide-react';
import { useId, useState } from 'react';
import { useStore } from 'zustand';
import { useSetting } from '@/app/runtime';
import { errorMessage, useDispatch } from '@/chat/data';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { WithTooltip } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { Artifact } from './artifact-link';
import {
  cancelSendBack,
  canSendBack,
  confirmSendBack,
  gateStore,
  openSendBack,
  sendBackDraft,
  setSendBackNote,
} from './gate';
import { gateMessage, gateOf, gateStanding, isLive, reviewedStep } from './model';

const partIcons = {
  held: <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-state-done" />,
  failed: <XIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />,
  pending: (
    <CircleDashedIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
  ),
};

const partStates: Readonly<Record<GatePartResult['state'], string>> = {
  held: 'holds',
  failed: 'does not hold',
  pending: 'not decided',
};

// The answers at a gate (review loop spec 15 to 18): Approve lets the run continue, Send back
// opens a note field in place and runs the reviewed step again with the note, Stop ends the run.
// The run view shows it with what to review (the step's last message and the artifacts it
// produced); a step's thread shows it above its composer, where the thread itself is what to
// review. A gate with a condition that did not pass by itself says which part failed, or that
// it waits for the pull request's checks (spec 55, 56). At the limit of a loop the bar says the
// limit sentence, and the answers are "Run once more" and Stop (workflow branches spec 9).
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
  const approveBinding = useSetting('keybindings.gateApprove');
  const sendBackBinding = useSetting('keybindings.gateSendBack');
  const stopBinding = useSetting('keybindings.stopRun');
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState<string>();
  const noteId = useId();
  const draft = useStore(gateStore, (state) => sendBackDraft(state, run));
  const gate = gateOf(run);
  if (!isLive(run)) return null;
  const reviewed = reviewedStep(run);
  const atLimit = gate?.limit !== undefined;
  const standing = gateStanding(run);
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
      data-limit={atLimit ? '' : undefined}
      aria-live="polite"
      className={cn(
        'flex flex-col gap-2 rounded-md border px-3 py-2 text-sm',
        gate ? 'border-state-needs-you/60 bg-state-needs-you/10' : 'border-border',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-56 flex-1">
          {gate ? gateMessage(gate, workflow) : 'The run is working on its current step.'}
        </span>
        {gate && (
          <WithTooltip
            label={atLimit ? 'Let the step run once more' : 'Approve and continue'}
            binding={draft ? '' : approveBinding}
          >
            <Button
              size="sm"
              disabled={busy || draft !== undefined}
              onClick={() => void act('workflowRun.continue')}
            >
              {atLimit ? <RepeatIcon /> : <CheckIcon />}
              {atLimit ? 'Run once more' : 'Approve'}
            </Button>
          </WithTooltip>
        )}
        {canSendBack(run) && (
          <WithTooltip label="Send back with a note" binding={draft ? '' : sendBackBinding}>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              aria-expanded={draft !== undefined}
              aria-controls={draft ? noteId : undefined}
              onClick={() => (draft ? cancelSendBack() : openSendBack(run))}
            >
              <Undo2Icon />
              Send back
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
      {standing && (
        <div data-testid="gate-condition" className="flex flex-col gap-1 text-xs">
          <p className="font-medium">
            {standing.waitsFor === 'checks'
              ? 'Waiting for checks. The gate passes by itself when they are successful; Approve passes it now.'
              : `Did not pass by itself: ${standing.failed.join(', ')}.`}
          </p>
          <ul aria-label="Gate condition" className="flex flex-col gap-0.5">
            {standing.parts.map((part) => (
              <li key={part.part} data-state={part.state} className="flex items-start gap-1.5">
                {partIcons[part.state]}
                <span>
                  <span className="font-medium">{gatePartLabels[part.part]}</span>
                  <span className="sr-only"> ({partStates[part.state]})</span>
                  <span className="text-muted-foreground">: {part.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {draft && (
        <form
          aria-label="Send back"
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void confirmSendBack(send);
          }}
        >
          <Label htmlFor={noteId} className="text-xs">
            What should change?
          </Label>
          <Textarea
            id={noteId}
            autoFocus
            rows={3}
            value={draft.note}
            disabled={draft.busy}
            aria-invalid={draft.error !== undefined}
            aria-describedby={draft.error ? `${noteId}-error` : undefined}
            placeholder={`A note for ${
              workflow?.steps.find((step) => step.id === reviewed?.stepId)?.skillName ?? 'the step'
            }. It runs again in the same thread.`}
            className="text-xs"
            onChange={(event) => setSendBackNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              cancelSendBack();
            }}
          />
          {draft.error && (
            <p id={`${noteId}-error`} role="alert" className="text-xs text-destructive">
              {draft.error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={draft.busy}
              onClick={cancelSendBack}
            >
              Cancel
            </Button>
            <WithTooltip label="Send the note and run the step again" binding={sendBackBinding}>
              <Button type="submit" size="xs" disabled={draft.busy}>
                Send it back
              </Button>
            </WithTooltip>
          </div>
        </form>
      )}
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
            <Artifact key={path} runId={run.id} cwd={runFolder(run, project.cwd)} path={path} />
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
