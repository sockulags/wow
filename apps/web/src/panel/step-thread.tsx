import type { Workflow, WorkflowRun } from '@wow/contracts';
import { Link } from '@tanstack/react-router';
import { ExternalLinkIcon, HourglassIcon } from 'lucide-react';
import { useTopic } from '@/chat/data';
import { ThreadConversation } from '@/chat/thread-view';
import { WithTooltip } from '@/components/hint';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { GateBar } from '@/workflows/gate-bar';
import {
  attemptLabel,
  gateOf,
  stepDisplayState,
  stepStateDotClass,
  stepStateLabels,
} from '@/workflows/model';
import { activeStep } from './model';

// The live thread of a run's active step, next to the calendar or the run view (owner decisions
// F-1, F-2): its conversation, the gate's Approve, Send back and Stop, and the composer for the step.
export function RunStepThread({
  run,
  workflow,
}: {
  readonly run: WorkflowRun;
  readonly workflow: Workflow | undefined;
}) {
  const threads = useTopic('threads');
  const instances = useTopic('providerInstances') ?? [];
  const projects = useTopic('projects') ?? [];
  const active = activeStep(run);
  if (!active) return null;
  const stepRun = run.steps[active.index];
  const step = workflow?.steps[active.index];
  const thread =
    active.threadId === undefined
      ? undefined
      : threads?.find((candidate) => candidate.id === active.threadId);
  const instance = thread
    ? instances.find((candidate) => candidate.id === thread.providerInstanceId)
    : undefined;
  const shownState = stepRun ? stepDisplayState(stepRun) : 'not_started';
  const gate = gateOf(run);
  const attempt = attemptLabel(stepRun);

  return (
    <section
      aria-label="Step thread"
      data-testid="panel-step-thread"
      className="flex min-h-0 flex-1 flex-col border-t border-border"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 px-4">
        <span
          aria-hidden
          className={cn('size-1.5 shrink-0 rounded-full', stepStateDotClass[shownState])}
        />
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="font-medium">
            Step {active.index + 1} of {run.steps.length}
          </span>
          {step && <span className="text-muted-foreground"> · {step.skillName}</span>}
          {attempt && <span className="text-muted-foreground"> · {attempt}</span>}
        </span>
        <span className="shrink-0 text-2xs text-muted-foreground">
          {stepStateLabels[shownState]}
        </span>
        {thread && (
          <WithTooltip label="Open thread">
            <Button asChild size="icon-xs" variant="ghost" aria-label="Open thread">
              <Link to="/chat/$threadId" params={{ threadId: thread.id }}>
                <ExternalLinkIcon />
              </Link>
            </Button>
          </WithTooltip>
        )}
      </div>
      {thread ? (
        <ThreadConversation key={thread.id} thread={thread} instance={instance} compact />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
          <EmptyState
            compact
            icon={HourglassIcon}
            title="This step has not started"
            description={
              gate
                ? 'The run waits for you before this step. Approve starts it.'
                : 'Its thread appears here as soon as the step starts.'
            }
          />
          {gate && (
            <GateBar
              run={run}
              workflow={workflow}
              project={projects.find((candidate) => candidate.id === run.projectId)}
              review={false}
            />
          )}
          <Button asChild size="xs" variant="ghost" className="self-center">
            <Link to="/workflows/runs/$runId" params={{ runId: run.id }}>
              Open run
            </Link>
          </Button>
        </div>
      )}
    </section>
  );
}
