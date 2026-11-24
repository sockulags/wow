import {
  helperTree,
  type ServerCommand,
  type Thread,
  type UnpushedWork,
  type WorkingCopyPlan,
} from '@wow/contracts';
import { stat } from 'node:fs/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import { projects, threads, turns } from '../db/schema.js';
import type { Logger } from '../logger.js';
import { readCommit, readCurrentBranch, type GitRunOptions } from '../projects/git.js';
import type { SettingsService } from '../settings/service.js';
import {
  createThreadWorkingCopy,
  discardWorkingCopy,
  readThreadHolds,
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

// Makes and removes the working copies of chat threads (thread work spec 11 to 16). The
// orchestrator decides the folder when the thread is made and stores it as `pending`; this
// service makes the worktree there before the first turn starts, and once the thread is done
// removes it when nothing would be lost. Every outcome goes back as a command, so the thread row
// is the only state.
export class Workspaces {
  readonly #deps: WorkspacesDeps;
  // A thread's copy being made, by folder, so a fork and its origin never make it twice.
  readonly #preparingThreads = new Map<string, Promise<string | undefined>>();
  // A thread's copy being looked at or removed, by folder: a message waits for it, so its turn
  // never starts in a folder that is going.
  readonly #settlingThreads = new Map<string, Promise<void>>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #unsubscribe: () => void;

  constructor(deps: WorkspacesDeps) {
    this.#deps = deps;
    this.#unsubscribe = deps.engine.onCommit((commit) => {
      for (const { event } of commit.events) {
        if (event.kind === 'thread.stateChanged' && event.payload.state === 'done') {
          const { threadId } = event.payload;
          this.#track(() => this.#settleThread(threadId));
        }
      }
    });
  }

  // After a restart: a copy that was being made is recovered, and one whose thread was done
  // while the server was down is looked at now.
  recover(): void {
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
    const settling = this.#settlingThreads.get(copy.path);
    // After a settle or removal the row says what it left; it is read again then.
    const work = (
      settling
        ? settling.then(() => {
            const now = this.#thread(threadId);
            return now ? this.#prepareThread(now) : undefined;
          })
        : this.#prepareThread(thread)
    ).finally(() => this.#preparingThreads.delete(copy.path));
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
    const { thread, copy } = this.#threadCopy(threadId);
    if (copy.state === 'removed' || (await gone(copy.path))) {
      throw new WorkspaceRefused('The working copy is not there any more.');
    }
    const branch = copy.branch ?? thread.branch ?? '';
    const unpushed = await readThreadHolds(copy.path, copy.startSha, branch, this.#git());
    if (!unpushed) {
      throw new WorkspaceRefused('Git could not say what the working copy holds.');
    }
    return unpushed;
  }

  // "Remove working copy" of a chat thread (spec 15): only after the user saw `expect`, never
  // while a turn runs or another thread that is not done works in the folder. The branch stays.
  async removeThread(threadId: string, expect: UnpushedWork): Promise<void> {
    const { copy } = this.#threadCopy(threadId);
    if (copy.state === 'removed') return;
    if (copy.state === 'pending' || this.#preparingThreads.has(copy.path)) {
      throw new WorkspaceRefused('The working copy is still being made.');
    }
    if (this.#settlingThreads.has(copy.path)) {
      throw new WorkspaceRefused('The working copy is being looked at. Try again in a moment.');
    }
    const work = this.#removeThread(threadId, expect);
    this.#holdThreadCopy(
      copy.path,
      work.then(
        () => undefined,
        () => undefined,
      ),
    );
    return work;
  }

  async #removeThread(threadId: string, expect: UnpushedWork): Promise<void> {
    const { thread, copy } = this.#threadCopy(threadId);
    const sharing = this.#threadsSharing(copy.path);
    const refuseRunning = () => {
      const running = sharing.find((other) => this.#threadTurnRunning(other.id));
      if (running) {
        throw new WorkspaceRefused(
          running.id === thread.id
            ? 'A turn runs in this thread. Stop it, then remove the working copy.'
            : `Thread "${running.title || running.id}" is working in this working copy.`,
        );
      }
      // A helper in the folder has no copy of its own, so it is not among `sharing`; no copy goes
      // while a helper under the thread works, at any depth (orchestrator threads spec 8).
      const helper = helperTree(thread.id, (id) =>
        this.#deps.db.select().from(threads).where(eq(threads.parentThreadId, id)).all(),
      ).find(({ thread: each }) => each.state === 'working' || this.#threadTurnRunning(each.id));
      if (helper) {
        throw new WorkspaceRefused(
          `Helper "${helper.thread.title || helper.thread.id}" is working. Stop it, then remove the working copy.`,
        );
      }
    };
    refuseRunning();
    const other = sharing.find((each) => each.id !== thread.id && each.state !== 'done');
    if (other) {
      throw new WorkspaceRefused(
        `Thread "${other.title || other.id}" also works in this working copy. Mark it done first.`,
      );
    }
    const projectFolder = this.#copySource(thread);
    if (projectFolder === undefined) {
      throw new WorkspaceRefused(
        `The project of this thread no longer exists; delete ${copy.path} yourself.`,
      );
    }
    if (!(await gone(copy.path))) {
      const now = await this.threadStatus(threadId);
      if (
        now.uncommittedFiles > expect.uncommittedFiles ||
        (now.ignoredFiles ?? 0) > (expect.ignoredFiles ?? 0) ||
        (now.commitsOnNoBranch ?? 0) > (expect.commitsOnNoBranch ?? 0)
      ) {
        throw new WorkspaceChanged(
          `The working copy holds more than you were shown: ${holdsText(now)}.`,
          now,
        );
      }
      // The same counts with other files (one deleted, another made) since the dialog read it. A
      // request without the digest the server gave cannot show it saw the same files.
      if (now.digest !== undefined && now.digest !== expect.digest) {
        throw new WorkspaceChanged(
          `The working copy changed since you were shown it: ${holdsText(now)}.`,
          now,
        );
      }
    }
    // A turn that started while git was asked.
    refuseRunning();
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

  // Later than the commit that caused it.
  #track(work: () => Promise<unknown> | undefined): void {
    const tracked = Promise.resolve()
      .then(work)
      .catch((error: unknown) => {
        this.#deps.logger.error('working copy failed', error);
      });
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  async #prepareThread(thread: Thread): Promise<string | undefined> {
    const copy = thread.workingCopy;
    if (!copy) return undefined;
    const onDisk = !(await gone(copy.path));
    if (copy.state === 'ready' && onDisk) return undefined;
    const projectFolder = this.#copySource(thread);
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
          branchStart: copy.branchStart ?? null,
          beforeBranch: (startSha) => {
            for (const each of this.#threadsSharing(copy.path)) {
              this.#dispatch(`workingCopy:${each.id}:branching:${randomUUID()}`, {
                type: 'thread.workingCopyBranching',
                threadId: each.id,
                startSha,
              });
            }
          },
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

  // A copy left `pending` by a stop: taken as made when git finished it (the folder is there on
  // its branch). One git was asked to make fails, so the next message tries again: the folder
  // (named after the thread, so nothing else is in it) goes, the branch stays and is taken up by
  // that try. One git was never asked to make (no message was sent yet) stays as it is. A branch
  // is never deleted here: one that was there before the thread is the user's (spec 15).
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
          startSha: copy.branchStart ?? sha,
          defaultBranch: null,
          note: null,
        });
        return;
      }
    }
    if (!copy.branchStart) return;
    const projectFolder = this.#copySource(thread);
    if (projectFolder !== undefined) {
      await discardWorkingCopy({ projectFolder, target: copy.path, git });
      // Stopped before git made the branch: the note goes, so a branch of that name the user
      // makes later is not taken for wow's own.
      if (branch && (await readCommit(projectFolder, `refs/heads/${branch}`, git)) === null) {
        this.#dispatch(`workingCopy:${thread.id}:branching:${randomUUID()}`, {
          type: 'thread.workingCopyBranching',
          threadId: thread.id,
          startSha: null,
        });
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
    if (this.#settlingThreads.has(copy.path) || this.#preparingThreads.has(copy.path)) return;
    const sharing = this.#threadsSharing(copy.path);
    if (sharing.some((each) => each.state !== 'done' || this.#threadTurnRunning(each.id))) return;
    const projectFolder = this.#copySource(thread);
    if (projectFolder === undefined) return;
    const work = settleWorkingCopy({
      projectFolder,
      target: copy.path,
      startSha: copy.startSha,
      git: this.#git(),
      branch: copy.branch ?? thread.branch ?? '',
    }).then((outcome) => this.#reportThreads(sharing, outcome));
    this.#holdThreadCopy(
      copy.path,
      work.catch(() => undefined),
    );
    await work;
  }

  // Set before the first await, so a message that comes meanwhile waits for it.
  #holdThreadCopy(folder: string, work: Promise<void>): void {
    this.#settlingThreads.set(folder, work);
    void work.finally(() => {
      if (this.#settlingThreads.get(folder) === work) this.#settlingThreads.delete(folder);
    });
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

  // The repository a thread's own copy is a worktree of: the one a helper's copy was made from
  // (orchestrator threads spec 5), else the project's folder.
  #copySource(thread: Pick<Thread, 'projectId' | 'workingCopy'>): string | undefined {
    return (
      thread.workingCopy?.repository ??
      (thread.projectId ? this.#projectFolder(thread.projectId) : undefined)
    );
  }

  #dispatch(commandId: string, command: ServerCommand): void {
    try {
      this.#deps.engine.dispatch(commandId, command);
    } catch (error) {
      // The thread moved on meanwhile (its copy is no longer in the state the report is about).
      if (error instanceof CommandRejected) {
        this.#deps.logger.debug(`${command.type} rejected`, error.message);
        return;
      }
      throw error;
    }
  }
}

// "2 uncommitted files, 1 ignored file, 1 commit on no branch".
export function holdsText(holds: UnpushedWork): string {
  const parts = [
    holds.uncommittedFiles > 0 &&
      count(holds.uncommittedFiles, 'uncommitted file', 'uncommitted files'),
    (holds.ignoredFiles ?? 0) > 0 &&
      count(holds.ignoredFiles ?? 0, 'ignored file', 'ignored files'),
    (holds.commitsOnNoBranch ?? 0) > 0 &&
      `${count(holds.commitsOnNoBranch ?? 0, 'commit', 'commits')} on no branch`,
  ].filter((part): part is string => typeof part === 'string');
  return parts.length === 0 ? 'nothing that is not committed' : parts.join(', ');
}
