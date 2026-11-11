import type { AppNotification, Workflow, WorkflowRun } from '@wow/contracts';

export interface Notice {
  readonly title: string;
  readonly body: string;
  // Where the window opens when the notification is clicked.
  readonly path: string;
}

export interface RunNotice extends Notice {
  readonly runId: string;
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

export interface ChatNotice extends Notice {
  readonly id: string;
  // Set for a "Needs you" that waits on an approval: the notification offers Allow once and Deny.
  readonly approvalId: string | undefined;
}

// The chat threads' notifications the server stored since the previous snapshot of the
// notifications topic (agent workbench spec 64). Run notifications come from the runs instead
// (`runNotices`), so they are left out here. The first snapshot only sets the baseline.
export function chatNotices(
  seen: ReadonlySet<string> | undefined,
  rows: readonly AppNotification[],
): ChatNotice[] {
  if (seen === undefined) return [];
  return rows
    .filter((row) => !seen.has(row.id) && row.threadId != null)
    .toReversed()
    .map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      path: row.path,
      approvalId: row.approvalId ?? undefined,
    }));
}

// The app's route a window at this address shows, for "that thread is on screen".
export const routeOf = (url: string, origin: string): string | undefined =>
  url.startsWith(`${origin}/`) ? new URL(url).pathname : undefined;
