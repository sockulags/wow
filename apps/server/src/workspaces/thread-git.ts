import {
  changeRequestWords,
  fillTemplate,
  gitHubWebBase,
  isTurnSnapshot,
  recogniseHostRef,
  splitProposal,
  type BranchCommit,
  type CodeHostKind,
  type CommitFile,
  type CommitParams,
  type CommitPlan,
  type CommitRefusal,
  type CommitResult,
  type ExistingRequest,
  type HostItemRef,
  type OpenPullRequestParams,
  type OpenPullRequestResult,
  type ProposeParams,
  type ProposeResult,
  type PullRequestPlan,
  type PullRequestPlanParams,
  type PullRequestRefusal,
} from '@wow/contracts';
import { desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Engine } from '../core/engine.js';
import type { Db } from '../db/database.js';
import { threads, turns } from '../db/schema.js';
import { HostFailure, type HostAdapter } from '../hosts/adapter.js';
import { createGitHubHost } from '../hosts/github.js';
import { createGitLabHost } from '../hosts/gitlab.js';
import type { Logger } from '../logger.js';
import {
  checkBranchName,
  commitPaths,
  countCommitsAhead,
  hashSnapshotFiles,
  listCommitsAhead,
  listPathsAhead,
  listRemoteBranches,
  pushBranch,
  readCommit,
  readCommitHooks,
  readCurrentBranch,
  readFilesPatch,
  readFolderGit,
  readHeadCommit,
  readHeadLineCounts,
  readHeadSubject,
  readOperationInProgress,
  readRangePatch,
  readRemoteDefaultBranch,
  readSnapshotTree,
  readStatusFiles,
  readUpstreamRemote,
  switchToNewBranch,
  type GitRunOptions,
  type HookGitOptions,
  type StartGit,
  type StatusEntry,
} from '../projects/git.js';
import type { SettingsService } from '../settings/service.js';
import type { LinkHosts, ProjectGitHubHost, ProjectGitLabHost } from '../trackers/service.js';
import { changesOptions, readThreadDiff } from '../workflows/changes.js';

// Commit and pull request from a chat thread's Changes (thread work spec 27 to 36). Everything
// here runs on the user's click in the commit and pull request dialogs: the RPC handlers are its
// only callers, the assistant has no tool for any of it, and no trigger, workflow or agent
// reaches it. Commit and push run the repository's hooks (the one place wow runs a program the
// repository names); push uses Git's own credentials and never asks; the host token goes only in
// the host request's header. wow never amends, merges, rebases, pulls, forces or deletes a branch.

export interface ThreadGitDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly settings: SettingsService;
  readonly logger: Logger;
  // wow's own folder, where the empty folder a proposal runs in lives.
  readonly home: string;
  readonly trackers: {
    githubHost(projectId: string): Promise<ProjectGitHubHost | undefined>;
    gitlabHost(projectId: string): Promise<ProjectGitLabHost | undefined>;
    linkHosts(projectId: string | null, tokens: 'stored'): Promise<LinkHosts>;
  };
  // The thread's snapshots (U3), to tell the thread's changes from the user's.
  readonly snapshots: { storeOf(folder: string): string; idle(): Promise<void> };
  readonly propose: (
    threadId: string,
    request: { readonly proposalId: string; readonly cwd: string; readonly prompt: string },
    timeoutMs: number,
    signal: AbortSignal,
  ) => Promise<string>;
  readonly fetch?: typeof fetch | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  // For tests: starts git (to see every argument list and environment) and the environment the
  // hook commands start from.
  readonly startGit?: StartGit | undefined;
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
}

// A refusal with its reason in words and what the dialog shows with it, answered as `rejected`.
export class ThreadGitRefused extends Error {
  constructor(
    message: string,
    readonly data: CommitRefusal | PullRequestRefusal,
  ) {
    super(message);
    this.name = 'ThreadGitRefused';
  }
}

const commitRefused = (reason: string, output = ''): ThreadGitRefused =>
  new ThreadGitRefused(reason, { reason, output });
const openRefused = (reason: string, output = '', pushed = false): ThreadGitRefused =>
  new ThreadGitRefused(reason, { reason, output, pushed });

type ThreadRow = typeof threads.$inferSelect;

// The folder a proposal runs in: empty, so the model finds nothing to read there and no
// instruction file a provider would pick up. Not a setting, as the assistant's folder is not.
const proposalFolderName = 'proposals';

const fileStatusOf = (entry: StatusEntry): CommitFile['status'] =>
  entry.untracked || entry.index === 'A'
    ? 'added'
    : entry.index === 'D' || entry.worktree === 'D'
      ? 'deleted'
      : 'modified';

const statusLetter = { added: 'A', deleted: 'D', modified: 'M', renamed: 'R' } as const;

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

// Lines of a new file Git does not know yet, when it is text and not larger than `maxBytes`.
async function newFileLines(file: string, maxBytes: number): Promise<number | null> {
  const found = await lstat(file).catch(() => undefined);
  if (!found?.isFile() || found.size > maxBytes) return null;
  const bytes = await readFile(file).catch(() => undefined);
  if (!bytes || bytes.includes(0)) return null;
  if (bytes.length === 0) return 0;
  const text = bytes.toString('utf8');
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

// A diff cut at `maxBytes`, saying so, for a proposal (spec 28).
function cut(patch: string, maxBytes: number): string {
  if (Buffer.byteLength(patch, 'utf8') <= maxBytes) return patch;
  const kept = Buffer.from(patch, 'utf8').subarray(0, maxBytes).toString('utf8');
  return `${kept}\n[The diff is longer than this and was cut here.]`;
}

interface CodeHost {
  readonly kind: CodeHostKind;
  readonly name: string;
  readonly repository: string;
  // The host's web address, without a trailing slash.
  readonly site: string;
  readonly adapter: HostAdapter | undefined;
  readonly missing: string | null;
}

export class ThreadGit {
  readonly #deps: ThreadGitDeps;
  readonly #clock: () => Date;
  // One commit or push per thread at a time, so a double press does it once.
  readonly #busy = new Set<string>();
  readonly #proposals = new Map<string, AbortController>();

  constructor(deps: ThreadGitDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? (() => new Date());
  }

  #git(timeoutMs = this.#deps.settings.get('trackers.gitTimeoutMs')): GitRunOptions {
    return {
      timeoutMs,
      stopWaitMs: this.#deps.settings.get('advanced.gitStopWaitMs'),
      ...(this.#deps.startGit ? { start: this.#deps.startGit } : {}),
    };
  }

  #hookGit(timeoutMs: number): HookGitOptions {
    return {
      ...this.#git(timeoutMs),
      outputMaxBytes: this.#deps.settings.get('chat.commitOutputMaxBytes'),
      baseEnv: this.#deps.baseEnv,
    };
  }

  // A chat thread of the user's: never a workflow step's thread (whose copy may be at a fork's
  // head) and never the assistant's (thread work Security).
  #thread(threadId: string): ThreadRow {
    const thread = this.#deps.db.select().from(threads).where(eq(threads.id, threadId)).get();
    if (!thread) throw commitRefused(`No thread ${threadId}`);
    if (thread.kind !== 'chat' || thread.runId !== null) {
      throw commitRefused(
        "Only a chat thread commits from its Changes; a step's work is its run's.",
      );
    }
    return thread;
  }

  #lastTurn(threadId: string) {
    return this.#deps.db
      .select({ state: turns.state, endSnapshot: turns.endSnapshot })
      .from(turns)
      .where(eq(turns.threadId, threadId))
      .orderBy(desc(turns.index))
      .get();
  }

  #running(threadId: string): boolean {
    return this.#lastTurn(threadId)?.state === 'running';
  }

  // The files that changed after the thread's last turn ended: their content now differs from
  // that turn's end snapshot. Undefined when there is no snapshot to tell by.
  async #changedSinceLastTurn(
    thread: ThreadRow,
    entries: readonly StatusEntry[],
  ): Promise<Set<string> | undefined> {
    // An end snapshot still being taken is waited for, so the turn's own files are not taken
    // for the user's.
    await this.#deps.snapshots.idle();
    const snapshot = this.#lastTurn(thread.id)?.endSnapshot;
    if (!isTurnSnapshot(snapshot)) return undefined;
    const store = this.#deps.snapshots.storeOf(thread.cwd);
    const git = this.#git(this.#deps.settings.get('chat.snapshotTimeoutMs'));
    const tree = await readSnapshotTree(store, snapshot.tree, 64 * 1024 * 1024, git);
    if (!tree.ok) return undefined;
    const kept = new Map(tree.entries.map((entry) => [entry.path, entry.id]));
    const present: string[] = [];
    const changed = new Set<string>();
    for (const entry of entries) {
      const found = await lstat(path.join(thread.cwd, ...entry.path.split('/'))).catch(
        () => undefined,
      );
      if (found?.isFile()) present.push(entry.path);
      // Gone now and kept then, or anything else that is not a plain file: not the thread's.
      else if (kept.has(entry.path) || found) changed.add(entry.path);
    }
    const hashed = await hashSnapshotFiles(store, thread.cwd, present, git);
    if (!hashed.ok) return undefined;
    for (const [index, file] of present.entries()) {
      if (kept.get(file) !== hashed.ids[index]) changed.add(file);
    }
    return changed;
  }

  // The commit dialog (spec 27, 30): every changed, deleted and new file of the folder Git does
  // not ignore, the thread's own ticked, the branch, and the hooks that will run.
  async commitPlan(threadId: string): Promise<CommitPlan> {
    const thread = this.#thread(threadId);
    const git = this.#git();
    const empty: CommitPlan = {
      status: 'ok',
      message: null,
      branch: null,
      head: null,
      hooks: [],
      hooksPath: null,
      files: [],
      omitted: 0,
    };
    const head = await readHeadCommit(thread.cwd, git);
    if (head.status !== 'ok' && head.status !== 'noCommit') {
      return {
        ...empty,
        status: head.status,
        message:
          head.message ??
          (head.status === 'folderMissing'
            ? "The thread's folder is no longer there."
            : head.status === 'gitUnavailable'
              ? 'Git is not on the PATH of the wow server.'
              : "The thread's folder is not in a Git repository."),
      };
    }
    const sha = head.status === 'ok' ? head.sha : null;
    const [status, branch, hooks, operation] = await Promise.all([
      readStatusFiles(thread.cwd, git),
      readCurrentBranch(thread.cwd, git),
      readCommitHooks(thread.cwd, git, this.#deps.platform),
      readOperationInProgress(thread.cwd, git),
    ]);
    if (!status.ok) return { ...empty, status: 'failed', message: status.message };
    const options = changesOptions(this.#deps.settings);
    const [counts, diff, changedAfter] = await Promise.all([
      readHeadLineCounts(thread.cwd, sha, git),
      thread.baseSha === null
        ? undefined
        : readThreadDiff({
            folder: thread.cwd,
            baseSha: thread.baseSha,
            baseFiles: thread.baseFiles,
            mark: null,
            options,
          }),
      this.#running(thread.id) ? undefined : this.#changedSinceLastTurn(thread, status.entries),
    ]);
    const own = new Set(diff?.status === 'ok' ? diff.files.map((file) => file.path) : []);
    const listed = status.entries
      .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, options.maxFiles);
    const files: CommitFile[] = [];
    for (const entry of listed) {
      const count = counts.get(entry.path);
      const lines = entry.untracked
        ? await newFileLines(path.join(thread.cwd, ...entry.path.split('/')), options.maxFileBytes)
        : null;
      files.push({
        path: entry.path,
        oldPath: entry.oldPath,
        status: fileStatusOf(entry),
        added: entry.untracked ? lines : (count?.added ?? null),
        removed: entry.untracked ? (lines === null ? null : 0) : (count?.removed ?? null),
        inThread: own.has(entry.path) && !(changedAfter?.has(entry.path) ?? false),
        staged: !entry.untracked && entry.index !== '.',
      });
    }
    const plan: CommitPlan = {
      ...empty,
      branch,
      head: sha?.slice(0, 7) ?? null,
      hooks: hooks.hooks,
      hooksPath: hooks.hooksPath,
      files,
      omitted: status.entries.length - listed.length,
    };
    if (this.#running(thread.id)) {
      return {
        ...plan,
        status: 'turnRunning',
        message: 'A turn is running in this thread. Commit once it has ended.',
      };
    }
    if (operation !== null) {
      return {
        ...plan,
        status: 'operationInProgress',
        message: `The folder is in the middle of ${operation}. Finish or stop it in a terminal, then commit.`,
      };
    }
    return plan;
  }

  async #once<T>(threadId: string, work: () => Promise<T>, refused: (reason: string) => Error) {
    if (this.#busy.has(threadId)) {
      throw refused('A commit or push of this thread is still running.');
    }
    this.#busy.add(threadId);
    try {
      return await work();
    } finally {
      this.#busy.delete(threadId);
    }
  }

  // Commit (spec 29, 30): exactly the ticked files, with the user's identity and the repository's
  // hooks, never `--no-verify`. The line goes into the conversation after it.
  commit(params: CommitParams): Promise<CommitResult> {
    return this.#once(params.threadId, () => this.#commit(params), commitRefused);
  }

  async #commit(params: CommitParams): Promise<CommitResult> {
    const thread = this.#thread(params.threadId);
    const message = params.message.trim();
    if (params.files.length === 0) throw commitRefused('Tick at least one file to commit.');
    if (message === '') throw commitRefused('Write a commit message first.');
    const plan = await this.commitPlan(thread.id);
    if (plan.status !== 'ok') throw commitRefused(plan.message ?? 'The folder cannot commit now.');
    const git = this.#git();
    const status = await readStatusFiles(thread.cwd, git);
    if (!status.ok) throw commitRefused(`Git could not read the folder: ${status.message}`);
    const byPath = new Map(status.entries.map((entry) => [entry.path, entry]));
    const chosen: StatusEntry[] = [];
    for (const file of [...new Set(params.files)].toSorted()) {
      const entry = byPath.get(file);
      if (!entry) throw commitRefused(`${file} has no change to commit any more.`);
      if (entry.unmerged) throw commitRefused(`${file} has a conflict Git has not resolved.`);
      chosen.push(entry);
    }
    let branch = plan.branch;
    if (branch === null) {
      const wanted = params.newBranch?.trim() ?? '';
      if (wanted === '') {
        throw commitRefused('The folder is on no branch. Name a new branch for the commit.');
      }
      const valid = await checkBranchName(thread.cwd, wanted, git);
      if (!valid.ok) throw commitRefused(valid.message);
      if ((await readCommit(thread.cwd, `refs/heads/${wanted}`, git)) !== null) {
        throw commitRefused(`A branch ${wanted} exists already. Name another one.`);
      }
      const made = await switchToNewBranch(thread.cwd, wanted, git);
      if (!made.ok) throw commitRefused(`Git did not make the branch: ${made.message}`);
      branch = wanted;
    }
    const committed = await commitPaths(
      thread.cwd,
      {
        paths: chosen.map((entry) => entry.path),
        newPaths: chosen.filter((entry) => entry.untracked).map((entry) => entry.path),
        message: `${message}\n`,
      },
      this.#hookGit(this.#deps.settings.get('chat.commitTimeoutMs')),
    );
    if (!committed.ok) {
      throw commitRefused(
        plan.hooks.length > 0
          ? `Nothing was committed: ${committed.message}`
          : `Git did not commit: ${committed.message}`,
        committed.output,
      );
    }
    if ('note' in committed) this.#deps.logger.warn(committed.note, { threadId: thread.id });
    const made = await readHeadSubject(thread.cwd, git);
    const result = {
      sha: made?.sha ?? '',
      subject: made?.subject ?? message.split('\n')[0] ?? '',
      ...('note' in committed ? { note: committed.note } : {}),
    };
    this.#record({
      type: 'thread.committed',
      threadId: thread.id,
      commit: {
        sha: result.sha,
        subject: result.subject,
        files: chosen.map((entry) => entry.path),
        branch,
        at: this.#clock().toISOString(),
      },
    });
    return result;
  }

  #record(
    command:
      | Extract<Parameters<Engine['dispatch']>[1], { type: 'thread.committed' }>
      | Extract<Parameters<Engine['dispatch']>[1], { type: 'thread.changeRequestOpened' }>,
  ): void {
    try {
      this.#deps.engine.dispatch(`thread-git:${randomUUID()}`, command);
    } catch (error) {
      // The commit or the request is made; only its line is missing.
      this.#deps.logger.warn('the line of a commit or pull request was not stored', error);
    }
  }

  async #codeHost(projectId: string | null): Promise<CodeHost | undefined> {
    if (projectId === null) return undefined;
    const { settings } = this.#deps;
    const options = {
      timeoutMs: settings.get('trackers.requestTimeoutMs'),
      listFallbackCount: settings.get('hosts.listFallbackCount'),
      longestWaitMs: settings.get('hosts.longestWaitMinutes') * 60_000,
      clock: this.#clock,
      ...(this.#deps.fetch ? { fetch: this.#deps.fetch } : {}),
    };
    const gitlab = await this.#deps.trackers.gitlabHost(projectId);
    if (gitlab) {
      const { config, missing } = gitlab.gitlab;
      const site = String(settings.get('trackers.gitlab.baseUrl', { projectId })).replace(
        /\/+$/,
        '',
      );
      return {
        kind: 'gitlab',
        name: gitlab.name,
        repository: config?.projectPath ?? '',
        site,
        adapter: config ? createGitLabHost(config, gitlab.name, options) : undefined,
        missing: missing[0] ?? null,
      };
    }
    const github = await this.#deps.trackers.githubHost(projectId);
    if (!github) return undefined;
    const { config, missing } = github.github;
    return {
      kind: 'github',
      name: github.name,
      repository: config ? `${config.owner}/${config.repo}` : '',
      site: config ? gitHubWebBase(config.baseUrl) : '',
      adapter: config ? createGitHubHost(config, github.name, options) : undefined,
      missing: missing[0] ?? null,
    };
  }

  // The item a chat link to the request would be, so its chip opens the same tab.
  async #itemRef(
    projectId: string | null,
    host: CodeHost,
    number: number,
    url: string,
  ): Promise<HostItemRef> {
    const rules = await this.#deps.trackers
      .linkHosts(projectId, 'stored')
      .then((hosts) => hosts.rules)
      .catch(() => undefined);
    const known = rules && recogniseHostRef(url, rules);
    if (known?.kind === 'changeRequest') return known;
    return {
      host: host.kind,
      kind: 'changeRequest',
      site: host.site,
      path: host.repository,
      id: String(number),
      url,
    };
  }

  // The pull request dialog (spec 31, 33): where it would go and from what, or why not. Pushes
  // nothing; the host is asked whether a request is open for the branch and whether it is
  // protected.
  async pullRequestPlan(params: PullRequestPlanParams): Promise<PullRequestPlan> {
    return (await this.#pullRequestPlan(params)).plan;
  }

  async #pullRequestPlan(params: PullRequestPlanParams): Promise<{
    readonly plan: PullRequestPlan;
    readonly thread: ThreadRow;
    readonly host?: CodeHost | undefined;
  }> {
    const thread = this.#thread(params.threadId);
    const git = this.#git();
    let plan: PullRequestPlan = {
      status: 'ok',
      message: null,
      host: null,
      hostName: '',
      repository: '',
      remote: null,
      branch: null,
      target: null,
      branches: [],
      commits: [],
      title: '',
      body: '',
      draft:
        thread.projectId === null
          ? false
          : this.#deps.settings.get('chat.pullRequestDraft', { projectId: thread.projectId }),
      existing: null,
      missing: null,
    };
    const stop = (status: PullRequestPlan['status'], message: string) => ({
      plan: { ...plan, status, message },
      thread,
    });
    const head = await readHeadCommit(thread.cwd, git);
    if (head.status === 'folderMissing') {
      return stop('folderMissing', "The thread's folder is no longer there.");
    }
    if (head.status === 'gitUnavailable') {
      return stop('gitUnavailable', 'Git is not on the PATH of the wow server.');
    }
    if (head.status === 'noRepository') {
      return stop('noRepository', "The thread's folder is not in a Git repository.");
    }
    if (head.status === 'noCommit') return stop('noCommits', 'The repository has no commit yet.');
    const branch = await readCurrentBranch(thread.cwd, git);
    plan = { ...plan, branch };
    if (branch === null) {
      return stop('noBranch', 'The folder is on no branch. Commit on a new branch first.');
    }
    const folder = await readFolderGit(thread.cwd, git);
    const remote =
      (await readUpstreamRemote(thread.cwd, branch, git)) ??
      (folder.primary === null ? null : folder.primary);
    plan = { ...plan, remote };
    if (remote === null) {
      return stop('noRemote', 'The repository has no remote to push the branch to.');
    }
    const host = await this.#codeHost(thread.projectId);
    if (host) {
      plan = {
        ...plan,
        host: host.kind,
        hostName: host.name,
        repository: host.repository,
        missing: host.missing,
      };
    }
    const noun = changeRequestWords[host?.kind ?? 'github'].noun;
    if (!host?.adapter) {
      const missing = host?.missing ?? 'trackers.github.token';
      return {
        plan: {
          ...plan,
          status: 'notSetUp',
          missing,
          message:
            thread.projectId === null
              ? `This thread has no project, so wow has no GitHub or GitLab settings to open a ${noun} with.`
              : `wow cannot open a ${noun} for this project: fill in ${missing} in Settings → Trackers or in the project's own trackers.`,
        },
        thread,
        host,
      };
    }
    const branches = await listRemoteBranches(thread.cwd, remote, git);
    const fallback = branches.includes('main')
      ? 'main'
      : branches.includes('master')
        ? 'master'
        : (branches[0] ?? null);
    const defaultBranch = (await readRemoteDefaultBranch(thread.cwd, remote, git)) ?? fallback;
    const target = params.target ?? defaultBranch;
    plan = { ...plan, branches, target };
    if (target === null) {
      return {
        ...stop('noTarget', `wow knows no branch of ${remote}; fetch it in a terminal.`),
        host,
      };
    }
    if (target === branch) {
      return {
        ...stop(
          'isTarget',
          `The folder is on ${target}, the branch the ${noun} would go into. Commit on a branch of its own.`,
        ),
        host,
      };
    }
    // Whatever the target, wow never pushes the branch a remote treats as its default.
    if (branch === defaultBranch) {
      return {
        ...stop(
          'isTarget',
          `The folder is on ${branch}, the default branch of ${remote}, and wow never pushes that. Commit on a branch of its own.`,
        ),
        host,
      };
    }
    const base = branches.includes(target) ? `refs/remotes/${remote}/${target}` : null;
    if (base === null) {
      return {
        ...stop(
          'noTarget',
          `${remote} has no branch ${target} that wow knows of; fetch it in a terminal or pick another.`,
        ),
        host,
      };
    }
    const commits: BranchCommit[] = (await listCommitsAhead(thread.cwd, base, 'HEAD', git)) ?? [];
    const newest = commits[0];
    plan = {
      ...plan,
      commits,
      title: newest?.subject ?? '',
      body:
        commits.length === 1
          ? (newest?.body ?? '')
          : commits
              .toReversed()
              .map((commit) => [commit.subject, commit.body].filter(Boolean).join('\n\n'))
              .join('\n\n'),
    };
    let existing: ExistingRequest | null = null;
    try {
      const found = await host.adapter.findForBranch(branch);
      if (found?.state === 'open') {
        const pushedRef = branches.includes(branch) ? `refs/remotes/${remote}/${branch}` : null;
        existing = {
          number: found.number,
          title: found.title,
          url: found.url,
          ref: await this.#itemRef(thread.projectId, host, found.number, found.url),
          unpushed: (await countCommitsAhead(thread.cwd, pushedRef, 'HEAD', git)) ?? 0,
        };
      }
    } catch (error) {
      return {
        ...stop('failed', error instanceof Error ? error.message : String(error)),
        host,
      };
    }
    plan = { ...plan, existing };
    const { mark } = changeRequestWords[host.kind];
    if (existing) {
      return {
        ...stop(
          'existing',
          `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${mark}${existing.number} is open for ${branch}.`,
        ),
        host,
      };
    }
    if (commits.length === 0) {
      return {
        ...stop('noCommits', `${branch} has no commit that ${target} does not have.`),
        host,
      };
    }
    try {
      if (await host.adapter.branchProtected?.(branch)) {
        return {
          ...stop('protected', `${host.name} protects ${branch}, so it cannot be pushed to.`),
          host,
        };
      }
    } catch (error) {
      return { ...stop('failed', error instanceof Error ? error.message : String(error)), host };
    }
    if (this.#running(thread.id)) {
      return {
        ...stop(
          'turnRunning',
          `A turn is running in this thread. Open the ${noun} once it has ended.`,
        ),
        host,
      };
    }
    return { plan, thread, host };
  }

  async #push(thread: ThreadRow, remote: string, branch: string): Promise<void> {
    const pushed = await pushBranch(
      thread.cwd,
      remote,
      branch,
      this.#hookGit(this.#deps.settings.get('chat.pushTimeoutMs')),
    );
    if (pushed.ok) return;
    throw openRefused(
      pushed.needsCredentials
        ? `Git would have to ask for a password or a passphrase to push to ${remote}, and wow never waits for one. Push once in a terminal (git push -u ${remote} ${branch}), then try again.`
        : `Git did not push ${branch}: ${pushed.message}`,
      pushed.output,
    );
  }

  // Open (spec 32 to 34): pushes the branch, then opens the request with the host's token.
  openPullRequest(params: OpenPullRequestParams): Promise<OpenPullRequestResult> {
    return this.#once(params.threadId, () => this.#open(params), openRefused);
  }

  async #open(params: OpenPullRequestParams): Promise<OpenPullRequestResult> {
    const title = params.title.trim();
    const { plan, thread, host } = await this.#pullRequestPlan({
      threadId: params.threadId,
      target: params.target,
    });
    if (plan.status !== 'ok' || !host?.adapter?.openChangeRequest) {
      throw openRefused(plan.message ?? 'wow cannot open it for this thread.');
    }
    if (title === '') throw openRefused('Write a title first.');
    const remote = plan.remote ?? '';
    const branch = plan.branch ?? '';
    await this.#push(thread, remote, branch);
    const { noun, mark } = changeRequestWords[host.kind];
    let opened: { number: number; url: string };
    try {
      opened = await host.adapter.openChangeRequest({
        head: branch,
        base: params.target,
        title,
        body: params.body,
        draft: params.draft,
      });
    } catch (error) {
      const reason =
        error instanceof HostFailure || error instanceof Error ? error.message : String(error);
      throw openRefused(
        `${host.name} did not open the ${noun}: ${reason}. ${branch} is pushed; Open can be tried again.`,
        '',
        true,
      );
    }
    this.#record({
      type: 'thread.changeRequestOpened',
      threadId: thread.id,
      request: {
        ref: await this.#itemRef(thread.projectId, host, opened.number, opened.url),
        number: opened.number,
        title,
        url: opened.url,
        at: this.#clock().toISOString(),
      },
    });
    this.#deps.logger.info(`opened ${noun} ${mark}${opened.number}`, { host: host.kind });
    return opened;
  }

  // "Push the new commits" (spec 33): pushes to the request already open for the branch.
  pushBranch(threadId: string): Promise<{ remote: string; branch: string }> {
    return this.#once(threadId, () => this.#pushNew(threadId), openRefused);
  }

  async #pushNew(threadId: string): Promise<{ remote: string; branch: string }> {
    const { plan, thread } = await this.#pullRequestPlan({ threadId });
    if (plan.status !== 'existing' || !plan.existing) {
      throw openRefused(plan.message ?? 'No pull request is open for this branch.');
    }
    if (plan.existing.unpushed === 0) throw openRefused('The remote branch has every commit.');
    if (this.#running(thread.id)) {
      throw openRefused('A turn is running in this thread. Push once it has ended.');
    }
    const remote = plan.remote ?? '';
    const branch = plan.branch ?? '';
    await this.#push(thread, remote, branch);
    return { remote, branch };
  }

  // The empty folder a proposal runs in; refused when something was put there.
  async #proposalFolder(): Promise<string> {
    const folder = path.join(this.#deps.home, proposalFolderName);
    await mkdir(folder, { recursive: true });
    const found = await readdir(folder);
    if (found.length > 0) {
      throw commitRefused(
        `The folder ${folder} must be empty for a proposal and holds ${plural(found.length, 'file')}. Move them away.`,
      );
    }
    return folder;
  }

  // "Propose" (spec 28, 31): the chosen files' diff, or the pull request's commits and diff, and
  // the thread's title through the template, to the thread's model outside its conversation.
  async propose(params: ProposeParams): Promise<ProposeResult> {
    const thread = this.#thread(params.threadId);
    const { settings } = this.#deps;
    const context = thread.projectId === null ? {} : { projectId: thread.projectId };
    const maxBytes = settings.get('chat.proposalPatchMaxBytes');
    const git = this.#git();
    let prompt: string;
    if (params.purpose === 'commitMessage') {
      const plan = await this.commitPlan(thread.id);
      const wanted = new Set(
        params.files ?? plan.files.filter((file) => file.inThread).map((file) => file.path),
      );
      const files = plan.files.filter((file) => wanted.has(file.path));
      if (files.length === 0)
        throw commitRefused('Tick at least one file to propose a message for.');
      const head = plan.head === null ? null : 'HEAD';
      const tracked = files.filter((file) => file.status !== 'added' || file.staged);
      let patch =
        (await readFilesPatch(
          thread.cwd,
          head,
          tracked.map((file) => file.path),
          git,
        )) ?? '';
      for (const file of files.filter((entry) => entry.status === 'added' && !entry.staged)) {
        // A link is not followed: its target may be anywhere on the machine.
        const onDisk = path.join(thread.cwd, ...file.path.split('/'));
        const found = await lstat(onDisk).catch(() => undefined);
        if (!found?.isFile()) continue;
        const bytes = await readFile(onDisk).catch(() => undefined);
        if (!bytes || bytes.includes(0)) continue;
        const lines = bytes.toString('utf8').replace(/\n$/, '').split('\n');
        patch += `--- /dev/null\n+++ b/${file.path}\n${lines.map((line) => `+${line}`).join('\n')}\n`;
        if (Buffer.byteLength(patch, 'utf8') > maxBytes) break;
      }
      prompt = fillTemplate(settings.get('chat.commitMessageTemplate', context), {
        title: thread.title,
        files: files.map((file) => `${statusLetter[file.status]} ${file.path}`).join('\n'),
        patch: cut(patch, maxBytes),
      });
    } else {
      const { plan } = await this.#pullRequestPlan({
        threadId: thread.id,
        ...(params.target ? { target: params.target } : {}),
      });
      if (plan.commits.length === 0 || plan.remote === null || plan.target === null) {
        throw openRefused(plan.message ?? 'There is no commit to write about.');
      }
      const base = `refs/remotes/${plan.remote}/${plan.target}`;
      const [paths, patch] = await Promise.all([
        listPathsAhead(thread.cwd, base, 'HEAD', git),
        readRangePatch(thread.cwd, base, 'HEAD', git),
      ]);
      prompt = fillTemplate(settings.get('chat.pullRequestTemplate', context), {
        title: thread.title,
        commits: plan.commits
          .toReversed()
          .map((commit) => [commit.subject, commit.body].filter(Boolean).join('\n'))
          .join('\n\n'),
        files: paths.join('\n'),
        patch: cut(patch ?? '', maxBytes),
      });
    }
    const cwd = await this.#proposalFolder();
    const abort = new AbortController();
    this.#proposals.get(params.requestId)?.abort();
    this.#proposals.set(params.requestId, abort);
    try {
      const text = await this.#deps.propose(
        thread.id,
        { proposalId: params.requestId, cwd, prompt },
        settings.get('chat.proposalTimeoutMs'),
        abort.signal,
      );
      if (params.purpose === 'commitMessage') return { text: splitProposalText(text) };
      return splitProposal(text);
    } finally {
      if (this.#proposals.get(params.requestId) === abort) this.#proposals.delete(params.requestId);
    }
  }

  cancelProposal(requestId: string): boolean {
    const running = this.#proposals.get(requestId);
    if (!running) return false;
    running.abort();
    this.#proposals.delete(requestId);
    return true;
  }
}

// A commit message as the model wrote it, without a fence around it.
function splitProposalText(text: string): string {
  const { title, body } = splitProposal(text);
  return body === '' ? title : `${title}\n\n${body}`;
}
