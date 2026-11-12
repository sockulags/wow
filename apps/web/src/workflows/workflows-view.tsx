import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { PlayIcon, PlusIcon, WorkflowIcon } from 'lucide-react';
import { useConnectionState, useSetting } from '@/app/runtime';
import { DisconnectedState, EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useTopic } from '@/chat/data';
import { useDateFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { WorkflowRun } from '@wow/contracts';
import { gateStanding, runStateDotClass, runStateLabel } from './model';
import { eventTriggers, triggersPath } from './triggers';

export const runsPath = '/workflows/runs';

// A run at a gate that waits for the pull request's checks is `waiting` too, but not for the user.
export const waitsForYou = (run: WorkflowRun): boolean =>
  run.state === 'waiting' && gateStanding(run)?.waitsFor !== 'checks';

// The Runs tab's order (agent workbench spec 79): runs waiting for the user first, then running
// ones and those waiting for checks, then the rest, newest first within each.
const liveRank = (run: WorkflowRun): number =>
  waitsForYou(run) ? 0 : run.state === 'running' || run.state === 'waiting' ? 1 : 2;

export const runsTabOrder = (runs: readonly WorkflowRun[]): WorkflowRun[] =>
  runs.toSorted((a, b) => liveRank(a) - liveRank(b) || b.startedAt.localeCompare(a.startedAt));

type ListTab = 'workflows' | 'runs' | 'triggers';

// Which tab of the list a path belongs to: a run open in the view keeps the Runs tab.
export function listTabOf(pathname: string): ListTab {
  if (pathname === triggersPath) return 'triggers';
  if (pathname === runsPath || pathname.startsWith(`${runsPath}/`)) return 'runs';
  return 'workflows';
}

function WorkflowList() {
  const workflows = useTopic('workflows') ?? [];
  const runs = useTopic('workflowRuns') ?? [];
  const threads = useTopic('threads') ?? [];
  const projects = useTopic('projects') ?? [];
  const triggerCount = eventTriggers(useTopic('triggers') ?? []).length;
  const tab = useRouterState({ select: (state) => listTabOf(state.location.pathname) });
  const { when } = useDateFormat();
  const names = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const linkClass =
    'flex flex-col rounded-md px-2 py-1.5 text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring';
  const active = { className: 'bg-sidebar-accent', 'aria-current': 'page' as const };
  const needYou = runs.filter(waitsForYou).length;
  const tabs: readonly { id: ListTab; to: string; label: string; count?: number }[] = [
    { id: 'workflows', to: '/workflows', label: 'Workflows' },
    { id: 'runs', to: runsPath, label: 'Runs', count: needYou },
    { id: 'triggers', to: triggersPath, label: 'Triggers', count: triggerCount },
  ];
  return (
    <nav
      aria-label="Workflows"
      className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar/50"
    >
      <div role="tablist" aria-label="Workflows view" className="flex shrink-0 gap-0.5 px-2 pt-2">
        {tabs.map(({ id, to, label, count }) => (
          <Button
            key={id}
            asChild
            role="tab"
            size="xs"
            variant={tab === id ? 'secondary' : 'ghost'}
            aria-selected={tab === id}
          >
            <Link to={to}>
              {label}
              {count !== undefined && count > 0 && (
                <span
                  className="opacity-70"
                  aria-label={id === 'runs' ? `${count} waiting for you` : undefined}
                >
                  {count}
                </span>
              )}
            </Link>
          </Button>
        ))}
      </div>
      {tab !== 'runs' && (
        <div className="flex h-10 shrink-0 items-center px-2">
          <Button asChild variant="ghost" size="sm" className="w-full justify-start">
            <Link to="/workflows/new">
              <PlusIcon />
              New workflow
            </Link>
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {tab === 'runs' ? (
          <section aria-label="Runs" className="mt-2">
            <h3 className="px-2 pb-1 text-2xs font-medium text-muted-foreground">
              Runs<span className="ml-1 opacity-70">{runs.length}</span>
            </h3>
            {runs.length === 0 ? (
              <p className="px-2 text-xs text-muted-foreground">
                No runs yet. Run a workflow now, or a card or trigger starts one.
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {runsTabOrder(runs).map((run) => (
                  <li key={run.id}>
                    <Link
                      to="/workflows/runs/$runId"
                      params={{ runId: run.id }}
                      data-testid="run-row"
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
                          {runStateLabel(run, threads)}
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
            )}
          </section>
        ) : (
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

// The Runs tab with no run open.
export function RunsHome() {
  const runs = useTopic('workflowRuns');
  const waiting = (runs ?? []).filter(waitsForYou).length;
  return (
    <EmptyState
      icon={PlayIcon}
      title={runs !== undefined && runs.length > 0 ? 'Pick a run' : 'No runs yet'}
      description={
        waiting > 0
          ? `${waiting === 1 ? 'One run waits' : `${waiting} runs wait`} for you; they are listed first.`
          : 'Runs that wait for you or are running are listed first.'
      }
    />
  );
}
