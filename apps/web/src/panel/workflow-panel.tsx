import { Link } from '@tanstack/react-router';
import { HandIcon, SearchXIcon } from 'lucide-react';
import { useTopic } from '@/chat/data';
import { EmptyState } from '@/components/states';
import { useDateFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { runStateDotClass, runStateLabel, sortRuns } from '@/workflows/model';
import { PanelSection, PanelTitle } from './details';
import { RunStepThread } from './step-thread';

// The run view's panel: the thread of the step the run is on (or waits after), live.
export function RunPanel({ runId }: { readonly runId: string }) {
  const runs = useTopic('workflowRuns');
  const threads = useTopic('threads') ?? [];
  const workflows = useTopic('workflows') ?? [];
  const projects = useTopic('projects') ?? [];
  const { when } = useDateFormat();
  if (runs === undefined) return null;
  const run = runs.find((candidate) => candidate.id === runId);
  if (!run) {
    return <EmptyState compact icon={SearchXIcon} title="Run not found" />;
  }
  const workflow = workflows.find((candidate) => candidate.id === run.workflowId);
  const project = projects.find((candidate) => candidate.id === run.projectId);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="panel-run">
      <div className="shrink-0 pb-4">
        <PanelTitle
          title={workflow?.name ?? 'Workflow run'}
          dot={runStateDotClass[run.state]}
          meta={`${runStateLabel(run, threads)} · ${project?.name ?? run.projectId} · ${when(run.startedAt)}`}
        />
      </div>
      <RunStepThread run={run} workflow={workflow} runOnScreen />
    </div>
  );
}

// The builder's panel: what the workflow does and how its runs went.
export function WorkflowPanel({ workflowId }: { readonly workflowId: string }) {
  const workflows = useTopic('workflows');
  const runs = useTopic('workflowRuns') ?? [];
  const threads = useTopic('threads') ?? [];
  const projects = useTopic('projects') ?? [];
  const { when } = useDateFormat();
  if (workflows === undefined) return null;
  const workflow = workflows.find((candidate) => candidate.id === workflowId);
  if (!workflow) return <EmptyState compact icon={SearchXIcon} title="Workflow not found" />;
  const own = sortRuns(runs.filter((run) => run.workflowId === workflow.id));
  const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? id;
  const gates = workflow.steps.filter((step) => step.gateBefore || step.gateAfter).length;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-4" data-testid="panel-workflow">
      <PanelTitle
        title={workflow.name}
        meta={`${workflow.steps.length} ${workflow.steps.length === 1 ? 'step' : 'steps'}${
          gates > 0 ? ` · waits for you ${gates === 1 ? 'once' : `${gates} times`}` : ''
        }`}
      />
      <PanelSection label="Steps">
        <ol className="flex flex-col gap-1 text-xs">
          {workflow.steps.map((step, index) => (
            <li key={step.id} className="flex flex-col gap-1">
              {step.gateBefore && <GateMarker />}
              <span className="flex min-w-0 items-center gap-2">
                <span className="w-4 shrink-0 text-right text-muted-foreground tabular-nums">
                  {index + 1}
                </span>
                <span className="min-w-0 truncate font-medium">{step.skillName}</span>
                {step.model && (
                  <span className="ml-auto shrink-0 truncate text-2xs text-muted-foreground">
                    {step.model}
                  </span>
                )}
              </span>
              {step.gateAfter && <GateMarker />}
            </li>
          ))}
        </ol>
      </PanelSection>
      <PanelSection label="Runs">
        {own.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No runs yet. Run now or a card on the calendar starts one.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {own.map((run) => (
              <li key={run.id}>
                <Link
                  to="/workflows/runs/$runId"
                  params={{ runId: run.id }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    aria-hidden
                    className={cn('size-1.5 shrink-0 rounded-full', runStateDotClass[run.state])}
                  />
                  <span className="min-w-0 flex-1 truncate">{projectName(run.projectId)}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {runStateLabel(run, threads)} · {when(run.startedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
    </div>
  );
}

function GateMarker() {
  return (
    <span className="flex items-center gap-2 pl-6 text-2xs text-warning">
      <HandIcon aria-hidden className="size-3" />
      Waits for you
    </span>
  );
}
