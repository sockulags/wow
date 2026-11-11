import {
  changeRequestId,
  changeRequestRef,
  hostKindLabels,
  hostReadId,
  isLivePlanRunState,
  isLiveRunState,
  settingsRegistry,
  workingCopyOnDisk,
  ChangeRequest,
  type HostError,
  type HostKind,
  type HostRead,
  type HostReadOutcome,
  type HostRefreshParams,
  type PageReadOutcome,
  type PageSource,
  type PlanIntent,
  type TicketReadOutcome,
  type TicketSource,
  type WorkflowRun,
} from '@wow/contracts';
import { eq, inArray } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import type { Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import {
  backlogItems,
  changeRequests,
  hostReads,
  planIntents,
  planRuns,
  ticketReads,
  workflowRuns,
} from '../db/schema.js';
import type { BackgroundService } from '../hooks/index.js';
import type { Logger } from '../logger.js';
import type { SchedulerTimers } from '../scheduler/service.js';
import type { SettingsService } from '../settings/service.js';
import type {
  ProjectConfluenceHost,
  ProjectGitHubHost,
  ProjectGitLabHost,
  ProjectJiraHost,
} from '../trackers/service.js';
import {
  HostFailure,
  type FoundChangeRequest,
  type HostAdapter,
  type PageAdapter,
  type PageRef,
} from './adapter.js';
import { confluenceLinksIn, createConfluenceHost, MissingPage } from './confluence.js';
import { createGitHubHost } from './github.js';
import { createGitLabHost } from './gitlab.js';
import { createJiraHost, jiraKeyIn, MissingTicket } from './jira.js';

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
  // The project's GitLab site when its git remote is on it (TrackerService.gitlabHost); such a
  // project reads merge requests there instead of GitHub (review loop spec 34).
  readonly resolveGitLab?: (projectId: string) => Promise<ProjectGitLabHost | undefined>;
  // Builds the GitLab adapter; the real one unless a test gives its own.
  readonly gitlabAdapter?: typeof createGitLabHost;
  // The project's Jira settings as they apply (TrackerService.jiraHost). Without it no ticket is
  // read.
  readonly resolveJira?: (projectId: string) => Promise<ProjectJiraHost | undefined>;
  // Builds the Jira adapter; the real one unless a test gives its own.
  readonly jiraAdapter?: typeof createJiraHost;
  // The project's Confluence settings as they apply (TrackerService.confluenceHost). Without it
  // no page is read.
  readonly resolveConfluence?: (projectId: string) => Promise<ProjectConfluenceHost | undefined>;
  // Builds the Confluence adapter; the real one unless a test gives its own.
  readonly confluenceAdapter?: typeof createConfluenceHost;
  // The texts of one of the project's intents (its intent, spec and plan files), for the pages
  // they link to. Empty when the intent has none.
  readonly intentTexts?: (projectId: string, intentId: string) => Promise<string[]>;
}

// Where one run's ticket key was found, if anywhere.
interface TicketKey {
  readonly key: string | null;
  readonly source: TicketSource | null;
  // Where a backlog item's issue was published; only that site knows the key.
  readonly url?: string;
}

// A request limit belongs to the token that used it up, so another project's token on the same
// host goes on being asked. Only a digest of the token is kept, and only in memory.
const pauseKey = (kind: HostKind, name: string, token: string): string =>
  `${kind}:${name}:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;

// A browse link is on the Jira site when it starts with the site's address.
const onJiraSite = (url: string, baseUrl: string): boolean => {
  if (!URL.canParse(url) || !URL.canParse(baseUrl)) return false;
  const site = new URL(baseUrl);
  const page = new URL(url);
  const prefix = site.pathname.replace(/\/+$/, '');
  return page.origin === site.origin && page.pathname.startsWith(`${prefix}/`);
};
const hostOfLink = (url: string): string => (URL.canParse(url) ? new URL(url).host : url);

// What one round asks about: the followed plans and the runs of one project.
interface Targets {
  readonly plans: PlanIntent[];
  readonly runs: WorkflowRun[];
}

type ErrorNow = Omit<HostError, 'at'>;

// A run whose gate waits for its pull request's checks, and when that wait is over.
interface WaitingGate {
  readonly run: WorkflowRun;
  readonly stepId: string;
  readonly key: string;
  readonly deadline: number;
}

// One pull request came back in a form the contract does not allow. Only the plan or run that
// names it fails; the host itself answered, so the rest of the round goes on.
class UnusableAnswer extends HostFailure {}

const labelOf = (key: string) =>
  Object.hasOwn(settingsRegistry, key)
    ? settingsRegistry[key as keyof typeof settingsRegistry].label
    : key;

const confluenceNotSetUp = (missing: readonly string[]): ErrorNow => ({
  kind: 'notSetUp',
  message: `${hostKindLabels.confluence} is not set up for this project: fill in ${missing.map(labelOf).join(', ')} in Settings → Trackers or in the project's own trackers`,
  setting: missing[0] ?? null,
});

// Asks the hosts about what wow follows (review loop spec 27 to 32): the pull requests of
// followed plans and of plans a plan run is live on, found with one search per plan, and the
// pull request of each live run's branch. Never a whole repository. It asks every
// `hosts.pollSeconds` while `hosts.polling` is on and the scheduler is not paused, once when a
// plan is followed or a run starts under the same conditions, and once on "Refresh now" or when
// a plan run's unit run ends, whatever the settings say. What it reads goes through the engine
// as `hosts.sync`; a read that fails is stored as the error beside the last data. It only reads
// from the hosts.
//
// A run whose gate starts waiting for its pull request's checks (review loop spec 56) is asked
// about once, whatever the polling settings say, because the step has most likely just pushed;
// later rounds keep asking while the run is live. When `workflows.gateChecksTimeoutMinutes` has
// passed since the step ended, the poller sends `workflowRun.checkGate` and the run waits for
// the user.
export class HostPoller implements BackgroundService {
  readonly #deps: HostPollerDeps;
  readonly #clock: () => Date;
  readonly #timers: SchedulerTimers;
  readonly #unsubscribe: (() => void)[] = [];
  // Hosts that said their request limit is used up, and until when.
  readonly #leaveAlone = new Map<string, Date>();
  // The scopes seen so far, to tell a newly followed plan or a new run from the rest.
  #seen = new Set<string>();
  // The gates seen waiting for checks, to tell one that just started waiting from the rest.
  #gates = new Set<string>();
  #gateTimer: unknown;
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
        if (key === 'workflows.gateChecksTimeoutMinutes') {
          // A shorter wait may be over already. Not from inside the commit that changed it.
          this.#background(this.#enqueue(() => Promise.resolve(this.checkGates())));
        }
      }),
      this.#deps.engine.onCommit((commit) => {
        if (
          commit.topics.has('planIntents') ||
          commit.topics.has('workflowRuns') ||
          commit.topics.has('planRuns')
        ) {
          this.#noticed();
        }
        if (commit.topics.has('workflowRuns')) this.#gatesNoticed();
      }),
    );
    this.#seen = new Set(this.#scopeIds(this.#targets()));
    this.#gatesNoticed();
    // A wait that ran out while the server was stopped gets no timer; the read above may store
    // nothing that ends it.
    this.#background(this.#enqueue(() => Promise.resolve(this.checkGates())));
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

  // Asks once about one open plan, for a plan run whose unit's run has just ended: that run has
  // most likely opened its pull request, and someone else may have claimed the next unit. The
  // user started the plan run, so this read does not depend on the polling settings; a host
  // whose request limit is used up is still left alone. Settles when the read is stored.
  readPlan(planId: string): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#running) return;
      const plan = this.#openPlans().find((candidate) => candidate.id === planId);
      if (plan) await this.#read(new Map([[plan.projectId, { plans: [plan], runs: [] }]]), false);
    });
  }

  // Gates that have waited for checks as long as `workflows.gateChecksTimeoutMinutes` allows are
  // looked at once more; the engine then lets the run wait for the user. The timer calls it.
  checkGates(): void {
    const now = this.#clock().getTime();
    for (const gate of this.#waitingGates()) {
      if (gate.deadline > now) continue;
      try {
        this.#deps.engine.dispatch(`gate:${gate.key}:waited`, {
          type: 'workflowRun.checkGate',
          runId: gate.run.id,
          stepId: gate.stepId,
        });
      } catch (error) {
        // The run went away meanwhile.
        if (!(error instanceof CommandRejected)) throw error;
        this.#deps.logger.debug('gate check dropped', { runId: gate.run.id });
      }
    }
    this.#scheduleGates();
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
    if (this.#gateTimer !== undefined) this.#timers.clearTimeout(this.#gateTimer);
    this.#gateTimer = undefined;
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

  #waitingGates(): WaitingGate[] {
    const { db, settings } = this.#deps;
    const waiting: WaitingGate[] = [];
    for (const run of db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.state, 'waiting'))
      .all()) {
      const step = run.steps[run.currentStep];
      if (step?.gate?.state !== 'waitingForChecks') continue;
      const minutes = settings.get('workflows.gateChecksTimeoutMinutes', {
        projectId: run.projectId,
      });
      waiting.push({
        run,
        stepId: step.stepId,
        key: `${run.id}:${step.stepId}:${step.gate.since}`,
        deadline: Date.parse(step.gate.since) + minutes * 60 * 1000,
      });
    }
    return waiting;
  }

  // A gate that just started waiting for checks has its run asked about at once, and the timer
  // is set to the earliest end of a wait.
  #gatesNoticed(): void {
    const waiting = this.#waitingGates();
    const fresh = waiting.filter((gate) => !this.#gates.has(gate.key));
    this.#gates = new Set(waiting.map((gate) => gate.key));
    this.#scheduleGates(waiting);
    if (fresh.length === 0) return;
    const targets = new Map<string, Targets>();
    for (const { run } of fresh) {
      const own = targets.get(run.projectId) ?? { plans: [], runs: [] };
      own.runs.push(run);
      targets.set(run.projectId, own);
    }
    this.#background(
      this.#enqueue(async () => {
        if (this.#running) await this.#read(targets, false);
      }),
    );
  }

  #scheduleGates(waiting: readonly WaitingGate[] = this.#waitingGates()): void {
    if (this.#gateTimer !== undefined) this.#timers.clearTimeout(this.#gateTimer);
    this.#gateTimer = undefined;
    if (!this.#running) return;
    const now = this.#clock().getTime();
    // A wait that is over already was looked at by `checkGates`; only later ones need the timer.
    const deadlines = waiting.map((gate) => gate.deadline).filter((deadline) => deadline > now);
    if (deadlines.length === 0) return;
    this.#gateTimer = this.#timers.setTimeout(
      () => {
        this.#gateTimer = undefined;
        this.checkGates();
      },
      Math.min(...deadlines) - now,
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
      // After the pull requests, whose titles and branches can name the ticket.
      if (own.runs.length === 0) continue;
      try {
        await this.#readTickets(projectId, own.runs, asked);
      } catch (error) {
        this.#deps.logger.error('ticket read failed', {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // After the tickets, whose descriptions can link to pages.
      try {
        await this.#readPages(projectId, own.runs, asked);
      } catch (error) {
        this.#deps.logger.error('page read failed', {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // The project's code host: GitLab when its remote is on the stored GitLab site, else GitHub.
  // `adapter` is undefined while a setting is missing, which `missing` names.
  async #codeHost(projectId: string): Promise<
    | {
        readonly kind: HostKind;
        readonly name: string;
        readonly branch: string | null;
        readonly missing: readonly string[];
        readonly token: string;
        readonly adapter: (() => HostAdapter) | undefined;
      }
    | undefined
  > {
    const { settings } = this.#deps;
    const options = {
      timeoutMs: settings.get('trackers.requestTimeoutMs'),
      listFallbackCount: settings.get('hosts.listFallbackCount'),
      clock: this.#clock,
      ...(this.#deps.fetch ? { fetch: this.#deps.fetch } : {}),
    };
    const gitlab = await this.#deps.resolveGitLab?.(projectId);
    if (gitlab) {
      const { config, missing } = gitlab.gitlab;
      return {
        kind: 'gitlab',
        name: gitlab.name,
        branch: gitlab.branch,
        missing,
        token: config?.token ?? '',
        adapter: config
          ? () => (this.#deps.gitlabAdapter ?? createGitLabHost)(config, gitlab.name, options)
          : undefined,
      };
    }
    const github = await this.#deps.resolve(projectId);
    if (!github) return undefined;
    const { config, missing } = github.github;
    return {
      kind: 'github',
      name: github.name,
      branch: github.branch,
      missing,
      token: config?.token ?? '',
      adapter: config
        ? () => (this.#deps.adapter ?? createGitHubHost)(config, github.name, options)
        : undefined,
    };
  }

  async #readProject(projectId: string, { plans, runs }: Targets, asked: boolean): Promise<void> {
    const { db } = this.#deps;
    const host = await this.#codeHost(projectId);
    if (!host) return;
    const outcomes: HostReadOutcome[] = [];
    const read = new Map<number, ChangeRequest>();
    const failed = (id: string, scope: 'plan' | 'run', error: ErrorNow) =>
      outcomes.push({ id, scope, branch: null, result: { ok: false, error } });

    if (!host.adapter) {
      const { missing } = host;
      const error: ErrorNow = {
        kind: 'notSetUp',
        message: `${hostKindLabels[host.kind]} is not set up for this project: fill in ${missing.map(labelOf).join(', ')} in Settings → Trackers or in the project's own trackers`,
        setting: missing[0] ?? null,
      };
      for (const plan of plans) failed(hostReadId('plan', plan.id), 'plan', error);
      for (const run of runs) failed(hostReadId('run', run.id), 'run', error);
      this.#store(projectId, host.kind, host.name, outcomes, []);
      return;
    }

    const leaveAlone = pauseKey(host.kind, host.name, host.token);
    const until = this.#leaveAlone.get(leaveAlone);
    if (!asked && until && until > this.#clock()) return;

    const adapter = host.adapter();
    const noun = host.kind === 'gitlab' ? 'merge request' : 'pull request';
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
          ? {
              ...known,
              title: found.title,
              url: found.url,
              units: [...found.units],
              links: [...(found.links ?? known.links)],
            }
          : { ...(await adapter.read(found)), id, projectId },
      );
      // A row the contract turns down would break the changeRequests topic for every client,
      // so it is never stored.
      if (!row.success) {
        const where = row.error.issues[0]?.path.join('.') ?? '';
        throw new UnusableAnswer(
          'failed',
          `${host.name} answered ${noun} ${changeRequestRef({ host: host.kind, number: found.number })} in a form wow cannot read (${where === '' ? 'the whole answer' : where})`,
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
    if (wait) this.#leaveAlone.set(leaveAlone, wait);
    else this.#leaveAlone.delete(leaveAlone);
    this.#store(projectId, host.kind, host.name, outcomes, [...read.values()]);
  }

  // The ticket of each run (review loop spec 33): the Jira issue its backlog item was published
  // as, else a key with the project's Jira key in the title of its pull request, else in the
  // name of its branch. Only runs are asked about, never a whole Jira project.
  async #ticketKey(run: WorkflowRun, host: ProjectJiraHost): Promise<TicketKey> {
    const { db } = this.#deps;
    const item = run.backlogItemId
      ? db.select().from(backlogItems).where(eq(backlogItems.id, run.backlogItemId)).get()
      : undefined;
    if (item?.remote?.service === 'jira') {
      return { key: item.remote.key, source: 'backlog', url: item.remote.url };
    }
    if (host.projectKey === '') return { key: null, source: null };
    const read = db
      .select()
      .from(hostReads)
      .where(eq(hostReads.id, hostReadId('run', run.id)))
      .get();
    const requestId = read?.changeRequestIds[0];
    const request = requestId
      ? db.select().from(changeRequests).where(eq(changeRequests.id, requestId)).get()
      : undefined;
    const fromTitle = request ? jiraKeyIn(request.title, host.projectKey) : undefined;
    if (fromTitle) return { key: fromTitle, source: 'pullRequest' };
    const copy = run.workingCopy;
    const branch =
      request?.headBranch ??
      read?.branch ??
      (!copy
        ? await host.branch().catch(() => null)
        : workingCopyOnDisk(copy)
          ? ((await this.#deps.workingCopyBranch?.(copy.path).catch(() => null)) ?? null)
          : null);
    const fromBranch = branch ? jiraKeyIn(branch, host.projectKey) : undefined;
    return fromBranch ? { key: fromBranch, source: 'branch' } : { key: null, source: null };
  }

  async #readTickets(projectId: string, runs: WorkflowRun[], asked: boolean): Promise<void> {
    const { settings } = this.#deps;
    const host = await this.#deps.resolveJira?.(projectId);
    if (!host) return;
    const leaveAlone = pauseKey('jira', host.name, host.jira.config?.token ?? '');
    const until = this.#leaveAlone.get(leaveAlone);
    if (!asked && until && until > this.#clock()) return;
    const outcomes: TicketReadOutcome[] = [];
    const config = host.jira.config;
    const adapter = config
      ? (this.#deps.jiraAdapter ?? createJiraHost)(config, host.name, {
          timeoutMs: settings.get('trackers.requestTimeoutMs'),
          clock: this.#clock,
          ...(this.#deps.fetch ? { fetch: this.#deps.fetch } : {}),
        })
      : undefined;
    // One ticket is asked for once a round, however many runs name it. After a failure other
    // than a missing ticket the host is not asked again this round.
    const tickets = new Map<string, Promise<TicketReadOutcome['result']>>();
    let failure: ErrorNow | undefined;
    const ask = (key: string): Promise<TicketReadOutcome['result']> => {
      const known = tickets.get(key);
      if (known) return known;
      const asking = (async (): Promise<TicketReadOutcome['result']> => {
        if (failure) return { ok: false, error: failure };
        try {
          return { ok: true, ticket: (await adapter?.read(key)) ?? null };
        } catch (error) {
          const reason: ErrorNow =
            error instanceof HostFailure
              ? { kind: error.kind, message: error.message, setting: error.setting }
              : {
                  kind: 'failed',
                  message: error instanceof Error ? error.message : String(error),
                  setting: null,
                };
          if (!(error instanceof MissingTicket)) failure = reason;
          this.#deps.logger.warn('ticket read failed', { projectId, host: host.name, ...reason });
          return { ok: false, error: reason };
        }
      })();
      tickets.set(key, asking);
      return asking;
    };
    for (const run of runs) {
      const { key, source, url } = await this.#ticketKey(run, host);
      const missing = [
        ...host.jira.missing,
        ...(key === null && host.projectKey === '' ? ['trackers.jira.projectKey'] : []),
      ];
      if (missing.length > 0) {
        outcomes.push({
          runId: run.id,
          key,
          source,
          result: {
            ok: false,
            error: {
              kind: 'notSetUp',
              message: `${hostKindLabels.jira} is not set up for this project: fill in ${missing.map(labelOf).join(', ')} in Settings → Trackers or in the project's own trackers`,
              setting: missing[0] ?? null,
            },
          },
        });
        continue;
      }
      if (url !== undefined && config && !onJiraSite(url, config.baseUrl)) {
        outcomes.push({
          runId: run.id,
          key,
          source,
          result: {
            ok: false,
            error: {
              kind: 'notSetUp',
              message: `${key ?? ''} was published to ${hostOfLink(url)}, not to this project's ${hostKindLabels.jira} site ${host.name}; wow reads a ticket only from the ${labelOf('trackers.jira.baseUrl')} in Settings → Trackers or in the project's own trackers`,
              setting: 'trackers.jira.baseUrl',
            },
          },
        });
        continue;
      }
      outcomes.push({
        runId: run.id,
        key,
        source,
        result: key === null ? { ok: true, ticket: null } : await ask(key),
      });
    }
    const wait = adapter?.waitUntil;
    if (wait) this.#leaveAlone.set(leaveAlone, wait);
    else this.#leaveAlone.delete(leaveAlone);
    if (outcomes.length === 0) return;
    try {
      this.#deps.engine.dispatch(`tickets.sync:${randomUUID()}`, {
        type: 'tickets.sync',
        projectId,
        at: this.#clock().toISOString(),
        hostName: host.name,
        reads: outcomes,
      });
    } catch (error) {
      if (error instanceof CommandRejected) {
        this.#deps.logger.debug('ticket read dropped', { projectId, reason: error.message });
      } else {
        throw error;
      }
    }
  }

  // The texts of a run that can link to pages, by where they come from: the description of its
  // ticket, the body of its pull request, and the files of its intent (the plan unit it delivers,
  // or an intent its pull request's `Intent-Unit` lines name). All as last read; nothing here
  // asks a host.
  async #pageTexts(run: WorkflowRun): Promise<[PageSource, string][]> {
    const { db } = this.#deps;
    const texts: [PageSource, string][] = [];
    const ticket = db
      .select()
      .from(ticketReads)
      .where(eq(ticketReads.id, hostReadId('run', run.id)))
      .get()?.ticket;
    if (ticket) texts.push(['ticket', ticket.description]);
    const read = db
      .select()
      .from(hostReads)
      .where(eq(hostReads.id, hostReadId('run', run.id)))
      .get();
    const requests =
      read && read.changeRequestIds.length > 0
        ? db
            .select()
            .from(changeRequests)
            .where(inArray(changeRequests.id, read.changeRequestIds))
            .all()
        : [];
    for (const request of requests) texts.push(['pullRequest', request.links.join('\n')]);
    const intents = new Set<string>();
    if (run.unit) intents.add(run.unit.intentId);
    for (const request of requests) for (const unit of request.units) intents.add(unit.intentId);
    for (const intentId of intents) {
      const files = (await this.#deps.intentTexts?.(run.projectId, intentId).catch(() => [])) ?? [];
      for (const file of files) texts.push(['intent', file]);
    }
    return texts;
  }

  // The pages each run's texts link to on the project's Confluence site (review loop spec 35).
  // Only linked pages are read, each once a round however many runs link to it; a run with no
  // links costs no request. After a failure other than a missing page the site is not asked again
  // this round.
  async #readPages(projectId: string, runs: WorkflowRun[], asked: boolean): Promise<void> {
    const { settings } = this.#deps;
    const host = await this.#deps.resolveConfluence?.(projectId);
    if (!host) return;
    const outcomes: PageReadOutcome[] = [];
    if (host.baseUrl === '') {
      for (const run of runs) {
        outcomes.push({
          runId: run.id,
          links: [],
          error: confluenceNotSetUp(['trackers.confluence.baseUrl']),
        });
      }
      this.#storePages(projectId, host.name, outcomes);
      return;
    }
    const leaveAlone = `confluence:${host.name}`;
    const until = this.#leaveAlone.get(leaveAlone);
    const waiting = !asked && until !== undefined && until > this.#clock();
    const config = host.confluence.config;
    const adapter: PageAdapter | undefined = config
      ? (this.#deps.confluenceAdapter ?? createConfluenceHost)(config, host.name, {
          timeoutMs: settings.get('trackers.requestTimeoutMs'),
          clock: this.#clock,
          ...(this.#deps.fetch ? { fetch: this.#deps.fetch } : {}),
        })
      : undefined;
    type Result = PageReadOutcome['links'][number]['result'];
    const pages = new Map<string, Promise<Result>>();
    let failure: ErrorNow | undefined;
    for (const run of runs) {
      const links: PageReadOutcome['links'] = [];
      const found: { ref: string; link: string; source: PageSource; page: PageRef }[] = [];
      for (const [source, text] of await this.#pageTexts(run)) {
        for (const link of confluenceLinksIn(text, host.baseUrl)) {
          if (!found.some((known) => known.ref === link.ref)) found.push({ ...link, source });
        }
      }
      if (found.length === 0) {
        outcomes.push({ runId: run.id, links: [], error: null });
        continue;
      }
      if (!adapter) {
        outcomes.push({
          runId: run.id,
          links: [],
          error: confluenceNotSetUp(host.confluence.missing),
        });
        continue;
      }
      // The host asked to be left alone: this run keeps what it had until the next round.
      if (waiting) continue;
      let first: ErrorNow | null = null;
      for (const { ref, link, source, page } of found) {
        const asking =
          pages.get(ref) ??
          (async (): Promise<Result> => {
            if (failure) return { ok: false, error: failure };
            try {
              return { ok: true, page: await adapter.read(page) };
            } catch (error) {
              const reason: ErrorNow =
                error instanceof HostFailure
                  ? { kind: error.kind, message: error.message, setting: error.setting }
                  : {
                      kind: 'failed',
                      message: error instanceof Error ? error.message : String(error),
                      setting: null,
                    };
              if (!(error instanceof MissingPage)) failure = reason;
              this.#deps.logger.warn('page read failed', { projectId, host: host.name, ...reason });
              return { ok: false, error: reason };
            }
          })();
        pages.set(ref, asking);
        const result = await asking;
        if (!result.ok && first === null && result.error === failure) first = result.error;
        links.push({ ref, link, source, result });
      }
      outcomes.push({ runId: run.id, links, error: first });
    }
    const wait = adapter?.waitUntil;
    if (wait) this.#leaveAlone.set(leaveAlone, wait);
    else if (!waiting) this.#leaveAlone.delete(leaveAlone);
    this.#storePages(projectId, host.name, outcomes);
  }

  #storePages(projectId: string, hostName: string, reads: PageReadOutcome[]): void {
    if (reads.length === 0) return;
    try {
      this.#deps.engine.dispatch(`pages.sync:${randomUUID()}`, {
        type: 'pages.sync',
        projectId,
        at: this.#clock().toISOString(),
        hostName,
        reads,
      });
    } catch (error) {
      if (error instanceof CommandRejected) {
        this.#deps.logger.debug('page read dropped', { projectId, reason: error.message });
      } else {
        throw error;
      }
    }
  }

  #store(
    projectId: string,
    host: HostKind,
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
        host,
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
