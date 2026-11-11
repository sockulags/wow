import { isLiveRunState, type ServerCommand, type WorkflowRun } from '@wow/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import { projects, threads, turns, workflowRuns } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { GitRunOptions } from '../projects/git.js';
import type { SettingsService } from '../settings/service.js';
import {
  createWorkingCopy,
  discardWorkingCopy,
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

// Makes and removes the working copies of runs (review loop spec 36 to 38). The orchestrator
// decides the folder when the run starts and stores it as `pending`; this service makes the
// worktree there before the first step gets its prompt, and after the run ended removes it when
// nothing would be lost. Every outcome goes back as a command, so the run row is the only state.
export class Workspaces {
  readonly #deps: WorkspacesDeps;
  readonly #preparing = new Map<string, Promise<string | undefined>>();
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

  #git(): GitRunOptions {
    return { timeoutMs: this.#deps.settings.get('workspaces.gitTimeoutMs'), git: this.#deps.git };
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
