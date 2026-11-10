import type { DerivedFile, PlanSource, PlanUnit } from './intent.js';

// Unit status the way agent-os's dispatch-next reads it: from pull requests, never from the plan
// file. A merged pull request carrying the unit's `Intent-Unit: <intent-id>/<unit-key>` line
// delivers it, an open one claims it, a `blocked:` note blocks it, and it is ready when every
// dependency is delivered and the plan and its spec are current. wow adds "waiting" for a unit
// that is none of these, so the list never shows an empty status.

export type UnitStatus = 'delivered' | 'claimed' | 'blocked' | 'ready' | 'waiting' | 'unknown';

export interface UnitReference {
  readonly intentId: string;
  readonly unitKey: string;
}

// Every `Intent-Unit: <intent-id>/<unit-key>` line of a pull request body. A pull request that
// delivers several units carries one line each.
export function intentUnitLines(body: string): UnitReference[] {
  const found: UnitReference[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*Intent-Unit:\s*([^\s/]+)\/(\S+)\s*$/i.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const reference = { intentId: match[1], unitKey: match[2] };
    if (
      !found.some(
        (other) => other.intentId === reference.intentId && other.unitKey === reference.unitKey,
      )
    ) {
      found.push(reference);
    }
  }
  return found;
}

export interface UnitPullRequest {
  readonly id: string;
  // How the pull request is named in a reason, such as "#12".
  readonly label: string;
  readonly state: 'open' | 'merged' | 'closed';
  readonly units: readonly UnitReference[];
}

export interface UnitStatusInput {
  readonly intentId: string;
  readonly source: PlanSource | null;
  readonly spec: Pick<DerivedFile, 'stale'> | null;
  readonly plan: Pick<DerivedFile, 'stale'> | null;
  readonly units: readonly Pick<PlanUnit, 'key' | 'dependsOn' | 'blocked'>[];
  readonly pullRequests: readonly UnitPullRequest[];
}

export interface DerivedUnitStatus {
  readonly key: string;
  readonly status: UnitStatus;
  readonly reason: string;
  // The pull request that delivered or claims the unit.
  readonly pullRequestId: string | null;
}

// Which of the plan's files are stale, as a sentence, or null when none is.
export function staleReason(input: Pick<UnitStatusInput, 'spec' | 'plan'>): string | null {
  const parts: string[] = [];
  if (input.plan?.stale) {
    parts.push(
      `plan.md is stale (built on spec@${input.plan.stale.builtOn}, spec.md is at rev ${input.plan.stale.current})`,
    );
  }
  if (input.spec?.stale) {
    parts.push(
      `spec.md is stale (built on intent@${input.spec.stale.builtOn}, intent.md is at rev ${input.spec.stale.current})`,
    );
  }
  return parts.length > 0 ? parts.join(' and ') : null;
}

export function unitStatuses(input: UnitStatusInput): DerivedUnitStatus[] {
  const carrying = (key: string, state: UnitPullRequest['state']) =>
    input.pullRequests.find(
      (pullRequest) =>
        pullRequest.state === state &&
        pullRequest.units.some((unit) => unit.intentId === input.intentId && unit.unitKey === key),
    );
  const delivered = new Set(
    input.units.filter((unit) => carrying(unit.key, 'merged')).map((unit) => unit.key),
  );
  const stale = staleReason(input);
  return input.units.map((unit): DerivedUnitStatus => {
    const merged = carrying(unit.key, 'merged');
    if (merged) {
      return {
        key: unit.key,
        status: 'delivered',
        reason: `Pull request ${merged.label} is merged`,
        pullRequestId: merged.id,
      };
    }
    const open = carrying(unit.key, 'open');
    if (open) {
      return {
        key: unit.key,
        status: 'claimed',
        reason: `Pull request ${open.label} is open`,
        pullRequestId: open.id,
      };
    }
    const rest = { key: unit.key, pullRequestId: null };
    if (unit.blocked !== null) return { ...rest, status: 'blocked', reason: unit.blocked };
    // With `source: issues` the tracker holds the dependencies, so the files cannot say whether
    // a unit without a pull request is ready.
    if (input.source !== 'files') {
      return {
        ...rest,
        status: 'unknown',
        reason: 'No pull request yet, and this plan keeps its dependencies in issues',
      };
    }
    const missing = unit.dependsOn.filter((key) => !delivered.has(key));
    if (missing.length > 0) {
      return { ...rest, status: 'waiting', reason: `Waits for ${missing.join(', ')}` };
    }
    if (stale) return { ...rest, status: 'waiting', reason: `Not ready: ${stale}` };
    return {
      ...rest,
      status: 'ready',
      reason: unit.dependsOn.length > 0 ? 'Every dependency is delivered' : 'No dependencies',
    };
  });
}
