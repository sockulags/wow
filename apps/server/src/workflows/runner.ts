import type {
  Command,
  DispatchResult,
  ProviderAdapter,
  ProviderEvent,
  ProviderInstance,
  RunEffect,
} from '@wow/contracts';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import { projects, providerInstances, threads, workflowRuns, workflows } from '../db/schema.js';
import type { ProviderAdapters } from '../hooks/providers.js';
import type { Logger } from '../logger.js';
import type { ArtifactDetector } from './artifacts.js';

export type RunNotification = Extract<RunEffect, { type: 'notify' }>;
export type RunNotificationListener = (notification: RunNotification) => void;

export interface RunnerDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly providers: ProviderAdapters;
  readonly detectArtifacts: ArtifactDetector;
  readonly logger: Logger;
}

interface ActiveStep {
  readonly runId: string;
  readonly stepId: string;
  readonly texts: Map<string, string>;
  lastTextItem: string | undefined;
}

// Performs the effects of committed run transitions: starts a step's turn on its provider,
// interrupts, and passes notifications on. What the provider reports back (the turn completed or
// failed) becomes a command, so the run only changes through the engine.
export class WorkflowRunner {
  readonly #deps: RunnerDeps;
  readonly #adapters = new Map<string, ProviderAdapter>();
  readonly #active = new Map<string, ActiveStep>();
  readonly #listeners = new Set<RunNotificationListener>();
  readonly #pending = new Set<Promise<void>>();
  readonly #unsubscribe: () => void;

  constructor(deps: RunnerDeps) {
    this.#deps = deps;
    this.#unsubscribe = deps.engine.onCommit((commit) => {
      for (const { event } of commit.events) {
        if (event.kind !== 'workflowRun.changed') continue;
        for (const effect of event.payload.effects) this.#track(this.#perform(effect));
      }
    });
  }

  onNotify(listener: RunNotificationListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // Resolves once every effect started so far has been handed to its provider.
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all(this.#pending);
  }

  // Looks for every started step's expected artifacts in the project folder and stores them.
  async detectArtifacts(runId: string): Promise<void> {
    const { db } = this.#deps;
    const run = db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get();
    if (!run) throw new CommandRejected('not_found', `No run ${runId}`);
    const workflow = db.select().from(workflows).where(eq(workflows.id, run.workflowId)).get();
    const project = db.select().from(projects).where(eq(projects.id, run.projectId)).get();
    if (!workflow || !project) return;
    const found = [];
    for (const stepRun of run.steps) {
      if (stepRun.state === 'not_started') continue;
      const step = workflow.steps.find((entry) => entry.id === stepRun.stepId);
      if (!step) continue;
      const paths = await this.#deps.detectArtifacts(project.cwd, step.expectedArtifacts);
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
    this.#active.clear();
    const adapters = [...this.#adapters.values()];
    this.#adapters.clear();
    await Promise.allSettled(adapters.map((adapter) => adapter.dispose()));
  }

  #track(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => {
      this.#deps.logger.error('workflow effect failed', error);
    });
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  async #perform(effect: RunEffect): Promise<void> {
    switch (effect.type) {
      case 'startStep':
        return this.#startStep(effect);
      case 'interrupt': {
        this.#active.delete(effect.threadId);
        const adapter = this.#adapterForThread(effect.threadId);
        await adapter?.send({ type: 'interrupt', threadId: effect.threadId });
        return;
      }
      case 'notify':
        for (const listener of this.#listeners) listener(effect);
        return;
      case 'setThreadState':
        // Stored by the transition itself; nothing to perform.
        return;
    }
  }

  async #startStep(effect: Extract<RunEffect, { type: 'startStep' }>): Promise<void> {
    const { runId, stepId, threadId } = effect;
    const fail = (error: string) =>
      this.#dispatch(`${runId}:${stepId}:failed`, {
        type: 'workflowRun.stepFailed',
        runId,
        stepId,
        error,
      });
    const thread = this.#deps.db.select().from(threads).where(eq(threads.id, threadId)).get();
    const instance = thread && this.#instance(thread.providerInstanceId);
    if (!thread || !instance) {
      fail(`The provider instance for step ${stepId} no longer exists`);
      return;
    }
    const missing = [
      thread.model === '' ? 'model' : undefined,
      thread.effort === '' ? 'effort' : undefined,
      thread.permissionMode === '' ? 'permission mode' : undefined,
    ].filter((entry) => entry !== undefined);
    if (missing.length > 0) {
      fail(
        `No ${missing.join(', ')} for this step: set it on the step or as a default of provider instance ${instance.name}`,
      );
      return;
    }
    this.#active.set(threadId, {
      runId,
      stepId,
      texts: new Map(),
      lastTextItem: undefined,
    });
    try {
      const adapter = this.#adapter(instance);
      await adapter.send({
        type: 'startTurn',
        threadId,
        cwd: thread.cwd,
        prompt: effect.prompt,
        model: thread.model,
        effort: thread.effort,
        permissionMode: thread.permissionMode,
      });
    } catch (error) {
      this.#active.delete(threadId);
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  #onProviderEvent(event: ProviderEvent): void {
    const active = this.#active.get(event.threadId);
    if (!active) return;
    switch (event.type) {
      case 'textDelta':
        active.texts.set(event.itemId, (active.texts.get(event.itemId) ?? '') + event.delta);
        active.lastTextItem = event.itemId;
        return;
      case 'turnCompleted':
        this.#active.delete(event.threadId);
        this.#track(this.#completeStep(active));
        return;
      case 'turnFailed':
        this.#active.delete(event.threadId);
        this.#stepFailed(active, event.error);
        return;
      case 'turnInterrupted':
        this.#active.delete(event.threadId);
        this.#stepFailed(active, 'The turn was interrupted');
        return;
      default:
        return;
    }
  }

  async #completeStep(active: ActiveStep): Promise<void> {
    const { db } = this.#deps;
    const run = db.select().from(workflowRuns).where(eq(workflowRuns.id, active.runId)).get();
    const workflow =
      run && db.select().from(workflows).where(eq(workflows.id, run.workflowId)).get();
    const project = run && db.select().from(projects).where(eq(projects.id, run.projectId)).get();
    const step = workflow?.steps.find((entry) => entry.id === active.stepId);
    const artifactsFound =
      step && project ? await this.#deps.detectArtifacts(project.cwd, step.expectedArtifacts) : [];
    const finalMessage = active.lastTextItem ? (active.texts.get(active.lastTextItem) ?? '') : '';
    this.#dispatch(`${active.runId}:${active.stepId}:completed`, {
      type: 'workflowRun.stepCompleted',
      runId: active.runId,
      stepId: active.stepId,
      finalMessage,
      artifactsFound,
    });
  }

  #stepFailed(active: ActiveStep, error: string): void {
    this.#dispatch(`${active.runId}:${active.stepId}:failed`, {
      type: 'workflowRun.stepFailed',
      runId: active.runId,
      stepId: active.stepId,
      error,
    });
  }

  #dispatch(commandId: string, command: Command): DispatchResult | undefined {
    try {
      return this.#deps.engine.dispatch(commandId, command);
    } catch (error) {
      // A run stopped by the user rejects the late report of its interrupted turn; that is
      // expected and only worth a debug line.
      if (error instanceof CommandRejected) {
        this.#deps.logger.debug(`${command.type} rejected`, error.message);
        return undefined;
      }
      throw error;
    }
  }

  #instance(id: string): ProviderInstance | undefined {
    return this.#deps.db.select().from(providerInstances).where(eq(providerInstances.id, id)).get();
  }

  #adapterForThread(threadId: string): ProviderAdapter | undefined {
    const thread = this.#deps.db.select().from(threads).where(eq(threads.id, threadId)).get();
    return thread ? this.#adapters.get(thread.providerInstanceId) : undefined;
  }

  // One adapter per provider instance, kept for the server's lifetime.
  #adapter(instance: ProviderInstance): ProviderAdapter {
    let adapter = this.#adapters.get(instance.id);
    if (!adapter) {
      adapter = this.#deps.providers.create(instance);
      adapter.onEvent((event) => this.#onProviderEvent(event));
      this.#adapters.set(instance.id, adapter);
    }
    return adapter;
  }
}
