import type { Workflow, WorkflowRun } from '@wow/contracts';

export interface RunNotice {
  readonly runId: string;
  readonly title: string;
  readonly body: string;
  // Where the window opens when the notification is clicked.
  readonly path: string;
}

// Run states the user hears about when a run enters them. A run that appears is "started".
const enteredStateTitles: Readonly<Record<string, string>> = {
  waiting: 'Waiting for you',
  failed: 'Workflow run failed',
};

export type RunStates = ReadonlyMap<string, string>;

export const runStates = (runs: readonly WorkflowRun[]): RunStates =>
  new Map(runs.map((run) => [run.id, run.state]));

// Turns two consecutive snapshots of the workflowRuns topic into notifications. The first
// snapshot (`previous` undefined) only sets the baseline, so starting the app does not replay
// every run it finds.
export function runNotices(
  previous: RunStates | undefined,
  runs: readonly WorkflowRun[],
  workflows: readonly Workflow[],
): RunNotice[] {
  if (previous === undefined) return [];
  const names = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));
  const notices: RunNotice[] = [];
  for (const run of runs) {
    const before = previous.get(run.id);
    if (before === run.state) continue;
    const body = `${names.get(run.workflowId) ?? 'Workflow'}, step ${run.currentStep + 1} of ${run.steps.length}`;
    const title = before === undefined ? 'Workflow run started' : enteredStateTitles[run.state];
    if (title !== undefined) notices.push({ runId: run.id, title, body, path: '/workflows' });
  }
  return notices;
}
