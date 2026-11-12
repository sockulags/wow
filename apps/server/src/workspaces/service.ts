import {
  isLiveRunState,
  type ServerCommand,
  type Thread,
  type UnpushedWork,
  type WorkflowRun,
  type WorkingCopyPlan,
} from '@wow/contracts';
import { stat } from 'node:fs/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import { projects, threads, turns, workflowRuns } from '../db/schema.js';
import type { Logger } from '../logger.js';
import {
  readCommit,
  readCurrentBranch,
  readUnpushed,
  type GitRunOptions,
} from '../projects/git.js';
import type { SettingsService } from '../settings/service.js';
import {
  createThreadWorkingCopy,
  createWorkingCopy,
  discardWorkingCopy,
  readThreadStart,
  reopenThreadWorkingCopy,
  settleWorkingCopy,
  type Settled,
} from './working-copy.js';

export interface WorkspacesDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly settings: Pick<SettingsService, 'get' | 'resolve'>;
  readonly logger: Logger;
  // Replaces the git binary, for tests.
  readonly git?: string | undefined;
}

// The user asked for something a working copy cannot do right now; the message is theirs to read.
export class WorkspaceRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceRefused';
  }
}

// "Remove working copy" of a thread found more in the copy than the dialog showed; `holds` is
// what it holds now, for the dialog to ask again with.
export class WorkspaceChanged extends Error {
  constructor(
    message: string,
    readonly holds: UnpushedWork,
  ) {
    super(message);
    this.name = 'WorkspaceChanged';
  }
}

const gone = async (folder: string) => (await stat(folder).catch(() => undefined)) === undefined;

const count = (amount: number, one: string, many: string) =>
  `${amount} ${amount === 1 ? one : many}`;

// Makes and removes the working copies of runs (review loop spec 36 to 38). The orchestrator
// decides the folder when the run starts and stores it as `pending`; this service makes the
// worktree there before the first step gets its prompt, and after the run ended removes it when
// nothing would be lost. Every outcome goes back as a command, so the run row is the only state.
export class Workspaces {
  readonly #deps: WorkspacesDeps;
  readonly #preparing = new Map<string, Promise<string | undefined>>();
  // A thread's copy being made, by folder, so a fork and its origin never make it twice.
  readonly #preparingThreads = new Map<string, Promise<string | undefined>>();
  readonly #settling = new Set<string>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #unsubscribe: () => void;

  constructor(deps: WorkspacesDeps) {
    this.#deps = deps;
    this.#unsubscribe = deps.engine.onCommit((commit) => {
      for (const { event } of commit.events) {
        if (event.kind === 'workflowRun.changed') {
          const { run } = event.payload;
          if (run.workingCopy?.state === 'pending') this.#track(() => this.prepare(run.id));
          else if (run.workingCopy?.state === 'ready' && !isLiveRunState(run.state)) {
            this.#track(() => this.#settle(run.id));
          }
        } else if (event.kind === 'thread.stateChanged' && event.payload.state === 'done') {
          const { threadId } = event.payload;
          this.#track(() => this.#settleThread(threadId));
        } else if (event.kind === 'turn.ended') {
          // A stopped run's turn is interrupted after the run ended; its working copy is looked
          // at once the agent has let go of it.
          const { threadId } = event.payload;
          this.#track(() => {
            const thread = this.#deps.db
              .select({ runId: threads.runId })
              .from(threads)
              .where(eq(threads.id, threadId))
              .get();
            return thread?.runId ? this.#settle(thread.runId) : undefined;
          });
        }
      }
    });
  }

  // Resolves when the run's folder is there to work in: at once for a run in the project folder,
  // after the worktree is made for a run with its own. Answers the reason when it could not be
  // made; the run has failed by then.
  prepare(runId: string): Promise<string | undefined> {
    const running = this.#preparing.get(runId);
    if (running) return running;
    const run = this.#run(runId);
    const copy = run?.workingCopy;
    if (!run || !copy) return Promise.resolve(undefined);
    if (copy.state === 'failed') {
      return Promise.resolve(copy.error ?? 'The working copy could not be made');
    }
    if (copy.state !== 'pending') return Promise.resolve(undefined);
    const work = this.#create(run, copy.path, copy.branch).finally(() =>
      this.#preparing.delete(runId),
    );
    this.#preparing.set(runId, work);
    return work;
  }

  // "Remove working copy" for a run that has ended. The app has asked the user first.
  async remove(runId: string): Promise<void> {
    const run = this.#run(runId);
    const copy = run?.workingCopy;
    if (!run || !copy) throw new WorkspaceRefused(`Run ${runId} has no working copy`);
    if (copy.state === 'removed') return;
    if (isLiveRunState(run.state) || copy.state === 'pending') {
      throw new WorkspaceRefused('The run is still going. Stop it, then remove its working copy.');
    }
    const sharing = this.#sharing(copy.path);
    const busy = sharing.find((other) => this.#busy(other));
    if (busy) {
      throw new WorkspaceRefused(
        `Run ${busy.id} is still working in this working copy. Stop it, then remove the working copy.`,
      );
    }
    const projectFolder = this.#projectFolder(run.projectId);
    if (projectFolder === undefined) {
      throw new WorkspaceRefused(
        `The project of this run no longer exists; delete ${copy.path} yourself.`,
      );
    }
    const outcome = await discardWorkingCopy({
      projectFolder,
      target: copy.path,
      git: this.#git(),
    });
    // What it held is still true when it could not be removed.
    this.#reportAll(
      sharing,
      outcome.state === 'kept' ? { ...outcome, unpushed: copy.unpushed } : outcome,
    );
    if (outcome.state === 'kept') {
      throw new WorkspaceRefused(outcome.error ?? 'The working copy could not be removed');
    }
  }

  // After a restart: a working copy that was being made is not trusted (the run fails with the
  // reason) and what git made of it is taken away, and one whose run ended while the server was
  // down is looked at now.
  recover(): void {
    const rows = this.#deps.db.select().from(workflowRuns).all();
    for (const run of rows) {
      const state = run.workingCopy?.state;
      if (state === 'pending') {
        this.#dispatch(`workingCopy:${run.id}:failed`, {
          type: 'workflowRun.workingCopyFailed',
          runId: run.id,
          error: 'The server stopped while the working copy was being made',
        });
        const target = run.workingCopy?.path;
        if (target) this.#track(() => this.#discardUnfinished(run.projectId, target));
      } else if (state === 'ready' && !isLiveRunState(run.state)) {
        this.#track(() => this.#settle(run.id));
      }
    }
    for (const thread of this.#deps.db.select().from(threads).all()) {
      const copy = thread.workingCopy;
      if (copy?.state === 'pending') this.#track(() => this.#recoverThread(thread));
      else if (copy?.state === 'ready' && thread.state === 'done') {
        this.#track(() => this.#settleThread(thread.id));
      }
    }
  }

  // Resolves when a chat thread's folder is there to work in (thread work spec 11, 12, 16): at
  // once for a thread without its own copy or one that is ready, else after the worktree is made
  // on a new branch or made again on its branch. Answers the reason when it could not be; the
  // thread's copy is `failed` by then and the turn that waited fails with it.
  prepareThread(threadId: string): Promise<string | undefined> {
    const thread = this.#thread(threadId);
    const copy = thread?.workingCopy;
    if (!thread || !copy) return Promise.resolve(undefined);
    const running = this.#preparingThreads.get(copy.path);
    if (running) return running;
    const work = this.#prepareThread(thread).finally(() =>
      this.#preparingThreads.delete(copy.path),
    );
    this.#preparingThreads.set(copy.path, work);
    this.#pending.add(work);
    void work.finally(() => this.#pending.delete(work));
    return work;
  }

  // What `/chat/new` says before the thread exists (spec 10). Reads only.
  async plan(projectId: string): Promise<WorkingCopyPlan> {
    const projectFolder = this.#projectFolder(projectId);
    if (projectFolder === undefined) return { status: 'unavailable', reason: 'No such project.' };
    const scope = { projectId };
    const startSetting = this.#deps.settings.resolve('chat.workingCopyStart', scope).value;
    const start = startSetting === 'defaultBranch' ? 'defaultBranch' : 'head';
    const read = await readThreadStart(projectFolder, start, this.#git());
    if (!read.ok) return { status: 'unavailable', reason: read.error };
    const template = this.#deps.settings.resolve('chat.workingCopyBranch', scope).value;
    return {
      status: 'ok',
      on: this.#deps.settings.resolve('chat.ownWorkingCopy', scope).value === true,
      template: typeof template === 'string' ? template : '',
      start,
      from: read.from,
      sha: read.sha,
      fetch:
        read.remote &&
        this.#deps.settings.resolve('workspaces.fetchBeforeCreate', scope).value === true,
    };
  }

  // What the thread's copy holds now that would be lost with it (spec 15).
  async threadStatus(threadId: string): Promise<UnpushedWork> {
    const { copy } = this.#threadCopy(threadId);
    if (copy.state === 'removed' || (await gone(copy.path))) {
      throw new WorkspaceRefused('The working copy is not there any more.');
    }
    const unpushed = await readUnpushed(copy.path, copy.startSha, this.#git());
    if (!unpushed) {
      throw new WorkspaceRefused('Git could not say what the working copy holds.');
    }
    return unpushed;
  }

  // "Remove working copy" of a chat thread (spec 15): only after the user saw `expect`, never
  // while a turn runs or another thread that is not done works in the folder. The branch stays.
  async removeThread(threadId: string, expect: UnpushedWork): Promise<void> {
    const { thread, copy } = this.#threadCopy(threadId);
    if (copy.state === 'removed') return;
    if (copy.state === 'pending' || this.#preparingThreads.has(copy.path)) {
      throw new WorkspaceRefused('The working copy is still being made.');
    }
    const sharing = this.#threadsSharing(copy.path);
    const running = sharing.find((other) => this.#threadTurnRunning(other.id));
    if (running) {
      throw new WorkspaceRefused(
        running.id === thread.id
          ? 'A turn runs in this thread. Stop it, then remove the working copy.'
          : `Thread "${running.title || running.id}" is working in this working copy.`,
      );
    }
    const other = sharing.find((each) => each.id !== thread.id && each.state !== 'done');
    if (other) {
      throw new WorkspaceRefused(
        `Thread "${other.title || other.id}" also works in this working copy. Mark it done first.`,
      );
    }
    const projectFolder = thread.projectId ? this.#projectFolder(thread.projectId) : undefined;
    if (projectFolder === undefined) {
      throw new WorkspaceRefused(
        `The project of this thread no longer exists; delete ${copy.path} yourself.`,
      );
    }
    if (!(await gone(copy.path))) {
      const now = await this.threadStatus(threadId);
      if (
        now.uncommittedFiles > expect.uncommittedFiles ||
        (now.ignoredFiles ?? 0) > (expect.ignoredFiles ?? 0)
      ) {
        throw new WorkspaceChanged(
          `The working copy holds more than you were shown: ${holdsText(now)}.`,
          now,
        );
      }
    }
    const outcome = await discardWorkingCopy({
      projectFolder,
      target: copy.path,
      git: this.#git(),
    });
    this.#reportThreads(
      sharing,
      outcome.state === 'kept' ? { ...outcome, unpushed: copy.unpushed } : outcome,
    );
    if (outcome.state === 'kept') {
      throw new WorkspaceRefused(outcome.error ?? 'The working copy could not be removed');
    }
  }

  // Resolves once every working copy seen so far has been made or looked at.
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all(this.#pending);
  }

  async stop(): Promise<void> {
    this.#unsubscribe();
    await this.settled();
  }

  // Later than the commit that caused it, like the runner's effects.
  #track(work: () => Promise<unknown> | undefined): void {
    const tracked = Promise.resolve()
      .then(work)
      .catch((error: unknown) => {
        this.#deps.logger.error('working copy failed', error);
      });
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  async #create(
    run: WorkflowRun,
    target: string,
    branch: string | null | undefined,
  ): Promise<string | undefined> {
    const projectFolder = this.#projectFolder(run.projectId);
    const created =
      projectFolder === undefined
        ? { ok: false as const, error: 'No working copy could be made: the project is gone.' }
        : await createWorkingCopy({
            projectFolder,
            target,
            branch,
            head:
              run.event?.headSha && run.event.headRef
                ? {
                    sha: run.event.headSha,
                    ref: run.event.headRef,
                    merged: run.event.event === 'merged',
                  }
                : undefined,
            fetch:
              this.#deps.settings.resolve('workspaces.fetchBeforeCreate', {
                projectId: run.projectId,
              }).value === true,
            git: this.#git(),
          }).catch((error: unknown) => ({
            ok: false as const,
            error: `No working copy could be made: ${error instanceof Error ? error.message : String(error)}`,
          }));
    if (created.ok) {
      this.#dispatch(`workingCopy:${run.id}:ready`, {
        type: 'workflowRun.workingCopyReady',
        runId: run.id,
        startSha: created.startSha,
        defaultBranch: created.defaultBranch,
        note: created.note,
      });
      return undefined;
    }
    this.#deps.logger.warn('working copy not made', { runId: run.id, reason: created.error });
    this.#dispatch(`workingCopy:${run.id}:failed`, {
      type: 'workflowRun.workingCopyFailed',
      runId: run.id,
      error: created.error,
    });
    return created.error;
  }

  // The folder is named after the run, so nothing else is in it; no step ever worked there.
  async #discardUnfinished(projectId: string, target: string): Promise<void> {
    const projectFolder = this.#projectFolder(projectId);
    if (projectFolder === undefined) return;
    const outcome = await discardWorkingCopy({ projectFolder, target, git: this.#git() });
    if (outcome.state === 'kept') {
      this.#deps.logger.warn('unfinished working copy not removed', {
        target,
        reason: outcome.error,
      });
    }
  }

  // Looks at a working copy once no run works in it any more. A run that an event started may
  // work in the copy of the run that made the pull request, so the folder is judged once for
  // every run that names it, after the last of them has ended.
  async #settle(runId: string): Promise<void> {
    const run = this.#run(runId);
    const copy = run?.workingCopy;
    if (!run || copy?.state !== 'ready' || isLiveRunState(run.state)) return;
    if (this.#settling.has(copy.path)) return;
    const sharing = this.#sharing(copy.path);
    if (sharing.some((other) => this.#busy(other))) return;
    const projectFolder = this.#projectFolder(run.projectId);
    if (projectFolder === undefined) return;
    this.#settling.add(copy.path);
    try {
      const outcome = await settleWorkingCopy({
        projectFolder,
        target: copy.path,
        startSha: copy.startSha,
        git: this.#git(),
      });
      this.#reportAll(sharing, outcome);
    } finally {
      this.#settling.delete(copy.path);
    }
  }

  // The runs whose working copy is this folder and may still be on disk.
  #sharing(folder: string): WorkflowRun[] {
    return this.#deps.db
      .select()
      .from(workflowRuns)
      .all()
      .filter((run) => {
        const copy = run.workingCopy;
        return copy?.path === folder && copy.state !== 'removed' && copy.state !== 'failed';
      });
  }

  #busy(run: WorkflowRun): boolean {
    return (
      isLiveRunState(run.state) || run.workingCopy?.state === 'pending' || this.#turnRunning(run.id)
    );
  }

  #reportAll(runs: readonly WorkflowRun[], outcome: Settled): void {
    for (const run of runs) this.#report(run.id, outcome);
  }

  #report(runId: string, outcome: Settled): void {
    this.#dispatch(`workingCopy:${runId}:settled:${randomUUID()}`, {
      type: 'workflowRun.workingCopySettled',
      runId,
      ...outcome,
    });
  }

  #turnRunning(runId: string): boolean {
    const ids = this.#deps.db
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.runId, runId))
      .all()
      .map((thread) => thread.id);
    if (ids.length === 0) return false;
    return (
      this.#deps.db
        .select({ id: turns.id })
        .from(turns)
        .where(and(inArray(turns.threadId, ids), eq(turns.state, 'running')))
        .get() !== undefined
    );
  }

  async #prepareThread(thread: Thread): Promise<string | undefined> {
    const copy = thread.workingCopy;
    if (!copy) return undefined;
    const onDisk = !(await gone(copy.path));
    if (copy.state === 'ready' && onDisk) return undefined;
    const projectFolder = thread.projectId ? this.#projectFolder(thread.projectId) : undefined;
    const fail = (error: string) => {
      this.#deps.logger.warn('thread working copy not made', {
        threadId: thread.id,
        reason: error,
      });
      this.#dispatch(`workingCopy:${thread.id}:failed:${randomUUID()}`, {
        type: 'thread.workingCopyFailed',
        threadId: thread.id,
        error,
      });
      return error;
    };
    if (projectFolder === undefined) {
      return fail('No working copy could be made: the project is gone.');
    }
    const branch = copy.branch ?? thread.branch;
    if (!branch) return fail('No working copy could be made: the thread names no branch.');
    const git = this.#git();
    const ready = (startSha: string, defaultBranch: string | null, note: string | null) => {
      for (const each of this.#threadsSharing(copy.path)) {
        if (each.id !== thread.id && each.workingCopy?.state === 'ready') continue;
        this.#dispatch(`workingCopy:${each.id}:ready:${randomUUID()}`, {
          type: 'thread.workingCopyReady',
          threadId: each.id,
          startSha,
          defaultBranch,
          note,
        });
      }
      return undefined;
    };
    try {
      // Never made: a new branch.
      if (copy.startSha === null) {
        const projectId = thread.projectId ?? '';
        const start = this.#deps.settings.resolve('chat.workingCopyStart', { projectId }).value;
        const created = await createThreadWorkingCopy({
          projectFolder,
          target: copy.path,
          branch,
          start: start === 'defaultBranch' ? 'defaultBranch' : 'head',
          fetch:
            this.#deps.settings.resolve('workspaces.fetchBeforeCreate', { projectId }).value ===
            true,
          git,
        });
        return created.ok
          ? ready(created.startSha, created.defaultBranch, created.note)
          : fail(created.error);
      }
      // Made before: on its branch again (removed, or the folder gone), or as it is (kept).
      if (!onDisk || copy.state !== 'kept') {
        const reopened = await reopenThreadWorkingCopy({
          projectFolder,
          target: copy.path,
          branch,
          git,
        });
        if (!reopened.ok) return fail(reopened.error);
      }
      return ready(copy.startSha, copy.defaultBranch, copy.note);
    } catch (error) {
      return fail(
        `No working copy could be made: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // A copy left being made by a server stop: taken as made when git finished it (the folder is
  // there on its branch), else failed, so the next message makes it again.
  async #recoverThread(thread: Thread): Promise<void> {
    const copy = thread.workingCopy;
    const branch = copy?.branch ?? thread.branch;
    if (!copy) return;
    const git = this.#git();
    if (
      branch &&
      !(await gone(copy.path)) &&
      (await readCurrentBranch(copy.path, git)) === branch
    ) {
      const sha = await readCommit(copy.path, 'HEAD', git);
      if (sha !== null) {
        this.#dispatch(`workingCopy:${thread.id}:ready:${randomUUID()}`, {
          type: 'thread.workingCopyReady',
          threadId: thread.id,
          startSha: sha,
          defaultBranch: null,
          note: null,
        });
        return;
      }
    }
    this.#dispatch(`workingCopy:${thread.id}:failed:${randomUUID()}`, {
      type: 'thread.workingCopyFailed',
      threadId: thread.id,
      error: 'The server stopped while the working copy was being made',
    });
  }

  // Once every thread that works in the folder is done and none runs a turn (spec 14): removed
  // when no file in it would be lost; commits stay on the branch.
  async #settleThread(threadId: string): Promise<void> {
    const thread = this.#thread(threadId);
    const copy = thread?.workingCopy;
    if (!thread || !copy || (copy.state !== 'ready' && copy.state !== 'kept')) return;
    if (this.#settling.has(copy.path) || this.#preparingThreads.has(copy.path)) return;
    const sharing = this.#threadsSharing(copy.path);
    if (sharing.some((each) => each.state !== 'done' || this.#threadTurnRunning(each.id))) return;
    const projectFolder = thread.projectId ? this.#projectFolder(thread.projectId) : undefined;
    if (projectFolder === undefined) return;
    this.#settling.add(copy.path);
    try {
      const outcome = await settleWorkingCopy({
        projectFolder,
        target: copy.path,
        startSha: copy.startSha,
        git: this.#git(),
        onBranch: true,
      });
      this.#reportThreads(sharing, outcome);
    } finally {
      this.#settling.delete(copy.path);
    }
  }

  #threadsSharing(folder: string): Thread[] {
    return this.#deps.db
      .select()
      .from(threads)
      .all()
      .filter((thread) => thread.workingCopy?.path === folder);
  }

  #reportThreads(sharing: readonly Thread[], outcome: Settled): void {
    for (const thread of sharing) {
      this.#dispatch(`workingCopy:${thread.id}:settled:${randomUUID()}`, {
        type: 'thread.workingCopySettled',
        threadId: thread.id,
        ...outcome,
      });
    }
  }

  #threadTurnRunning(threadId: string): boolean {
    return (
      this.#deps.db
        .select({ id: turns.id })
        .from(turns)
        .where(and(eq(turns.threadId, threadId), eq(turns.state, 'running')))
        .get() !== undefined
    );
  }

  #thread(threadId: string): Thread | undefined {
    return this.#deps.db.select().from(threads).where(eq(threads.id, threadId)).get();
  }

  #threadCopy(threadId: string) {
    const thread = this.#thread(threadId);
    const copy = thread?.workingCopy;
    if (!thread || !copy) {
      throw new WorkspaceRefused(`Thread ${threadId} has no working copy of its own`);
    }
    return { thread, copy };
  }

  #git(): GitRunOptions {
    return {
      timeoutMs: this.#deps.settings.get('workspaces.gitTimeoutMs'),
      stopWaitMs: this.#deps.settings.get('advanced.gitStopWaitMs'),
      git: this.#deps.git,
    };
  }

  #projectFolder(projectId: string): string | undefined {
    return this.#deps.db.select().from(projects).where(eq(projects.id, projectId)).get()?.cwd;
  }

  #run(runId: string): WorkflowRun | undefined {
    return this.#deps.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
  }

  #dispatch(commandId: string, command: ServerCommand): void {
    try {
      this.#deps.engine.dispatch(commandId, command);
    } catch (error) {
      // The run moved on meanwhile (its copy is no longer in the state the report is about).
      if (error instanceof CommandRejected) {
        this.#deps.logger.debug(`${command.type} rejected`, error.message);
        return;
      }
      throw error;
    }
  }
}

// "2 uncommitted files, 1 ignored file".
export function holdsText(holds: UnpushedWork): string {
  const parts = [
    holds.uncommittedFiles > 0 &&
      count(holds.uncommittedFiles, 'uncommitted file', 'uncommitted files'),
    (holds.ignoredFiles ?? 0) > 0 &&
      count(holds.ignoredFiles ?? 0, 'ignored file', 'ignored files'),
  ].filter((part): part is string => typeof part === 'string');
  return parts.length === 0 ? 'nothing that is not committed' : parts.join(', ');
}
