import {
  assistantToolsetName,
  attachmentMediaType,
  HandOverResult,
  ProviderEvent,
  ProviderModel,
  ProviderSlashCommand,
  ProviderTestResult,
  SecretRef,
  secretPatterns,
  type ProviderAdapter,
  type ProviderCommand,
  type ProviderInstance,
  type QueuedMessage,
} from '@wow/contracts';
import type { SecretStore } from '@wow/secrets';
import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AssistantRedactor } from '../assistant/redact.js';
import { prepareAssistantFolder } from '../assistant/thread.js';
import type { Commit, Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import { threadImagePath } from '../files/images.js';
import { providerInstances, threads, turns, workflowRuns } from '../db/schema.js';
import type { ProviderAdapters } from '../hooks/providers.js';
import type { Logger } from '../logger.js';
import type { SettingsService } from '../settings/service.js';
import type { RunChanges } from '../workflows/runner.js';

export interface ProviderServiceDeps {
  readonly db: Db;
  readonly engine: Engine;
  readonly adapters: ProviderAdapters;
  readonly settings: SettingsService;
  readonly secrets: SecretStore;
  readonly logger: Logger;
  // wow's own folder, where the assistant's empty folder lives.
  readonly home: string;
  // Where the assistant's tools answer and the token that opens them; undefined until the
  // server listens. Kept in memory only and handed to the adapter with the turn.
  readonly assistant: () => { readonly url: string; readonly token: string } | undefined;
  // Reads a chat thread's folder through git for its Changes (agent workbench spec 34); without
  // it, threads get no base and no marks.
  readonly changes?: RunChanges | undefined;
  // Milliseconds since the epoch; tests pass their own.
  readonly now?: (() => number) | undefined;
}

type StartTurn = Extract<ProviderCommand, { type: 'startTurn' }>;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Routes thread commands to provider adapters and feeds what the adapters report back into the
// engine as `provider.events` commands. One adapter per provider instance, created on first use.
export class ProviderService {
  readonly #deps: ProviderServiceDeps;
  readonly #adapters = new Map<string, ProviderAdapter>();
  readonly #pending = new Map<string, ProviderEvent[]>();
  readonly #redactor = new AssistantRedactor();
  readonly #unsubscribe: () => void;
  #flushScheduled = false;
  #stopped = false;
  // Threads whose queued message the provider has been offered and not yet answered.
  readonly #handingOver = new Set<string>();
  readonly #commandLists = new Map<
    string,
    { readonly at: number; readonly commands: ProviderSlashCommand[] }
  >();
  // Turns being prepared before they go out (the assistant's tools, a chat thread's marks).
  readonly #preparing = new Set<Promise<unknown>>();

  constructor(deps: ProviderServiceDeps) {
    this.#deps = deps;
    this.#unsubscribe = deps.engine.onCommit((commit) => this.#onCommit(commit));
  }

  // A turn that was running when the previous server process ended cannot finish: its provider
  // process is gone. The partial output stays; the thread can continue with a new turn.
  // Background work went with the process too: the turn the provider would have started after
  // it never comes, so it fails here, which also ends a workflow step that waited for it.
  recover(): void {
    const running = new Set(
      this.#deps.db
        .select({ threadId: turns.threadId })
        .from(turns)
        .where(eq(turns.state, 'running'))
        .all()
        .map((row) => row.threadId),
    );
    for (const threadId of running) {
      this.#dispatch(threadId, [
        { type: 'backgroundTasks', threadId, tasks: [] },
        { type: 'turnFailed', threadId, error: 'The server stopped while this turn was running' },
      ]);
    }
    const waiting = this.#deps.db
      .select({
        id: threads.id,
        runId: threads.runId,
        stepId: threads.stepId,
        tasks: threads.backgroundTasks,
      })
      .from(threads)
      .where(ne(threads.backgroundTasks, []))
      .all();
    for (const { id: threadId, runId, stepId, tasks } of waiting) {
      if (running.has(threadId)) continue;
      // Only a running workflow step waited for a turn; any other thread keeps its state.
      if (!tasks.some((task) => task.agent === true) || !this.#stepRunning(runId, stepId)) {
        this.#dispatch(threadId, [{ type: 'backgroundTasks', threadId, tasks: [] }]);
        continue;
      }
      this.#dispatch(threadId, [
        { type: 'backgroundTasks', threadId, tasks: [] },
        { type: 'turnStartedByProvider', threadId },
        {
          type: 'turnFailed',
          threadId,
          error: 'The server stopped while the agent was waiting for background work',
        },
      ]);
    }
    // A message queued while a turn ran goes now that no turn runs (agent workbench spec 50).
    const queued = this.#deps.db
      .select({ id: threads.id, queued: threads.queued })
      .from(threads)
      .where(isNotNull(threads.queued))
      .all();
    for (const { id, queued: message } of queued) {
      if (message) this.#sendQueued(id, message.id);
    }
  }

  #stepRunning(runId: string | null, stepId: string | null): boolean {
    if (runId === null || stepId === null) return false;
    const run = this.#deps.db
      .select({ steps: workflowRuns.steps })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .get();
    return run?.steps.some((step) => step.stepId === stepId && step.state === 'running') === true;
  }

  async test(providerInstanceId: string): Promise<ProviderTestResult> {
    const adapter = this.#adapter(providerInstanceId);
    let result: ProviderTestResult;
    try {
      result = ProviderTestResult.parse(await adapter.send({ type: 'test' }));
    } catch (error) {
      result = { ok: false, account: null, version: null, message: describeError(error) };
    }
    if (!this.#stopped) {
      this.#deps.engine.dispatch(`provider-test:${randomUUID()}`, {
        type: 'providerInstance.recordTest',
        providerInstanceId,
        result,
      });
    }
    return result;
  }

  async listModels(providerInstanceId: string): Promise<ProviderModel[]> {
    const adapter = this.#adapter(providerInstanceId);
    return ProviderModel.array().parse(await adapter.send({ type: 'listModels' }));
  }

  // The / list asks each time it opens; for a thread without a live session Claude Code is
  // started in the folder to answer, so an answer is kept a short while per instance and folder.
  async listCommands(
    providerInstanceId: string,
    cwd: string,
    threadId?: string,
  ): Promise<ProviderSlashCommand[]> {
    const key = `${providerInstanceId}\0${cwd}`;
    const keepMs =
      this.#deps.settings.get('providers.commandListSeconds', { providerInstanceId }) * 1000;
    const now = (this.#deps.now ?? Date.now)();
    const kept = this.#commandLists.get(key);
    if (kept && now - kept.at < keepMs) return kept.commands;
    const adapter = this.#adapter(providerInstanceId);
    const commands = ProviderSlashCommand.array().parse(
      await adapter.send({ type: 'listCommands', cwd, ...(threadId ? { threadId } : {}) }),
    );
    if (keepMs > 0) this.#commandLists.set(key, { at: now, commands });
    return commands;
  }

  // Stops the instance's adapter (and its app-server process); the next use starts a new one.
  release(providerInstanceId: string): void {
    this.#release(providerInstanceId, []);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#unsubscribe();
    this.#flush();
    const adapters = [...this.#adapters.values()];
    this.#adapters.clear();
    for (const adapter of adapters) {
      try {
        await adapter.dispose();
      } catch (error) {
        this.#deps.logger.error('provider adapter failed to stop', error);
      }
    }
  }

  #adapter(providerInstanceId: string): ProviderAdapter {
    const existing = this.#adapters.get(providerInstanceId);
    if (existing) return existing;
    const instance = this.#deps.db
      .select()
      .from(providerInstances)
      .where(eq(providerInstances.id, providerInstanceId))
      .get();
    if (!instance) {
      throw new CommandRejected('not_found', `No provider instance ${providerInstanceId}`);
    }
    const adapter = this.#deps.adapters.create(instance, {
      resolveEnv: () => this.#resolveEnv(instance),
      testTimeoutMs: () =>
        this.#deps.settings.get('providers.testTimeoutMs', { providerInstanceId }),
      requestTimeoutMs: () =>
        this.#deps.settings.get('providers.requestTimeoutMs', { providerInstanceId }),
    });
    adapter.onEvent((event) => this.#enqueue(event));
    this.#adapters.set(providerInstanceId, adapter);
    return adapter;
  }

  async #resolveEnv(instance: ProviderInstance): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(instance.env)) {
      if (typeof value === 'string') {
        env[name] = value;
        continue;
      }
      const ref = SecretRef.parse(value);
      const secret = await this.#deps.secrets.resolve(ref);
      if (secret === undefined) {
        throw new Error(`Secret ${ref.secretRef} for ${name} is not in the secret store`);
      }
      env[name] = secret;
    }
    return env;
  }

  #onCommit(commit: Commit): void {
    for (const { event } of commit.events) {
      switch (event.kind) {
        case 'turn.started': {
          const { turn, providerInstanceId, start } = event.payload;
          const command: StartTurn = {
            type: 'startTurn',
            threadId: turn.threadId,
            cwd: start.cwd,
            prompt: start.prompt,
            model: start.model,
            effort: start.effort,
            permissionMode: start.permissionMode,
            ...(start.resumeId === null ? {} : { resumeId: start.resumeId }),
            ...(start.images && start.images.length > 0
              ? {
                  images: start.images.map((id) => ({
                    path: threadImagePath(this.#deps.home, turn.threadId, id),
                    mediaType: attachmentMediaType(id),
                  })),
                }
              : {}),
          };
          this.#send(
            providerInstanceId,
            turn.threadId,
            true,
            start.kind === 'assistant'
              ? () => this.#assistantTurn(command)
              : this.#chatThread(turn.threadId)
                ? () => this.#marked(command, turn.id, turn.index)
                : command,
          );
          break;
        }
        case 'thread.queueChanged': {
          const { threadId, queued, handOver } = event.payload;
          // One offer at a time: a join offered while the provider still decides on the first
          // would give it the first text twice; its answer offers what is left.
          if (queued && handOver && !this.#handingOver.has(threadId))
            this.#handOver(handOver.providerInstanceId, threadId, queued, handOver.prompt);
          break;
        }
        // Dispatched after this commit's listeners have all heard of the turn's end, so none of
        // them sees the next turn start first.
        case 'turn.ended': {
          const { threadId } = event.payload;
          const queued = this.#deps.db
            .select({ queued: threads.queued })
            .from(threads)
            .where(eq(threads.id, threadId))
            .get()?.queued;
          if (queued) queueMicrotask(() => this.#sendQueued(threadId, queued.id));
          break;
        }
        case 'turn.interruptRequested':
          this.#send(event.payload.providerInstanceId, event.payload.threadId, true, {
            type: 'interrupt',
            threadId: event.payload.threadId,
          });
          break;
        case 'thread.configured': {
          const { threadId, providerInstanceId, changes } = event.payload;
          if (changes.model !== undefined) {
            this.#send(providerInstanceId, threadId, false, {
              type: 'setModel',
              threadId,
              model: changes.model,
            });
          }
          if (changes.permissionMode !== undefined) {
            this.#send(providerInstanceId, threadId, false, {
              type: 'setPermissionMode',
              threadId,
              permissionMode: changes.permissionMode,
            });
          }
          break;
        }
        // The instance it left would otherwise keep its live session and go on with it, with
        // the old options, if the thread came back.
        case 'thread.providerChanged': {
          const { threadId, previousProviderInstanceId } = event.payload;
          if (
            previousProviderInstanceId !== undefined &&
            previousProviderInstanceId !== event.payload.providerInstanceId &&
            this.#adapters.has(previousProviderInstanceId)
          ) {
            this.#send(previousProviderInstanceId, threadId, false, {
              type: 'closeThread',
              threadId,
            });
          }
          break;
        }
        // wow keeps its rules itself (agent workbench spec 38): the provider hears "once".
        case 'approval.answered': {
          const { decision, note, permissionMode } = event.payload;
          this.#send(event.payload.providerInstanceId, event.payload.threadId, false, {
            type: 'answerApproval',
            approvalId: event.payload.providerApprovalId,
            decision: decision === 'allowAlways' ? 'allowOnce' : decision,
            ...(note === undefined ? {} : { note }),
            ...(permissionMode === undefined ? {} : { permissionMode }),
          });
          break;
        }
        case 'question.answered':
          this.#send(event.payload.providerInstanceId, event.payload.threadId, false, {
            type: 'answerQuestion',
            questionId: event.payload.providerQuestionId,
            answer: event.payload.reply ?? { picked: [], text: event.payload.answer },
          });
          break;
        // The adapter was made from the old instance row; the next use makes one from the new.
        case 'providerInstance.updated':
        case 'providerInstance.deleted':
          this.#release(event.payload.providerInstanceId, event.payload.releasedSecrets);
          break;
        default:
          break;
      }
    }
  }

  #release(providerInstanceId: string, secrets: readonly string[]): void {
    const adapter = this.#adapters.get(providerInstanceId);
    this.#adapters.delete(providerInstanceId);
    adapter
      ?.dispose()
      .catch((error: unknown) => this.#deps.logger.error('provider adapter failed to stop', error));
    // The disposed adapter reports nothing more, so the background work it listed is gone.
    if (adapter) {
      const listed = this.#deps.db
        .select({ id: threads.id })
        .from(threads)
        .where(
          and(eq(threads.providerInstanceId, providerInstanceId), ne(threads.backgroundTasks, [])),
        )
        .all();
      for (const { id } of listed)
        this.#enqueue({ type: 'backgroundTasks', threadId: id, tasks: [] });
    }
    for (const name of secrets) {
      this.#deps.secrets
        .delete(name)
        .catch((error: unknown) =>
          this.#deps.logger.warn(`could not delete secret ${name}`, error),
        );
    }
  }

  #sendQueued(threadId: string, queuedId: string): void {
    if (this.#stopped) return;
    try {
      // One id per queued message, so the turn end and a restart never send it twice.
      this.#deps.engine.dispatch(`send-queued:${queuedId}`, {
        type: 'thread.sendQueued',
        threadId,
        queuedId,
      });
    } catch (error) {
      // Another turn started first: the message goes when that one ends.
      if (error instanceof CommandRejected && error.code === 'conflict') return;
      this.#deps.logger.warn('the queued message was not sent', describeError(error));
    }
  }

  // Offers the queued message to the running turn. Not taken, it stays queued and goes when
  // the turn ends (agent workbench spec 51 and its open risk).
  #handOver(
    providerInstanceId: string,
    threadId: string,
    queued: QueuedMessage,
    prompt: string,
  ): void {
    let answer: Promise<unknown>;
    try {
      answer = this.#adapter(providerInstanceId).send({ type: 'handOver', threadId, prompt });
    } catch (error) {
      this.#deps.logger.warn('provider handOver failed', describeError(error));
      return;
    }
    this.#handingOver.add(threadId);
    answer
      .then(
        (result) => {
          this.#handingOver.delete(threadId);
          if (this.#stopped || !HandOverResult.safeParse(result).data?.taken) return;
          this.#deps.engine.dispatch(`handed-over:${queued.id}`, {
            type: 'thread.handedOver',
            threadId,
            queuedId: queued.id,
            offered: {
              text: queued.text,
              ...(queued.skills ? { skills: queued.skills } : {}),
              ...(queued.files ? { files: queued.files } : {}),
            },
          });
        },
        (error: unknown) => {
          this.#handingOver.delete(threadId);
          this.#deps.logger.warn('provider handOver failed', describeError(error));
        },
      )
      .catch((error: unknown) =>
        this.#deps.logger.warn('the handed over message was not recorded', describeError(error)),
      );
  }

  // A chat thread, whose changes are measured; a step's thread has its run's.
  #chatThread(threadId: string): boolean {
    if (!this.#deps.changes) return false;
    const row = this.#deps.db
      .select({ runId: threads.runId, kind: threads.kind })
      .from(threads)
      .where(eq(threads.id, threadId))
      .get();
    return row !== undefined && row.runId === null && row.kind === 'chat';
  }

  // Before a chat thread's turn goes out, the folder is read (agent workbench spec 34): its
  // first turn records the base, every turn the changed files' hashes. A thread stored before
  // this change has turns but no base and gets none, so its Changes say so (spec 35). Git that
  // cannot say leaves the turn as it is; it never stops the turn.
  async #marked(command: StartTurn, turnId: string, index: number): Promise<StartTurn> {
    const changes = this.#deps.changes;
    if (!changes) return command;
    try {
      const stored = this.#deps.db
        .select({ baseSha: threads.baseSha })
        .from(threads)
        .where(eq(threads.id, command.threadId))
        .get();
      const base = index === 0 ? await changes.base(command.cwd) : undefined;
      const sha = base?.baseSha ?? stored?.baseSha ?? null;
      const mark =
        sha === null
          ? undefined
          : index === 0
            ? base?.files
            : await changes.snapshot(command.cwd, sha);
      if (!this.#stopped && (base || mark)) {
        this.#deps.engine.dispatch(`changes-marked:${turnId}`, {
          type: 'thread.changesMarked',
          threadId: command.threadId,
          turnId,
          base: base ? { sha: base.baseSha, files: base.files } : null,
          mark: mark ?? null,
        });
      }
    } catch (error) {
      this.#deps.logger.warn(
        'the thread folder was not read for its changes',
        describeError(error),
      );
    }
    return command;
  }

  // The assistant's turn (app assistant spec 2): wow's tools and no others, the instruction
  // text, and the app's empty folder whatever the thread row says.
  async #assistantTurn(command: StartTurn): Promise<StartTurn> {
    const access = this.#deps.assistant();
    if (!access) throw new Error("The assistant's tools are not running yet");
    return {
      ...command,
      cwd: await prepareAssistantFolder(this.#deps.home),
      toolset: { name: assistantToolsetName, url: access.url, token: access.token },
      instructions: this.#deps.settings.get('assistant.instructions'),
    };
  }

  // Effects run after commit. When one that drives a turn fails, the turn fails with the reason,
  // so the thread never stays "working" without a provider behind it. A command that has to be
  // prepared first is given as a function; failing to prepare it fails the same way.
  #send(
    providerInstanceId: string,
    threadId: string,
    failsTurn: boolean,
    command: ProviderCommand | (() => Promise<StartTurn>),
  ): void {
    const type = typeof command === 'function' ? 'startTurn' : command.type;
    const fail = (error: unknown) => {
      this.#deps.logger.warn(`provider ${type} failed`, describeError(error));
      if (failsTurn) this.#enqueue({ type: 'turnFailed', threadId, error: describeError(error) });
    };
    const send = (ready: ProviderCommand) => this.#adapter(providerInstanceId).send(ready);
    try {
      if (typeof command === 'function') {
        const prepared = command().then((ready) => {
          this.#preparing.delete(prepared);
          return send(ready);
        });
        this.#preparing.add(prepared);
        prepared.catch((error: unknown) => {
          this.#preparing.delete(prepared);
          fail(error);
        });
      } else {
        send(command).catch(fail);
      }
    } catch (error) {
      fail(error);
    }
  }

  // Resolves once every turn being prepared has been handed to its adapter (for tests).
  async idle(): Promise<void> {
    while (this.#preparing.size > 0) await Promise.allSettled(this.#preparing);
  }

  // Events that arrive together (a burst of text deltas) are stored in one transaction.
  #enqueue(event: ProviderEvent): void {
    const parsed = ProviderEvent.safeParse(event);
    if (!parsed.success) {
      this.#deps.logger.warn('provider sent an invalid event', parsed.error.issues);
      return;
    }
    const batch = this.#pending.get(parsed.data.threadId);
    if (batch) batch.push(parsed.data);
    else this.#pending.set(parsed.data.threadId, [parsed.data]);
    if (this.#flushScheduled || this.#stopped) return;
    this.#flushScheduled = true;
    setImmediate(() => this.#flush());
  }

  #flush(): void {
    this.#flushScheduled = false;
    const batches = [...this.#pending];
    this.#pending.clear();
    for (const [threadId, events] of batches) this.#dispatch(threadId, events);
  }

  #dispatch(threadId: string, events: ProviderEvent[]): void {
    try {
      this.#deps.engine.dispatch(`provider:${randomUUID()}`, {
        type: 'provider.events',
        threadId,
        events: this.#redactor.redact(threadId, events, () =>
          secretPatterns(this.#deps.settings.get('assistant.secretPatterns')),
        ),
      });
    } catch (error) {
      this.#deps.logger.error('provider events were not stored', error);
    }
  }
}
