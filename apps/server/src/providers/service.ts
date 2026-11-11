import {
  assistantToolsetName,
  ProviderEvent,
  ProviderModel,
  ProviderTestResult,
  SecretRef,
  secretPatterns,
  type ProviderAdapter,
  type ProviderCommand,
  type ProviderInstance,
} from '@wow/contracts';
import type { SecretStore } from '@wow/secrets';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AssistantRedactor } from '../assistant/redact.js';
import { prepareAssistantFolder } from '../assistant/thread.js';
import type { Commit, Engine } from '../core/engine.js';
import { CommandRejected } from '../core/orchestrator.js';
import type { Db } from '../db/database.js';
import { providerInstances, turns } from '../db/schema.js';
import type { ProviderAdapters } from '../hooks/providers.js';
import type { Logger } from '../logger.js';
import type { SettingsService } from '../settings/service.js';

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

  constructor(deps: ProviderServiceDeps) {
    this.#deps = deps;
    this.#unsubscribe = deps.engine.onCommit((commit) => this.#onCommit(commit));
  }

  // A turn that was running when the previous server process ended cannot finish: its provider
  // process is gone. The partial output stays; the thread can continue with a new turn.
  recover(): void {
    const running = this.#deps.db
      .select({ threadId: turns.threadId })
      .from(turns)
      .where(eq(turns.state, 'running'))
      .all();
    for (const { threadId } of running) {
      this.#dispatch(threadId, [
        { type: 'turnFailed', threadId, error: 'The server stopped while this turn was running' },
      ]);
    }
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
          };
          this.#send(
            providerInstanceId,
            turn.threadId,
            true,
            start.kind === 'assistant' ? () => this.#assistantTurn(command) : command,
          );
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
        case 'approval.answered':
          this.#send(event.payload.providerInstanceId, event.payload.threadId, false, {
            type: 'answerApproval',
            approvalId: event.payload.providerApprovalId,
            decision: event.payload.decision,
          });
          break;
        case 'question.answered':
          this.#send(event.payload.providerInstanceId, event.payload.threadId, false, {
            type: 'answerQuestion',
            questionId: event.payload.providerQuestionId,
            answer: event.payload.answer,
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
    for (const name of secrets) {
      this.#deps.secrets
        .delete(name)
        .catch((error: unknown) =>
          this.#deps.logger.warn(`could not delete secret ${name}`, error),
        );
    }
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
      (typeof command === 'function' ? command().then(send) : send(command)).catch(fail);
    } catch (error) {
      fail(error);
    }
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
