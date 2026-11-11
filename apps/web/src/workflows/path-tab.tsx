import type { Workflow, WorkflowRun } from '@wow/contracts';
import { Link } from '@tanstack/react-router';
import { MessageSquareIcon, RouteIcon } from 'lucide-react';
import { EmptyState } from '@/components/states';
import { formatDuration, useDateFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { pathRows, visitStateDotClass, visitStateLabels } from './path';

// The Path tab (workflow branches spec 18): the step visits of the run in the order they
// happened. A step that ran three times has three rows here and one row under Steps.
export function PathTab({
  run,
  workflow,
}: {
  readonly run: WorkflowRun;
  readonly workflow: Workflow | undefined;
}) {
  const { when } = useDateFormat();
  const rows = pathRows(run, workflow);
  if (rows === undefined) {
    return (
      <EmptyState
        icon={RouteIcon}
        title="No path kept"
        description="This run started before wow kept the path of a run. Its steps are under Steps."
      />
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={RouteIcon}
        title="No step has started yet"
        description="Every start of a step shows here, with why the run went where it went next."
      />
    );
  }
  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      <ol aria-label="Run path" className="flex flex-col gap-2">
        {rows.map((row) => (
          <li
            key={row.number}
            aria-label={`Visit ${row.number}: ${row.stepName}, attempt ${row.attempt}`}
            data-testid="path-visit"
            data-state={row.state}
            className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3"
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn('size-2 shrink-0 rounded-full', visitStateDotClass[row.state])}
              />
              <span className="text-xs text-muted-foreground tabular-nums">{row.number}.</span>
              <span data-testid="path-step" className="text-sm font-medium">
                {row.stepName}
              </span>
              <span data-testid="path-attempt" className="text-xs text-muted-foreground">
                attempt {row.attempt}
              </span>
              <span data-testid="path-state" className="ml-auto text-xs">
                {visitStateLabels[row.state]}
              </span>
            </div>
            {row.why !== undefined && (
              <p data-testid="path-why" className="pl-4 text-xs">
                {row.why}
              </p>
            )}
            {row.limit !== undefined && (
              <p data-testid="path-limit" className="pl-4 text-xs text-muted-foreground">
                {row.limit}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-4 text-xs text-muted-foreground">
              {row.stepNumber !== undefined && <span>Step {row.stepNumber}</span>}
              <span>Started {when(row.startedAt)}</span>
              {row.durationMs !== undefined && (
                <span className="tabular-nums">Took {formatDuration(row.durationMs)}</span>
              )}
              {row.threadId && (
                <Link
                  to="/chat/$threadId"
                  params={{ threadId: row.threadId }}
                  className="inline-flex items-center gap-1 rounded-sm text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <MessageSquareIcon className="size-3.5" aria-hidden />
                  Open thread
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
