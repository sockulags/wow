import {
  hostKindLabels,
  hostReadId,
  isLivePlanRunState,
  settingsRegistry,
  type ChangeRequest,
  type HostCheck,
  type HostRead,
  type PlanFile,
  type PlanIntent,
  type PlanProblem,
  type PlanRun,
  type PlanRunUnit,
  type PlanUnit,
  type Project,
  type Workflow,
  type WorkflowRun,
} from '@wow/contracts';

// What the Plans view says about the rows it gets. The server reads the files and decides every
// status; these are only the words.

export const unitStatusLabels: Readonly<Record<PlanUnit['status'], string>> = {
  delivered: 'Delivered',
  claimed: 'Claimed',
  ready: 'Ready',
  waiting: 'Waiting',
  blocked: 'Blocked',
  unknown: 'Status unknown',
};

// The badge each status gets: what needs nothing from the user is quiet, what is in the way
// stands out.
export const unitStatusVariants: Readonly<
  Record<PlanUnit['status'], 'default' | 'secondary' | 'info' | 'warning' | 'outline'>
> = {
  delivered: 'secondary',
  claimed: 'info',
  ready: 'default',
  waiting: 'outline',
  blocked: 'warning',
  unknown: 'outline',
};

// What was last read from the host for a plan or a run, if anything.
export const planRead = (
  reads: readonly HostRead[],
  intent: Pick<PlanIntent, 'id'>,
): HostRead | undefined => reads.find((read) => read.id === hostReadId('plan', intent.id));
export const runRead = (reads: readonly HostRead[], runId: string): HostRead | undefined =>
  reads.find((read) => read.id === hostReadId('run', runId));

// "Open", "Draft", "Merged" or "Closed".
export const changeRequestStateLabel = (request: Pick<ChangeRequest, 'state' | 'draft'>): string =>
  request.state === 'merged'
    ? 'Merged'
    : request.state === 'closed'
      ? 'Closed'
      : request.draft
        ? 'Draft'
        : 'Open';

export const failingChecks = (request: Pick<ChangeRequest, 'checks'>): HostCheck[] =>
  request.checks.filter((check) => check.state === 'failure');

// "No checks", "3 checks passed", "1 of 3 checks still running" or "2 of 5 checks failed".
export function checksLabel(request: Pick<ChangeRequest, 'checkState' | 'checks'>): string {
  const total = request.checks.length;
  const count = (state: HostCheck['state']) =>
    request.checks.filter((check) => check.state === state).length;
  const checks = total === 1 ? 'check' : 'checks';
  switch (request.checkState) {
    case 'none':
      return 'No checks';
    case 'success':
      return `${total} ${checks} passed`;
    case 'pending':
      return `${count('pending')} of ${total} ${checks} still running`;
    case 'failure':
      return `${count('failure')} of ${total} ${checks} failed`;
  }
}

// "Last fetched 09:02 from github.com", or that nothing was fetched yet.
export function lastFetchedLabel(
  read: Pick<HostRead, 'fetchedAt' | 'host' | 'hostName'> | undefined,
  when: (iso: string) => string,
): string {
  if (!read?.fetchedAt) return 'Not fetched yet';
  return `Last fetched ${when(read.fetchedAt)} from ${read.hostName || hostKindLabels[read.host]}`;
}

// The label of the setting a host error points at, for the link to it.
export const settingLabel = (key: string): string =>
  Object.hasOwn(settingsRegistry, key)
    ? settingsRegistry[key as keyof typeof settingsRegistry].label
    : key;

// The Settings page a setting is on; Trackers for one the registry does not know.
export const settingGroup = (key: string): string =>
  Object.hasOwn(settingsRegistry, key)
    ? settingsRegistry[key as keyof typeof settingsRegistry].group
    : 'trackers';

export const fileNames = { intent: 'intent.md', spec: 'spec.md', plan: 'plan.md' } as const;

export const problemLabel = (problem: PlanProblem): string =>
  `${fileNames[problem.file]} line ${problem.line}: ${problem.message}`;

// "Stale: built on intent@1, intent.md is at rev 2".
export function staleLabel(kind: 'spec' | 'plan', file: PlanFile): string | undefined {
  if (!file.stale) return undefined;
  const source = kind === 'spec' ? 'intent' : 'spec';
  return `Stale: built on ${source}@${file.stale.builtOn}, ${fileNames[source]} is at rev ${file.stale.current}`;
}

// "accepted · rev 2", with what is missing left out.
export const revisionLabel = (status: string | null, rev: number | null): string =>
  [status, rev === null ? null : `rev ${rev}`].filter((part) => part !== null).join(' · ') ||
  'No status';

export interface ProjectPlans {
  readonly project: Project;
  readonly intents: readonly PlanIntent[];
}

// Every project by name with its intents by id, so a project without intents still shows.
export function plansByProject(
  projects: readonly Project[],
  intents: readonly PlanIntent[],
): ProjectPlans[] {
  return projects
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((project) => ({
      project,
      intents: intents
        .filter((intent) => intent.projectId === project.id)
        .toSorted((a, b) => a.intentId.localeCompare(b.intentId)),
    }));
}

// The `?unit=` search of the plan route: the unit whose contract is open.
export const validatePlanSearch = (search: Record<string, unknown>): { unit?: string } =>
  typeof search['unit'] === 'string' && search['unit'] !== '' ? { unit: search['unit'] } : {};

// A hand-typed path can hold a broken escape such as `%zz`; that names no intent and must not
// throw, because the shell reads the open plan on every route.
function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

// The intent a `/plans/<projectId>/<intentId>` path names.
export function openPlan(pathname: string, intents: readonly PlanIntent[]): PlanIntent | undefined {
  const match = /^\/plans\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match) return undefined;
  const [, projectId, intentId] = match.map(decodeSegment);
  if (projectId === undefined || intentId === undefined) return undefined;
  return intents.find((intent) => intent.projectId === projectId && intent.intentId === intentId);
}

// Plan runs (review loop spec 40 to 47). The server decides everything about one; these are the
// words and which row the view shows.

export const planRunStateLabels: Readonly<Record<PlanRun['state'], string>> = {
  running: 'Running',
  waiting: 'Waiting',
  done: 'Done',
  failed: 'Stopped after a failure',
  stopped: 'Stopped',
};

export const planRunStateVariants: Readonly<
  Record<PlanRun['state'], 'default' | 'secondary' | 'info' | 'warning' | 'outline'>
> = {
  running: 'info',
  waiting: 'outline',
  done: 'secondary',
  failed: 'warning',
  stopped: 'outline',
};

export const livePlanRun = (planRuns: readonly PlanRun[], planId: string): PlanRun | undefined =>
  planRuns.find((planRun) => planRun.planId === planId && isLivePlanRunState(planRun.state));

// The plan run the plan's view shows: the live one, else the one that started last.
export const shownPlanRun = (planRuns: readonly PlanRun[], planId: string): PlanRun | undefined =>
  livePlanRun(planRuns, planId) ??
  planRuns
    .filter((planRun) => planRun.planId === planId)
    .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

// The workflows "Run ready units" can use, by name.
export const unitWorkflows = (workflows: readonly Workflow[]): Workflow[] =>
  workflows
    .filter((workflow) => workflow.forUnits === true)
    .toSorted((a, b) => a.name.localeCompare(b.name));

// Why "Run ready units" is not offered right now, or undefined when it is. The server decides
// whether a plan run starts; this only says what the view already knows.
export function runReadyUnitsBlocked(
  intent: Pick<PlanIntent, 'id' | 'followed' | 'plan'>,
  planRuns: readonly PlanRun[],
  workflows: readonly Workflow[],
): string | undefined {
  if (livePlanRun(planRuns, intent.id)) return 'A plan run is going on this plan';
  if (intent.plan === null) return 'This intent has no plan.md';
  if (!intent.followed) return 'Follow the plan first, so wow knows which units are ready';
  if (unitWorkflows(workflows).length === 0) {
    return 'Turn on “For units” in a workflow first';
  }
  return undefined;
}

// How a unit of a plan run stands: its run's own state while that is live (so a run waiting at
// a gate says so), else what the plan run recorded.
export function planRunUnitLabel(unit: PlanRunUnit, run: WorkflowRun | undefined): string {
  if (unit.outcome === 'running') {
    return run?.state === 'waiting' ? 'Waiting for you' : 'Running';
  }
  return { done: 'Done', failed: 'Failed', stopped: 'Stopped' }[unit.outcome];
}
