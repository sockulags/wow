import {
  runFolder,
  type FileHash,
  type RunEffect,
  type ServerCommand,
  type TurnState,
  type WorkflowRun,
} from '@wow/contracts';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ruleAsksAbout } from '@wow/workflow-engine';
import type { Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import { projects, threadItems, threads, turns, workflowRuns, workflows } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { ArtifactDetector } from './artifacts.js';
import type { RunBase } from './changes.js';

// Reads the run's folder through git for the Changes tab; both answer undefined when git cannot
// say (not a repository, not installed, timed out).
export interface RunChanges {
  base(folder: string): Promise<RunBase | undefined>;
  // The commit the folder is on, or undefined when it has none or git cannot say.
  head?(folder: string): Promise<string | undefined>;
  snapshot(folder: string, baseSha: string): Promise<FileHash[] | undefined>;
}

export type RunNotification = Extract<RunEffect, { type: 'notify' }>;
export type RunNotificationListener = (notification: RunNotification) => void;

export interface RunnerDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly detectArtifacts: ArtifactDetector;
  readonly changes: RunChanges;
  // Resolves when the run's folder is there to work in, or with the reason it could not be made
  // (the run has failed by then). Runs in the project folder resolve at once.
  readonly prepare?: (runId: string) => Promise<string | undefined>;
  readonly logger: Logger;
}

interface EndedTurn {
  readonly id: string;
  readonly state: Exclude<TurnState, 'running'>;
}

// Performs the effects of committed run transitions through the thread commands, so a step's
// turn goes to its provider like any other turn (the provider service sends it). A step ends when
// the persisted turn of its thread ends; that outcome goes back to the engine as a command, so the
// run only changes through the engine.
export class WorkflowRunner {
  readonly #deps: RunnerDeps;
  readonly #listeners = new Set<RunNotificationListener>();
  readonly #pending = new Set<Promise<void>>();
  readonly #unsubscribe: () => void;

  constructor(deps: RunnerDeps) {
    this.#deps = deps;
    this.#unsubscribe = deps.engine.onCommit((commit) => {
      for (const { event } of commit.events) {
        if (event.kind === 'workflowRun.changed') {
          for (const effect of event.payload.effects) this.#track(() => this.#perform(effect));
        } else if (event.kind === 'turn.ended') {
          const { threadId, turnId, state } = event.payload;
          this.#track(() => this.#turnEnded(threadId, { id: turnId, state }));
        }
      }
    });
  }

  onNotify(listener: RunNotificationListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // Resolves once every effect and turn outcome seen so far has been handled.
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all(this.#pending);
  }

  // Steps still marked running after a restart. A turn the provider service failed on recovery
  // arrives as turn.ended like any other; this covers what ended without the runner seeing it:
  // a turn that ended just before the server stopped, or a step whose turn never started.
  recover(): void {
    const live = this.#deps.db
      .select()
      .from(workflowRuns)
      .where(inArray(workflowRuns.state, ['running', 'waiting']))
      .all();
    for (const run of live) {
      for (const stepRun of run.steps) {
        if (stepRun.state !== 'running' || !stepRun.threadId) continue;
        const threadId = stepRun.threadId;
        const last = this.#deps.db
          .select({ id: turns.id, state: turns.state })
          .from(turns)
          .where(eq(turns.threadId, threadId))
          .orderBy(desc(turns.index))
          .get();
        if (last) {
          const { id, state } = last;
          if (state !== 'running') this.#track(() => this.#turnEnded(threadId, { id, state }));
          continue;
        }
        this.#dispatch(`workflow:${run.id}:${stepRun.stepId}:unstarted`, {
          type: 'workflowRun.stepFailed',
          runId: run.id,
          stepId: stepRun.stepId,
          error: 'The server stopped before this step started',
        });
      }
    }
  }

  // Looks for every started step's expected artifacts in the run's folder and stores them.
  async detectArtifacts(runId: string): Promise<void> {
    const { db } = this.#deps;
    const run = this.#run(runId);
    if (!run) throw new CommandRejected('not_found', `No run ${runId}`);
    const workflow = db.select().from(workflows).where(eq(workflows.id, run.workflowId)).get();
    const project = db.select().from(projects).where(eq(projects.id, run.projectId)).get();
    if (!workflow || !project) return;
    const found = [];
    for (const stepRun of run.steps) {
      if (stepRun.state === 'not_started') continue;
      const step = workflow.steps.find((entry) => entry.id === stepRun.stepId);
      if (!step) continue;
      const paths = await this.#deps.detectArtifacts(
        runFolder(run, project.cwd),
        step.expectedArtifacts,
      );
      found.push({ stepId: step.id, paths });
    }
    if (found.length === 0) return;
    this.#dispatch(`artifacts:${runId}:${randomUUID()}`, {
      type: 'workflowRun.artifactsFound',
      runId,
      found,
    });
  }

  async stop(): Promise<void> {
    this.#unsubscribe();
    await this.settled();
  }

  // Work starts on a later microtask: dispatching from inside a commit listener would deliver
  // the new commit to other listeners before they saw the one that caused it.
  #track(work: () => Promise<void> | void): void {
    const tracked = Promise.resolve()
      .then(work)
      .catch((error: unknown) => {
        this.#deps.logger.error('workflow effect failed', error);
      });
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  async #perform(effect: RunEffect): Promise<void> {
    switch (effect.type) {
      case 'startStep':
        // No prompt is sent while the run's own working copy is not there (review loop spec 38).
        if ((await this.#deps.prepare?.(effect.runId)) !== undefined) return;
        await this.#recordBase(effect.runId);
        this.#startStep(effect);
        return;
      case 'interrupt':
        // Nothing to interrupt when the turn already ended; the run is stopped either way.
        this.#dispatch(`workflow:${effect.threadId}:interrupt:${randomUUID()}`, {
          type: 'thread.interrupt',
          threadId: effect.threadId,
        });
        return;
      case 'notify':
        for (const listener of this.#listeners) listener(effect);
        return;
      case 'setThreadState':
      case 'sendBack':
        // Stored by the transition itself (a send back starts its turn in the same commit);
        // nothing to perform.
        return;
    }
  }

  // Before the run's first step does anything, the commit its folder is on is stored as the
  // run's base (review loop spec 10). A folder git cannot read leaves the run without one.
  async #recordBase(runId: string): Promise<void> {
    const run = this.#run(runId);
    if (!run || run.baseSha) return;
    const first = run.steps.every(
      (step, index) => index === run.currentStep || step.state === 'not_started',
    );
    if (!first || run.steps[run.currentStep]?.endedAt) return;
    const project = this.#project(run.projectId);
    if (!project) return;
    const folder = runFolder(run, project.cwd);
    const base = await this.#deps.changes.base(folder).catch((error: unknown) => {
      this.#deps.logger.warn('reading the run base failed', error);
      return undefined;
    });
    if (!base) return;
    this.#dispatch(`workflow:${runId}:base`, {
      type: 'workflowRun.baseRecorded',
      runId,
      baseSha: base.baseSha,
      files: base.files,
    });
  }

  #startStep(effect: Extract<RunEffect, { type: 'startStep' }>): void {
    const { runId, stepId, threadId } = effect;
    const thread = this.#deps.db.select().from(threads).where(eq(threads.id, threadId)).get();
    const missing = thread
      ? [
          thread.model === '' ? 'model' : undefined,
          thread.effort === '' ? 'effort' : undefined,
          thread.permissionMode === '' ? 'permission mode' : undefined,
        ].filter((entry) => entry !== undefined)
      : [];
    const error = !thread
      ? `The thread for step ${stepId} no longer exists`
      : missing.length > 0
        ? `No ${missing.join(', ')} for this step: set it on the step or as a default of its provider instance`
        : undefined;
    if (error !== undefined) {
      this.#dispatch(`workflow:${runId}:${stepId}:failed`, {
        type: 'workflowRun.stepFailed',
        runId,
        stepId,
        error,
      });
      return;
    }
    const sent = this.#dispatch(`workflow:${runId}:${stepId}:start`, {
      type: 'thread.sendMessage',
      threadId,
      text: effect.prompt,
    });
    if (!sent.ok) {
      this.#dispatch(`workflow:${runId}:${stepId}:failed`, {
        type: 'workflowRun.stepFailed',
        runId,
        stepId,
        error: sent.error,
      });
    }
  }

  async #turnEnded(threadId: string, turn: EndedTurn): Promise<void> {
    const { db } = this.#deps;
    const thread = db.select().from(threads).where(eq(threads.id, threadId)).get();
    if (!thread?.runId || !thread.stepId) return;
    const { runId, stepId } = thread;
    const run = this.#run(runId);
    const stepRun = run?.steps.find((entry) => entry.stepId === stepId);
    // A stopped run, or a later turn the user sent in the step's thread: not the step's outcome.
    // A send-back turn is the step's outcome again: it starts in the commit that sets the step
    // running, and no other turn can run in the thread beside it.
    if (!run || stepRun?.state !== 'running' || stepRun.threadId !== threadId) return;
    const commandId = `workflow:${turn.id}:ended`;
    if (turn.state !== 'completed') {
      this.#dispatch(commandId, {
        type: 'workflowRun.stepFailed',
        runId,
        stepId,
        error:
          turn.state === 'interrupted'
            ? 'The turn was interrupted'
            : (this.#errorOf(turn.id) ?? 'The turn failed'),
        // An interrupted turn is the user stopping the step: no rule is followed for it.
        ...(turn.state === 'interrupted' ? { stopped: true } : {}),
      });
      return;
    }
    const workflow = db.select().from(workflows).where(eq(workflows.id, run.workflowId)).get();
    const project = this.#project(run.projectId);
    const step = workflow?.steps.find((entry) => entry.id === stepId);
    const folder = project ? runFolder(run, project.cwd) : undefined;
    const artifactsFound =
      step && folder !== undefined
        ? await this.#deps.detectArtifacts(folder, step.expectedArtifacts)
        : [];
    // The facts a gate's condition or a rule of the step asks about are read now, at the step's
    // end. Which globs found nothing, when every expected artifact is asked for:
    const asksArtifacts =
      step !== undefined &&
      (step.gateAfterCondition?.includes('artifacts') === true || ruleAsksAbout(step, 'artifacts'));
    const asksChecks =
      step !== undefined &&
      (step.gateAfterCondition?.includes('checks') === true || ruleAsksAbout(step, 'checks'));
    const artifactsMissing: string[] = [];
    if (step && folder !== undefined && asksArtifacts) {
      for (const glob of step.expectedArtifacts) {
        if ((await this.#deps.detectArtifacts(folder, [glob])).length === 0) {
          artifactsMissing.push(glob);
        }
      }
    }
    const headSha =
      folder !== undefined && asksChecks
        ? await this.#deps.changes.head?.(folder).catch(() => undefined)
        : undefined;
    const { baseSha } = run;
    const fileHashes =
      folder !== undefined && baseSha
        ? await this.#deps.changes.snapshot(folder, baseSha).catch((error: unknown) => {
            this.#deps.logger.warn('reading what the step changed failed', error);
            return undefined;
          })
        : undefined;
    this.#dispatch(commandId, {
      type: 'workflowRun.stepCompleted',
      runId,
      stepId,
      finalMessage: this.#lastText(turn.id, 'assistant_text', 'text') ?? '',
      artifactsFound,
      ...(asksArtifacts ? { artifactsMissing } : {}),
      ...(fileHashes ? { fileHashes } : {}),
      ...(headSha === undefined ? {} : { headSha }),
    });
  }

  #errorOf(turnId: string): string | undefined {
    return this.#lastText(turnId, 'error', 'message');
  }

  // The named text field of the turn's last item of this kind.
  #lastText(turnId: string, kind: 'assistant_text' | 'error', field: string): string | undefined {
    const row = this.#deps.db
      .select({ payload: threadItems.payload })
      .from(threadItems)
      .where(and(eq(threadItems.turnId, turnId), eq(threadItems.kind, kind)))
      .orderBy(desc(threadItems.index))
      .get();
    const payload: unknown = row?.payload;
    if (typeof payload !== 'object' || payload === null) return undefined;
    const value: unknown = (payload as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : undefined;
  }

  #project(projectId: string) {
    return this.#deps.db.select().from(projects).where(eq(projects.id, projectId)).get();
  }

  #run(runId: string): WorkflowRun | undefined {
    return this.#deps.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
  }

  #dispatch(
    commandId: string,
    command: ServerCommand,
  ): { readonly ok: true } | { readonly ok: false; readonly error: string } {
    try {
      this.#deps.engine.dispatch(commandId, command);
      return { ok: true };
    } catch (error) {
      // A run the user stopped rejects the late outcome of its interrupted turn, and an interrupt
      // finds no running turn when the turn already ended. Both are expected.
      if (error instanceof CommandRejected) {
        this.#deps.logger.debug(`${command.type} rejected`, error.message);
        return { ok: false, error: error.message };
      }
      throw error;
    }
  }
}
