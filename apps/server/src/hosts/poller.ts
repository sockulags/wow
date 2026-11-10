import {
  changeRequestId,
  hostKindLabels,
  hostReadId,
  isLivePlanRunState,
  isLiveRunState,
  settingsRegistry,
  workingCopyOnDisk,
  ChangeRequest,
  type HostError,
  type HostRead,
  type HostReadOutcome,
  type HostRefreshParams,
  type PlanIntent,
  type WorkflowRun,
} from '@wow/contracts';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import { changeRequests, hostReads, planIntents, planRuns, workflowRuns } from '../db/schema.js';
import type { BackgroundService } from '../hooks/index.js';
import type { Logger } from '../logger.js';
import type { SchedulerTimers } from '../scheduler/service.js';
import type { SettingsService } from '../settings/service.js';
import type { ProjectGitHubHost } from '../trackers/service.js';
import { HostFailure, type FoundChangeRequest, type HostAdapter } from './adapter.js';
import { createGitHubHost } from './github.js';

const realTimers: SchedulerTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface HostPollerDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly settings: SettingsService;
  readonly logger: Logger;
  // The project's host settings as they apply (TrackerService.githubHost).
  readonly resolve: (projectId: string) => Promise<ProjectGitHubHost | undefined>;
  // The branch a run's own working copy is on (null on none). Runs in the project folder share
  // the project's branch and are not asked.
  readonly workingCopyBranch?: (folder: string) => Promise<string | null>;
  readonly clock?: () => Date;
  readonly timers?: SchedulerTimers;
  readonly fetch?: typeof fetch;
  // Builds the host adapter; GitHub's unless a test gives its own.
  readonly adapter?: typeof createGitHubHost;
}

// What one round asks about: the followed plans and the runs of one project.
interface Targets {
  readonly plans: PlanIntent[];
  readonly runs: WorkflowRun[];
}

type ErrorNow = Omit<HostError, 'at'>;

// One pull request came back in a form the contract does not allow. Only the plan or run that
// names it fails; the host itself answered, so the rest of the round goes on.
class UnusableAnswer extends HostFailure {}

const labelOf = (key: string) =>
  Object.hasOwn(settingsRegistry, key)
    ? settingsRegistry[key as keyof typeof settingsRegistry].label
    : key;

// Asks the hosts about what wow follows (review loop spec 27 to 32): the pull requests of
// followed plans and of plans a plan run is live on, found with one search per plan, and the
// pull request of each live run's branch. Never a whole repository. It asks every `hosts.pollSeconds` while `hosts.polling` is
// on and the scheduler is not paused, once when a plan is followed or a run starts under the
// same conditions, and once on "Refresh now" whatever the settings say. What it reads goes
// through the engine as `hosts.sync`; a read that fails is stored as the error beside the last
// data. It only reads from the hosts.
export class HostPoller implements BackgroundService {
  readonly #deps: HostPollerDeps;
  readonly #clock: () => Date;
  readonly #timers: SchedulerTimers;
  readonly #unsubscribe: (() => void)[] = [];
  // Hosts that said their request limit is used up, and until when.
  readonly #leaveAlone = new Map<string, Date>();
  // The scopes seen so far, to tell a newly followed plan or a new run from the rest.
  #seen = new Set<string>();
  // Unit runs whose end was already followed by a read of their plan.
  readonly #unitRunsEnded = new Set<string>();
  #tail: Promise<unknown> = Promise.resolve();
  #timer: unknown;
  #running = false;

  constructor(deps: HostPollerDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? (() => new Date());
    this.#timers = deps.timers ?? realTimers;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#unsubscribe.push(
      this.#deps.settings.onChange((key) => {
        if (key === 'hosts.pollSeconds') this.#schedule();
      }),
      this.#deps.engine.onCommit((commit) => {
        if (
          commit.topics.has('planIntents') ||
          commit.topics.has('workflowRuns') ||
          commit.topics.has('planRuns')
        ) {
          this.#noticed();
        }
        for (const { event } of commit.events) {
          if (event.kind !== 'workflowRun.changed') continue;
          const { run } = event.payload;
          if (run.unit && !isLiveRunState(run.state)) this.#unitRunEnded(run.id, run.unit.planId);
        }
      }),
    );
    this.#seen = new Set(this.#scopeIds(this.#targets()));
    this.#background(this.poll());
    this.#schedule();
  }

  // The round the timer runs. Nothing is asked while the scheduler is paused or polling is off.
  poll(): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#automatic()) return;
      await this.#read(this.#targets(), false);
    });
  }

  // "Refresh now": asks once about one followed plan, one run, or everything, whatever the
  // polling settings and the hosts' request limits say.
  refresh(params: HostRefreshParams = {}): Promise<HostRead[]> {
    const targets = this.#targets(params);
    return this.#enqueue(async () => {
      await this.#read(targets, true);
      const ids = this.#scopeIds(targets);
      return ids.length === 0
        ? []
        : this.#deps.db.select().from(hostReads).where(inArray(hostReads.id, ids)).all();
    });
  }

  // Settles when nothing is being asked; for tests and shutdown.
  async idle(): Promise<void> {
    let tail: Promise<unknown> | undefined;
    while (tail !== this.#tail) {
      tail = this.#tail;
      await tail;
    }
  }

  async stop(): Promise<void> {
    this.#running = false;
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.idle();
  }

  #automatic(): boolean {
    const { settings } = this.#deps;
    return this.#running && settings.get('hosts.polling') && !settings.get('scheduler.paused');
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  #background(work: Promise<unknown>): void {
    work.catch((error: unknown) => this.#deps.logger.error('host read failed', error));
  }

  #schedule(): void {
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#running) return;
    const delayMs = this.#deps.settings.get('hosts.pollSeconds') * 1000;
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined;
      this.#background(this.poll().finally(() => this.#schedule()));
    }, delayMs);
  }

  // A plan that was just followed or a run that just started is asked about at once, so its
  // view does not wait for the next round.
  #noticed(): void {
    const all = this.#targets();
    const ids = this.#scopeIds(all);
    const fresh = new Set(ids.filter((id) => !this.#seen.has(id)));
    this.#seen = new Set(ids);
    if (fresh.size === 0 || !this.#automatic()) return;
    const targets = new Map<string, Targets>();
    for (const [projectId, { plans, runs }] of all) {
      const own = {
        plans: plans.filter((plan) => fresh.has(hostReadId('plan', plan.id))),
        runs: runs.filter((run) => fresh.has(hostReadId('run', run.id))),
      };
      if (own.plans.length + own.runs.length > 0) targets.set(projectId, own);
    }
    this.#background(
      this.#enqueue(async () => {
        if (this.#automatic()) await this.#read(targets, false);
      }),
    );
  }

  // A unit's run that ended has most likely opened its pull request, so its plan is asked about
  // at once: the plan run then says what it really waits for.
  #unitRunEnded(runId: string, planId: string): void {
    if (this.#unitRunsEnded.has(runId)) return;
    this.#unitRunsEnded.add(runId);
    this.#background(
      this.#enqueue(async () => {
        if (!this.#automatic()) return;
        const plan = this.#openPlans().find((candidate) => candidate.id === planId);
        if (plan) await this.#read(new Map([[plan.projectId, { plans: [plan], runs: [] }]]), false);
      }),
    );
  }

  // The plans wow reads from a host: followed ones, and ones a plan run is live on.
  #openPlans(): PlanIntent[] {
    const { db } = this.#deps;
    const running = new Set(
      db
        .select({ planId: planRuns.planId, state: planRuns.state })
        .from(planRuns)
        .all()
        .filter((row) => isLivePlanRunState(row.state))
        .map((row) => row.planId),
    );
    return db
      .select()
      .from(planIntents)
      .all()
      .filter((plan) => plan.followed || running.has(plan.id));
  }

  #scopeIds(targets: ReadonlyMap<string, Targets>): string[] {
    return [...targets.values()].flatMap(({ plans, runs }) => [
      ...plans.map((plan) => hostReadId('plan', plan.id)),
      ...runs.map((run) => hostReadId('run', run.id)),
    ]);
  }

  // Open plans and live runs by project; for a refresh, the one plan or run asked for.
  #targets(only: HostRefreshParams = {}): Map<string, Targets> {
    const { db } = this.#deps;
    const targets = new Map<string, Targets>();
    const of = (projectId: string) => {
      const known = targets.get(projectId) ?? { plans: [], runs: [] };
      targets.set(projectId, known);
      return known;
    };
    if (only.planId !== undefined) {
      const plan = db.select().from(planIntents).where(eq(planIntents.id, only.planId)).get();
      if (!plan) throw new CommandRejected('not_found', `No plan ${only.planId}`);
      if (!this.#openPlans().some((open) => open.id === plan.id)) {
        throw new CommandRejected(
          'rejected',
          'Follow the plan first; only followed plans are read',
        );
      }
      of(plan.projectId).plans.push(plan);
    }
    if (only.runId !== undefined) {
      const run = db.select().from(workflowRuns).where(eq(workflowRuns.id, only.runId)).get();
      if (!run) throw new CommandRejected('not_found', `No run ${only.runId}`);
      of(run.projectId).runs.push(run);
    }
    if (only.planId !== undefined || only.runId !== undefined) return targets;
    for (const plan of this.#openPlans()) of(plan.projectId).plans.push(plan);
    for (const run of db.select().from(workflowRuns).all()) {
      if (isLiveRunState(run.state)) of(run.projectId).runs.push(run);
    }
    return targets;
  }

  async #read(targets: ReadonlyMap<string, Targets>, asked: boolean): Promise<void> {
    for (const [projectId, own] of targets) {
      try {
        await this.#readProject(projectId, own, asked);
      } catch (error) {
        // One project's trouble must not keep the others from being read.
        this.#deps.logger.error('host read failed', {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async #readProject(projectId: string, { plans, runs }: Targets, asked: boolean): Promise<void> {
    const { db, settings } = this.#deps;
    const host = await this.#deps.resolve(projectId);
    if (!host) return;
    const outcomes: HostReadOutcome[] = [];
    const read = new Map<number, ChangeRequest>();
    const failed = (id: string, scope: 'plan' | 'run', error: ErrorNow) =>
      outcomes.push({ id, scope, branch: null, result: { ok: false, error } });

    if (!host.github.config) {
      const missing = host.github.missing;
      const error: ErrorNow = {
        kind: 'notSetUp',
        message: `${hostKindLabels.github} is not set up for this project: fill in ${missing.map(labelOf).join(', ')} in Settings → Trackers or in the project's own trackers`,
        setting: missing[0] ?? null,
      };
      for (const plan of plans) failed(hostReadId('plan', plan.id), 'plan', error);
      for (const run of runs) failed(hostReadId('run', run.id), 'run', error);
      this.#store(projectId, host.name, outcomes, []);
      return;
    }

    const until = this.#leaveAlone.get(host.name);
    if (!asked && until && until > this.#clock()) return;

    const adapter: HostAdapter = (this.#deps.adapter ?? createGitHubHost)(
      host.github.config,
      host.name,
      {
        timeoutMs: settings.get('trackers.requestTimeoutMs'),
        listFallbackCount: settings.get('hosts.listFallbackCount'),
        clock: this.#clock,
        ...(this.#deps.fetch ? { fetch: this.#deps.fetch } : {}),
      },
    );
    const stored = new Map(
      db
        .select()
        .from(changeRequests)
        .where(eq(changeRequests.projectId, projectId))
        .all()
        .map((row) => [row.number, row]),
    );
    // One change request is read once a round, however many plans and runs name it.
    const detail = async (found: FoundChangeRequest): Promise<string> => {
      const id = changeRequestId(projectId, found.number);
      if (read.has(found.number)) return id;
      const known = stored.get(found.number);
      // A merged pull request does not change any more, so its checks and comments are not
      // asked for again.
      const row = ChangeRequest.safeParse(
        known?.state === 'merged' && found.state === 'merged'
          ? { ...known, title: found.title, url: found.url, units: [...found.units] }
          : { ...(await adapter.read(found)), id, projectId },
      );
      // A row the contract turns down would break the changeRequests topic for every client,
      // so it is never stored.
      if (!row.success) {
        const where = row.error.issues[0]?.path.join('.') ?? '';
        throw new UnusableAnswer(
          'failed',
          `${host.name} answered pull request #${found.number} in a form wow cannot read (${where === '' ? 'the whole answer' : where})`,
        );
      }
      read.set(found.number, row.data);
      return id;
    };
    // After the first failure the host is not asked again this round: a refused token or a
    // host that is down fails every other request the same way.
    let failure: ErrorNow | undefined;
    const attempt = async (
      id: string,
      scope: 'plan' | 'run',
      branch: string | null,
      find: () => Promise<FoundChangeRequest[]>,
    ) => {
      if (failure) return failed(id, scope, failure);
      try {
        const ids: string[] = [];
        for (const found of await find()) ids.push(await detail(found));
        outcomes.push({ id, scope, branch, result: { ok: true, changeRequestIds: ids } });
      } catch (error) {
        const reason: ErrorNow =
          error instanceof HostFailure
            ? { kind: error.kind, message: error.message, setting: error.setting }
            : {
                kind: 'failed',
                message: error instanceof Error ? error.message : String(error),
                setting: null,
              };
        if (!(error instanceof UnusableAnswer)) failure = reason;
        this.#deps.logger.warn('host read failed', { projectId, host: host.name, ...reason });
        failed(id, scope, reason);
      }
      return undefined;
    };

    for (const plan of plans) {
      await attempt(hostReadId('plan', plan.id), 'plan', null, () =>
        adapter.findForIntent(plan.intentId),
      );
    }
    // Runs in the project folder share its branch; a run with its own working copy is on the
    // branch its agent made there. One branch is asked once a round.
    const ofBranch = new Map<string, Promise<FoundChangeRequest[]>>();
    const found = (branch: string) => {
      const known =
        ofBranch.get(branch) ??
        adapter.findForBranch(branch).then((request) => (request ? [request] : []));
      ofBranch.set(branch, known);
      return known;
    };
    for (const run of runs) {
      const copy = run.workingCopy;
      const branch = !copy
        ? host.branch
        : workingCopyOnDisk(copy)
          ? ((await this.#deps.workingCopyBranch?.(copy.path).catch(() => null)) ?? null)
          : null;
      await attempt(hostReadId('run', run.id), 'run', branch, () =>
        branch === null ? Promise.resolve([]) : found(branch),
      );
    }
    const wait = adapter.waitUntil;
    if (wait) this.#leaveAlone.set(host.name, wait);
    else this.#leaveAlone.delete(host.name);
    this.#store(projectId, host.name, outcomes, [...read.values()]);
  }

  #store(
    projectId: string,
    hostName: string,
    reads: HostReadOutcome[],
    requests: ChangeRequest[],
  ): void {
    if (reads.length === 0) return;
    try {
      this.#deps.engine.dispatch(`hosts.sync:${randomUUID()}`, {
        type: 'hosts.sync',
        projectId,
        at: this.#clock().toISOString(),
        host: 'github',
        hostName,
        reads,
        changeRequests: requests,
      });
    } catch (error) {
      // The project went away while its host was being asked.
      if (error instanceof CommandRejected) {
        this.#deps.logger.debug('host read dropped', { projectId, reason: error.message });
      } else {
        throw error;
      }
    }
  }
}
