import { Link, Outlet } from '@tanstack/react-router';
import { PlusIcon, WorkflowIcon } from 'lucide-react';
import { useConnectionState, useSetting } from '@/app/runtime';
import { DisconnectedState, EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useTopic } from '@/chat/data';
import { useDateFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { runStateDotClass, runStateLabels, sortRuns } from './model';

function WorkflowList() {
  const workflows = useTopic('workflows') ?? [];
  const runs = useTopic('workflowRuns') ?? [];
  const projects = useTopic('projects') ?? [];
  const { when } = useDateFormat();
  const names = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const linkClass =
    'flex flex-col rounded-md px-2 py-1.5 text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring';
  const active = { className: 'bg-sidebar-accent', 'aria-current': 'page' as const };
  return (
    <nav
      aria-label="Workflows"
      className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar/50"
    >
      <div className="flex h-10 shrink-0 items-center px-2">
        <Button asChild variant="ghost" size="sm" className="w-full justify-start">
          <Link to="/workflows/new">
            <PlusIcon />
            New workflow
          </Link>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <section aria-label="Workflow definitions" className="mt-2">
          <h3 className="px-2 pb-1 text-2xs font-medium text-muted-foreground">
            Workflows<span className="ml-1 opacity-70">{workflows.length}</span>
          </h3>
          <ul className="flex flex-col gap-0.5">
            {workflows
              .toSorted((a, b) => a.name.localeCompare(b.name))
              .map((workflow) => (
                <li key={workflow.id}>
                  <Link
                    to="/workflows/$workflowId"
                    params={{ workflowId: workflow.id }}
                    className={linkClass}
                    activeProps={active}
                  >
                    <span className="truncate">{workflow.name}</span>
                    <span className="truncate text-2xs text-muted-foreground">
                      {workflow.steps.map((step) => step.skillName).join(' → ')}
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
        {runs.length > 0 && (
          <section aria-label="Runs" className="mt-3">
            <h3 className="px-2 pb-1 text-2xs font-medium text-muted-foreground">
              Runs<span className="ml-1 opacity-70">{runs.length}</span>
            </h3>
            <ul className="flex flex-col gap-0.5">
              {sortRuns(runs).map((run) => (
                <li key={run.id}>
                  <Link
                    to="/workflows/runs/$runId"
                    params={{ runId: run.id }}
                    className={linkClass}
                    activeProps={active}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className={cn(
                          'size-1.5 shrink-0 rounded-full',
                          runStateDotClass[run.state],
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {names.get(run.workflowId) ?? 'Workflow'}
                      </span>
                      <span className="shrink-0 text-2xs text-muted-foreground">
                        {runStateLabels[run.state]}
                      </span>
                    </span>
                    <span
                      data-testid="run-row-detail"
                      className="truncate pl-3.5 text-2xs text-muted-foreground tabular-nums"
                    >
                      {projectNames.get(run.projectId) ?? run.projectId} · {when(run.startedAt)}
                      {run.workingCopy?.state === 'kept' && ' · working copy kept'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </nav>
  );
}

export function WorkflowsLayout() {
  const { configured } = useConnectionState();
  if (!configured) return <DisconnectedState offline />;
  return (
    <div className="flex h-full min-h-0">
      <WorkflowList />
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

export function WorkflowsHome() {
  const workflows = useTopic('workflows');
  const templates = useSetting('workflows.templates');
  const any = workflows !== undefined && workflows.length > 0;
  return (
    <EmptyState
      icon={WorkflowIcon}
      title={any ? 'Pick a workflow' : 'No workflows yet'}
      description="A workflow is an ordered list of skills with gates where it waits for you."
      action={
        <Button asChild size="sm">
          <Link to="/workflows/new">
            <PlusIcon />
            New workflow
          </Link>
        </Button>
      }
      secondary={templates.map((template) => (
        <Button key={template.kind} asChild size="sm" variant="outline">
          <Link
            to="/workflows/new"
            search={{ template: template.kind }}
            className="whitespace-nowrap"
          >
            From {template.name}
          </Link>
        </Button>
      ))}
    />
  );
}
