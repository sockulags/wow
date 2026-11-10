import type { PlanFile, PlanIntent, PlanProblem, PlanUnit, Project } from '@wow/contracts';

// What the Plans view says about the rows it gets. The server reads the files and decides every
// status; these are only the words.

export const unitStatusLabels: Readonly<Record<PlanUnit['status'], string>> = {
  blocked: 'Blocked',
  unknown: 'Status unknown',
};

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
