import { Link, Outlet } from '@tanstack/react-router';
import { PlusIcon, WorkflowIcon } from 'lucide-react';
import { useConnectionState, useSetting } from '@/app/runtime';
import { Button } from '@/components/ui/button';
import { useTopic } from '@/chat/data';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { runStateDotClass, runStateLabels, sortRuns } from './model';

function WorkflowList() {
  const workflows = useTopic('workflows') ?? [];
  const runs = useTopic('workflowRuns') ?? [];
  const names = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
  const linkClass = 'flex flex-col rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent';
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
          <h3 className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">
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
                    <span className="truncate text-[11px] text-muted-foreground">
                      {workflow.steps.map((step) => step.skillName).join(' → ')}
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
        {runs.length > 0 && (
          <section aria-label="Runs" className="mt-3">
            <h3 className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">
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
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {runStateLabels[run.state]}
                      </span>
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

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <WorkflowIcon className="size-6 text-muted-foreground" aria-hidden />
      <h2 className="text-sm font-medium">{title}</h2>
      <div className="max-w-sm text-xs text-muted-foreground">{children}</div>
    </section>
  );
}

export function WorkflowsLayout() {
  const { configured } = useConnectionState();
  if (!configured) {
    return (
      <Empty title="No workflows yet">
        Chains of skills with gates between steps will appear here once the app is connected to the
        wow server.
      </Empty>
    );
  }
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
  return (
    <Empty title={workflows && workflows.length > 0 ? 'Pick a workflow' : 'No workflows yet'}>
      <p>A workflow is an ordered list of skills with gates where it waits for you.</p>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to="/workflows/new">
            <PlusIcon />
            New workflow
          </Link>
        </Button>
        {templates.map((template) => (
          <Button key={template.kind} asChild size="sm" variant="ghost">
            <Link to="/workflows/new" search={{ template: template.kind }}>
              From {template.name}
            </Link>
          </Button>
        ))}
      </div>
    </Empty>
  );
}
