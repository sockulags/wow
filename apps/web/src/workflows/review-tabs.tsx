import type { Project, Workflow, WorkflowRun } from '@wow/contracts';
import { FileTextIcon, GitPullRequestIcon, LibraryIcon, TicketIcon } from 'lucide-react';
import { EmptyState } from '@/components/states';
import { Artifact } from './artifact-link';
import type { ReviewTab } from './changes';
import { attemptLabel } from './model';

// The review tabs beside Changes (review loop spec 14). Artifacts lists what each step left in
// the run's folder; a tab with nothing to show says so.

// The files every started step was expected to produce and did, in step order.
export function ArtifactsTab({
  run,
  workflow,
  project,
}: {
  readonly run: WorkflowRun;
  readonly workflow: Workflow | undefined;
  readonly project: Project | undefined;
}) {
  const steps = run.steps.filter((stepRun) => stepRun.artifactsFound.length > 0);
  if (steps.length === 0 || !project) {
    return (
      <EmptyState
        icon={FileTextIcon}
        title="Nothing to show yet"
        description="No step of this run has left a file it was expected to produce. Files show here as soon as a step that names them ends."
      />
    );
  }
  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      <ul aria-label="Artifacts by step" className="flex flex-col gap-3">
        {steps.map((stepRun) => {
          const index = run.steps.indexOf(stepRun);
          const name = workflow?.steps[index]?.skillName ?? stepRun.stepId;
          const attempt = attemptLabel(stepRun);
          return (
            <li key={stepRun.stepId} className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">
                <span className="tabular-nums">{index + 1}.</span>{' '}
                <span className="font-medium text-foreground">{name}</span>
                {attempt ? ` · ${attempt}` : ''}
              </span>
              <ul aria-label={`Artifacts of ${name}`} className="flex flex-col gap-0.5 pl-4">
                {stepRun.artifactsFound.map((path) => (
                  <Artifact key={path} runId={run.id} cwd={project.cwd} path={path} />
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const hostTabs = {
  pullRequest: {
    icon: GitPullRequestIcon,
    description: 'wow does not read pull requests yet, so this run has none to show.',
  },
  ticket: {
    icon: TicketIcon,
    description: 'wow does not read tickets yet, so this run has none to show.',
  },
  pages: {
    icon: LibraryIcon,
    description: 'wow does not read linked pages yet, so this run has none to show.',
  },
} as const;

// Pull request, Ticket and Pages have no source yet: each says so.
export function HostTab({ tab }: { readonly tab: Exclude<ReviewTab, 'changes' | 'artifacts'> }) {
  const { icon, description } = hostTabs[tab];
  return <EmptyState icon={icon} title="Nothing to show yet" description={description} />;
}
