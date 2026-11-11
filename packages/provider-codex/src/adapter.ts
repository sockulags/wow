import { randomUUID } from 'node:crypto';
import type {
  HandOverResult,
  ApprovalDecision,
  ProviderAdapter,
  ProviderCommand,
  ProviderEvent,
  ProviderInstance,
  ProviderTestResult,
  ProviderUpdate,
  QuestionReply,
  TaskStatus,
} from '@wow/contracts';
import { markRecommended } from '@wow/contracts';
import {
  CompatibilityCache,
  checkInstalledCodex,
  installedCodexLacks,
  generateJsonSchema,
  type GenerateSchema,
  type SchemaLaunch,
} from './compat/check.js';
import type { ProtocolFingerprint } from './compat/schema.js';
import { compareCodexVersions } from './compat/version.js';
import {
  CodexConnection,
  CodexError,
  systemTimers,
  type ServerNotification,
  type ServerRequest,
  type Timers,
} from './connection.js';
import {
  codexUpdateOffer,
  detectCodexInstall,
  systemInstallIo,
  type InstallIo,
} from './install.js';
import { permissionMode, sandboxPolicy } from './permissions.js';
import { runCommand, spawnCodexAppServer, type RunCommand, type SpawnCodex } from './process.js';
import { toolsOnlyMode, toolsOnlySandbox, toolsOnlySettings, toolsOnlyUses } from './toolset.js';
import { codexProtocolFingerprint } from './protocol/generated/fingerprint.js';
import {
  type GetAccountResponse,
  type ModelListResponse,
  type RequestId,
  type ServerRequests,
  type ThreadStartParams,
  type TurnStartParams,
} from './protocol/generated/index.js';

type ThreadItem = Extract<ServerNotification, { method: 'item/started' }>['params']['item'];
type TokenUsage = Extract<
  ServerNotification,
  { method: 'thread/tokenUsage/updated' }
>['params']['tokenUsage']['total'];
type SandboxMode = NonNullable<ThreadStartParams['sandbox']>;
type StartTurn = Extract<ProviderCommand, { type: 'startTurn' }>;

export interface CodexModel {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly efforts: readonly string[];
  readonly defaultEffort: string;
  readonly isDefault: boolean;
  // Absent when this codex does not say which inputs the model takes.
  readonly imageInput?: boolean;
}

// A codex older than the generated one may not send `inputModalities`; then nothing is said
// about images (agent workbench spec 7, 54).
const imageInputOf = (model: { readonly inputModalities?: readonly string[] }) =>
  Array.isArray(model.inputModalities)
    ? { imageInput: model.inputModalities.includes('image') }
    : {};

export interface CodexTestResult extends ProviderTestResult {
  readonly models: readonly CodexModel[];
}

// What "Test" concludes about an installed codex version other than the tested one.
export interface CodexVersionVerdict {
  readonly ok: boolean;
  readonly message: string;
  readonly update: ProviderUpdate | null;
}

export interface CodexAdapterOptions {
  readonly instance: ProviderInstance;
  // Read before every request so a settings change applies without a restart.
  readonly requestTimeoutMs: () => number;
  // Turns the instance env (where secret-marked values are references) into plain values.
  // Without it, an instance with secret references cannot start.
  readonly resolveEnv?: (env: ProviderInstance['env']) => Promise<Record<string, string>>;
  readonly baseEnv?: Record<string, string | undefined>;
  readonly spawn?: SpawnCodex;
  readonly timers?: Timers;
  readonly newId?: () => string;
  readonly clientVersion?: string;
  // providers.testTimeoutMs: bounds each command the version check runs.
  readonly testTimeoutMs?: () => number;
  // Shared by the adapters of one factory, so the check runs once per binary and version.
  readonly compatibility?: CompatibilityCache<CodexVersionVerdict>;
  readonly generateSchema?: GenerateSchema;
  // Runs `npm prefix -g` to tell where `npm install -g` would install.
  readonly runCommand?: RunCommand;
  readonly installIo?: InstallIo;
  readonly fingerprint?: ProtocolFingerprint;
}

// The providers.testTimeoutMs default, for an adapter made without the server's context.
const defaultTestTimeoutMs = 120_000;

interface ThreadState {
  readonly wowId: string;
  readonly codexId: string;
  // False after the app-server restarted: the thread has to be resumed before the next turn.
  loaded: boolean;
  sandbox: SandboxMode;
  // Started with a toolset: only the app's tools, for as long as the thread lives.
  readonly toolsOnly: boolean;
  turnId: string | null;
  // A turn/start request of wow is on its way: a turn/started now is that turn's.
  starting: boolean;
  lastFinishedTurnId: string | null;
  lastError: string | null;
  usageTotal: TokenUsage | null;
  usageBaseline: TokenUsage | null;
  // Items whose text or output arrived as deltas, so item/completed does not repeat it.
  readonly streamed: Set<string>;
  readonly fileChanges: Map<string, unknown>;
}

interface OpenApproval {
  readonly requestId: RequestId;
  readonly method:
    | 'item/commandExecution/requestApproval'
    | 'item/fileChange/requestApproval'
    | 'item/permissions/requestApproval';
  readonly codexThreadId: string;
  readonly params: ServerRequests[OpenApproval['method']]['params'];
}

interface OpenInput {
  readonly requestId: RequestId;
  readonly codexThreadId: string;
  // wow question id → codex question id
  readonly questions: Map<string, string>;
  readonly answers: Map<string, QuestionReply>;
}

const okStatuses = new Set(['completed']);

const accountLabel = (account: NonNullable<GetAccountResponse['account']>): string => {
  switch (account.type) {
    case 'apiKey':
      return 'API key';
    case 'chatgpt':
      return account.email ?? `ChatGPT (${account.planType})`;
    case 'amazonBedrock':
      return 'Amazon Bedrock';
    case 'gcp':
      return 'Google Cloud';
    default:
      // An account kind a later codex added.
      return 'Signed in';
  }
};

const taskStatus = (status: string): TaskStatus =>
  status === 'inProgress' ? 'in_progress' : status === 'completed' ? 'completed' : 'pending';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// "<originator>/<version> (<os>) ..." is the only place initialize reports the codex version.
export const codexVersionFromUserAgent = (userAgent: string): string | null =>
  /^[^/\s]+\/(\d+\.\d+\.\d+[^\s]*)/.exec(userAgent)?.[1] ?? null;

const subtract = (total: TokenUsage, baseline: TokenUsage | null): TokenUsage =>
  baseline
    ? {
        totalTokens: total.totalTokens - baseline.totalTokens,
        inputTokens: total.inputTokens - baseline.inputTokens,
        cachedInputTokens: total.cachedInputTokens - baseline.cachedInputTokens,
        cacheWriteInputTokens: total.cacheWriteInputTokens - baseline.cacheWriteInputTokens,
        outputTokens: total.outputTokens - baseline.outputTokens,
        reasoningOutputTokens: total.reasoningOutputTokens - baseline.reasoningOutputTokens,
      }
    : total;

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const texts = value.flatMap((entry: unknown) =>
      typeof entry === 'object' &&
      entry !== null &&
      'text' in entry &&
      typeof entry.text === 'string'
        ? [entry.text]
        : [],
    );
    if (texts.length === value.length) return texts.join('\n');
  }
  return JSON.stringify(value) ?? '';
};

interface ToolView {
  readonly name: string;
  readonly input: unknown;
}

function toolView(item: ThreadItem): ToolView | null {
  switch (item.type) {
    case 'commandExecution':
      return { name: 'command', input: { command: item.command, cwd: item.cwd } };
    case 'fileChange':
      return {
        name: 'fileChange',
        input: {
          changes: item.changes.map((change) => ({ path: change.path, kind: change.kind.type })),
        },
      };
    case 'mcpToolCall':
      return { name: `${item.server}/${item.tool}`, input: item.arguments };
    case 'dynamicToolCall':
      return {
        name: item.namespace ? `${item.namespace}/${item.tool}` : item.tool,
        input: item.arguments,
      };
    case 'webSearch':
      return { name: 'webSearch', input: { query: item.query } };
    case 'imageView':
      return { name: 'imageView', input: { path: item.path } };
    default:
      return null;
  }
}

// Output and status of a finished tool item; output is null when nothing beyond the deltas exists.
function toolResult(item: ThreadItem): { output: string | null; ok: boolean } {
  switch (item.type) {
    case 'commandExecution':
      return {
        output: item.aggregatedOutput,
        ok: okStatuses.has(item.status) && (item.exitCode ?? 0) === 0,
      };
    case 'fileChange':
      return {
        output: item.changes.map((change) => change.diff).join('\n') || null,
        ok: okStatuses.has(item.status),
      };
    case 'mcpToolCall':
      return {
        output: item.error ? item.error.message : item.result ? textOf(item.result.content) : null,
        ok: okStatuses.has(item.status) && !item.error,
      };
    case 'dynamicToolCall':
      return {
        output: item.contentItems ? textOf(item.contentItems) : null,
        ok: okStatuses.has(item.status) && item.success !== false,
      };
    default:
      return { output: null, ok: true };
  }
}

// One codex app-server process per provider instance, started on first use and again after it
// exits. Maps wow threads to codex threads and codex's JSON-RPC to ProviderEvent.
export class CodexAdapter implements ProviderAdapter {
  readonly kind = 'codex';
  // Every turn/start carries the thread's model, so a step on Codex must name one.
  readonly requiresModel = true;
  readonly #options: CodexAdapterOptions;
  readonly #spawn: SpawnCodex;
  readonly #newId: () => string;
  readonly #listeners = new Set<(event: ProviderEvent) => void>();
  readonly #threads = new Map<string, ThreadState>();
  readonly #byCodexId = new Map<string, ThreadState>();
  readonly #approvals = new Map<string, OpenApproval>();
  readonly #inputs = new Map<string, OpenInput>();
  readonly #fingerprint: ProtocolFingerprint;
  readonly #compatibility: CompatibilityCache<CodexVersionVerdict>;
  #connection: CodexConnection | null = null;
  #ready: Promise<CodexConnection> | null = null;
  #serverVersion: string | null = null;
  // Per codex version: what a tools-only thread needs and this codex lacks.
  readonly #toolsOnlyLacks = new Map<string, Promise<string[]>>();
  #starts = 0;
  #disposed = false;

  constructor(options: CodexAdapterOptions) {
    this.#options = options;
    this.#spawn = options.spawn ?? spawnCodexAppServer;
    this.#newId = options.newId ?? randomUUID;
    this.#fingerprint = options.fingerprint ?? codexProtocolFingerprint;
    this.#compatibility = options.compatibility ?? new CompatibilityCache();
  }

  // How many app-server processes were started; a restart shows up as a second start.
  get starts(): number {
    return this.#starts;
  }

  // The codex version reported by the running app-server, once it answered initialize.
  get serverVersion(): string | null {
    return this.#serverVersion;
  }

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#connection?.close();
    this.#listeners.clear();
  }

  async send(command: ProviderCommand): Promise<unknown> {
    switch (command.type) {
      case 'startTurn':
        return this.#startTurn(command);
      case 'interrupt':
        return this.#interrupt(command.threadId);
      case 'closeThread':
        return this.#forget(command.threadId);
      case 'answerApproval':
        return this.#answerApproval(command.approvalId, command.decision);
      case 'answerQuestion':
        return this.#answerQuestion(command.questionId, command.answer);
      case 'setModel':
        // codex takes the model with every turn/start; the next startTurn carries the new one.
        return { appliesTo: 'nextTurn' };
      case 'setPermissionMode':
        permissionMode(command.permissionMode);
        return { appliesTo: 'nextTurn' };
      case 'listModels':
        return this.#listModels(await this.#connect());
      // A message written during a turn waits for it to end (agent workbench spec 51), and Codex
      // reports no slash commands of its own (spec 60).
      case 'handOver':
        return { taken: false } satisfies HandOverResult;
      case 'listCommands':
        return [];
      case 'test':
        return this.#test();
    }
  }

  #emit(event: ProviderEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  async #environment(): Promise<Record<string, string>> {
    const { instance, resolveEnv, baseEnv = process.env } = this.#options;
    let env: Record<string, string>;
    if (resolveEnv) env = await resolveEnv(instance.env);
    else {
      env = {};
      for (const [key, value] of Object.entries(instance.env)) {
        if (typeof value !== 'string')
          throw new CodexError(
            'state',
            `Environment variable ${key} is a secret and cannot be read here`,
          );
        env[key] = value;
      }
    }
    const base: Record<string, string> = {};
    for (const [key, value] of Object.entries(baseEnv)) if (value !== undefined) base[key] = value;
    if (instance.configDir) base['CODEX_HOME'] = instance.configDir;
    return { ...base, ...env };
  }

  #connect(): Promise<CodexConnection> {
    if (this.#disposed)
      return Promise.reject(new CodexError('state', 'The codex adapter was disposed'));
    this.#ready ??= this.#start();
    return this.#ready;
  }

  async #start(): Promise<CodexConnection> {
    try {
      const {
        instance,
        requestTimeoutMs,
        timers = systemTimers,
        clientVersion = '0.0.0',
      } = this.#options;
      const child = this.#spawn({
        binaryPath: instance.binaryPath || 'codex',
        launchArgs: instance.launchArgs,
        env: await this.#environment(),
      });
      this.#starts += 1;
      const connection: CodexConnection = new CodexConnection(
        child,
        {
          notification: (message) => this.#notification(message),
          request: (message) => this.#request(connection, message),
          exit: (error) => this.#exited(connection, error),
        },
        requestTimeoutMs,
        timers,
      );
      this.#connection = connection;
      const initialized = await connection.request('initialize', {
        clientInfo: { name: 'wow', title: 'wow', version: clientVersion },
        capabilities: null,
      });
      connection.notify('initialized');
      this.#serverVersion = codexVersionFromUserAgent(initialized.userAgent);
      return connection;
    } catch (error) {
      this.#connection?.close();
      this.#ready = null;
      throw error;
    }
  }

  #exited(connection: CodexConnection, error: CodexError): void {
    if (this.#connection !== connection) return;
    this.#connection = null;
    this.#ready = null;
    this.#approvals.clear();
    this.#inputs.clear();
    for (const thread of this.#threads.values()) {
      thread.loaded = false;
      if (thread.turnId && !this.#disposed)
        this.#emit({ type: 'turnFailed', threadId: thread.wowId, error: error.message });
      thread.turnId = null;
    }
  }

  async #startTurn(command: StartTurn): Promise<unknown> {
    try {
      const { toolset } = command;
      const mode = toolset ? toolsOnlyMode : permissionMode(command.permissionMode);
      const connection = await this.#connect();
      let thread = this.#threads.get(command.threadId);
      if (thread?.turnId) throw new CodexError('state', 'A turn is already running in this thread');
      if (thread && thread.toolsOnly !== (toolset !== undefined))
        throw new CodexError(
          'state',
          `This thread was started ${thread.toolsOnly ? 'with' : 'without'} the app's tools only and cannot change that`,
        );
      if (!thread || !thread.loaded) {
        if (toolset) await this.#requireToolsOnly();
        const settings = {
          cwd: command.cwd,
          model: command.model,
          approvalPolicy: mode.approvalPolicy,
          sandbox: mode.sandbox,
          ...(toolset ? toolsOnlySettings(toolset, command.instructions) : {}),
        };
        const resumeId = thread?.codexId ?? command.resumeId;
        const response = resumeId
          ? await connection.request('thread/resume', {
              threadId: resumeId,
              ...settings,
              excludeTurns: true,
            })
          : await connection.request('thread/start', settings);
        thread = this.#register(
          command.threadId,
          response.thread.id,
          mode.sandbox,
          toolset !== undefined,
        );
        this.#emit({
          type: 'session',
          threadId: command.threadId,
          providerSessionId: thread.codexId,
        });
      }
      const params: TurnStartParams = {
        threadId: thread.codexId,
        input: [{ type: 'text', text: command.prompt, text_elements: [] }],
        cwd: command.cwd,
        model: command.model,
        effort: command.effort,
        approvalPolicy: mode.approvalPolicy,
      };
      if (toolset) {
        params.sandboxPolicy = toolsOnlySandbox;
      } else if (mode.sandbox !== thread.sandbox) {
        params.sandboxPolicy = sandboxPolicy(mode.sandbox);
        thread.sandbox = mode.sandbox;
      }
      thread.starting = true;
      const started = thread;
      const { turn } = await connection
        .request('turn/start', params)
        .finally(() => (started.starting = false));
      if (turn.id !== thread.lastFinishedTurnId) thread.turnId = turn.id;
      return { providerSessionId: thread.codexId, turnId: turn.id };
    } catch (error) {
      // Reported as an event too, so the thread never stays "working" on a turn that never began.
      const message = error instanceof Error ? error.message : String(error);
      this.#emit({ type: 'turnFailed', threadId: command.threadId, error: message });
      throw error;
    }
  }

  // A tools-only thread needs options an older or newer codex may not have. The tested version
  // has them (the generated types say so); any other is asked for its schema, once per version.
  async #requireToolsOnly(): Promise<void> {
    const version = this.#serverVersion;
    const tested = this.#fingerprint.codexVersion;
    if (version === tested) return;
    const sentence = (why: string) =>
      new CodexError(
        'unsupported',
        `${why}, so the assistant cannot run on it. Update codex to ${tested}.`,
      );
    if (!version)
      throw sentence(
        "This codex does not report its version and wow cannot tell whether it takes wow's tools",
      );
    let lacks = this.#toolsOnlyLacks.get(version);
    if (!lacks) {
      lacks = (async () =>
        installedCodexLacks(toolsOnlyUses, this.#options.generateSchema ?? generateJsonSchema, {
          binaryPath: this.#options.instance.binaryPath || 'codex',
          env: await this.#environment(),
          timeoutMs: (this.#options.testTimeoutMs ?? (() => defaultTestTimeoutMs))(),
        }))();
      this.#toolsOnlyLacks.set(version, lacks);
      lacks.catch(() => this.#toolsOnlyLacks.delete(version));
    }
    let missing: string[];
    try {
      missing = await lacks;
    } catch (error) {
      if (error instanceof CodexError && error.code === 'unsupported')
        throw sentence(
          `codex ${version} cannot describe its app-server protocol and wow cannot tell whether it takes wow's tools`,
        );
      throw error;
    }
    if (missing.length > 0)
      throw sentence(
        `codex ${version} cannot be given wow's tools when a thread starts (it has no ${missing.join(', ')})`,
      );
  }

  #register(wowId: string, codexId: string, sandbox: SandboxMode, toolsOnly: boolean): ThreadState {
    const previous = this.#threads.get(wowId);
    if (previous) this.#byCodexId.delete(previous.codexId);
    const thread: ThreadState = {
      wowId,
      codexId,
      loaded: true,
      sandbox,
      toolsOnly,
      turnId: null,
      starting: false,
      lastFinishedTurnId: null,
      lastError: null,
      usageTotal: previous?.usageTotal ?? null,
      usageBaseline: null,
      streamed: new Set(),
      fileChanges: new Map(),
    };
    this.#threads.set(wowId, thread);
    this.#byCodexId.set(codexId, thread);
    return thread;
  }

  // The app-server has no request that unloads a thread, so the adapter forgets it: the next
  // turn of the wow thread starts or resumes a codex thread from what that command says.
  #forget(threadId: string): unknown {
    const thread = this.#threads.get(threadId);
    if (!thread) return { closed: false };
    this.#threads.delete(threadId);
    this.#byCodexId.delete(thread.codexId);
    for (const [id, approval] of this.#approvals)
      if (approval.codexThreadId === thread.codexId) this.#approvals.delete(id);
    for (const [id, input] of this.#inputs)
      if (input.codexThreadId === thread.codexId) this.#inputs.delete(id);
    return { closed: true };
  }

  async #interrupt(threadId: string): Promise<unknown> {
    const thread = this.#threads.get(threadId);
    const connection = this.#connection;
    if (!thread?.turnId || !connection) return { interrupted: false };
    await connection.request('turn/interrupt', { threadId: thread.codexId, turnId: thread.turnId });
    return { interrupted: true };
  }

  #answerApproval(approvalId: string, decision: ApprovalDecision): unknown {
    const approval = this.#approvals.get(approvalId);
    const connection = this.#connection;
    if (!approval || !connection)
      throw new CodexError('state', `No open codex approval ${approvalId}`);
    this.#approvals.delete(approvalId);
    const accept =
      decision === 'allowOnce'
        ? 'accept'
        : decision === 'allowSession'
          ? 'acceptForSession'
          : 'decline';
    switch (approval.method) {
      case 'item/commandExecution/requestApproval':
        connection.respond(approval.requestId, approval.method, { decision: accept });
        break;
      case 'item/fileChange/requestApproval':
        connection.respond(approval.requestId, approval.method, { decision: accept });
        break;
      case 'item/permissions/requestApproval': {
        const params = approval.params as ServerRequests[typeof approval.method]['params'];
        const granted: ServerRequests[typeof approval.method]['result']['permissions'] = {};
        if (decision !== 'deny') {
          if (params.permissions.network) granted.network = params.permissions.network;
          if (params.permissions.fileSystem) granted.fileSystem = params.permissions.fileSystem;
        }
        connection.respond(approval.requestId, approval.method, {
          permissions: granted,
          scope: decision === 'allowSession' ? 'session' : 'turn',
        });
        break;
      }
    }
    return { ok: true };
  }

  #answerQuestion(questionId: string, answer: QuestionReply): unknown {
    const entry = [...this.#inputs.entries()].find(([, input]) => input.questions.has(questionId));
    const connection = this.#connection;
    if (!entry || !connection)
      throw new CodexError('state', `No open codex question ${questionId}`);
    const [key, input] = entry;
    input.answers.set(questionId, answer);
    // codex asks several questions in one request and takes the answers together.
    if (input.answers.size < input.questions.size)
      return { ok: true, waitingFor: input.questions.size - input.answers.size };
    this.#inputs.delete(key);
    const answers: Record<string, { answers: string[] }> = {};
    // codex takes a list of answers per question: each picked label, then the typed text as an
    // answer of its own (its "other" answer has no other form in the protocol).
    for (const [wowId, codexId] of input.questions) {
      const reply = input.answers.get(wowId) ?? { picked: [], text: '' };
      const text = reply.text.trim();
      answers[codexId] = { answers: [...reply.picked, ...(text === '' ? [] : [text])] };
    }
    connection.respond(input.requestId, 'item/tool/requestUserInput', { answers });
    return { ok: true, waitingFor: 0 };
  }

  async #listModels(connection: CodexConnection): Promise<CodexModel[]> {
    const models: CodexModel[] = [];
    let cursor: string | null = null;
    do {
      const page: ModelListResponse = await connection.request('model/list', {
        cursor,
        includeHidden: false,
      });
      for (const model of page.data)
        if (!model.hidden)
          models.push({
            id: model.model,
            label: model.displayName,
            description: model.description,
            efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
            defaultEffort: model.defaultReasoningEffort,
            isDefault: model.isDefault,
            ...imageInputOf(model),
          });
      cursor = page.nextCursor;
    } while (cursor);
    return models;
  }

  async #test(): Promise<CodexTestResult> {
    const connection = await this.#connect();
    const version = this.#serverVersion;
    const tested = this.#fingerprint.codexVersion;
    if (!version)
      throw new CodexError(
        'unsupported',
        `This codex does not report its version, so wow cannot check it against the tested codex ${tested}. Install codex ${tested}.`,
      );
    const verdict = version === tested ? null : await this.#verdict(version);
    if (verdict && !verdict.ok)
      return {
        ok: false,
        account: null,
        version,
        message: verdict.message,
        update: verdict.update,
        models: [],
      };
    const { account, requiresOpenaiAuth } = await connection.request('account/read', {
      refreshToken: false,
    });
    if (!account && requiresOpenaiAuth) {
      const home = this.#options.instance.configDir || '~/.codex';
      throw new CodexError(
        'auth',
        `codex is not logged in. Run "codex login" with CODEX_HOME=${home}, then test again.`,
      );
    }
    return {
      ok: true,
      account: account ? accountLabel(account) : 'No login required',
      version,
      message: verdict?.message ?? null,
      update: verdict?.update ?? null,
      models: await this.#listModels(connection),
    };
  }

  // Whether an installed codex other than the tested one speaks what the adapter needs, from the
  // schema that codex generates, and how to get the tested version. Kept per binary and version.
  #verdict(version: string): Promise<CodexVersionVerdict> {
    const binaryPath = this.#options.instance.binaryPath || 'codex';
    return this.#compatibility.get(binaryPath, version, async () => {
      const tested = this.#fingerprint.codexVersion;
      const launch: SchemaLaunch = {
        binaryPath,
        env: await this.#environment(),
        timeoutMs: (this.#options.testTimeoutMs ?? (() => defaultTestTimeoutMs))(),
      };
      const check = await checkInstalledCodex(
        this.#fingerprint,
        this.#options.generateSchema ?? generateJsonSchema,
        launch,
      );
      const older = (compareCodexVersions(version, tested) ?? 0) < 0;
      if (check.state === 'compatible') {
        const without =
          check.doesWithout.length > 0 ? ` (wow does without ${check.doesWithout.join(', ')})` : '';
        return {
          ok: true,
          message: `codex ${version} differs from the tested ${tested}; compatible${without}.`,
          update: older ? await this.#updateOffer('older', launch) : null,
        };
      }
      const reason =
        check.state === 'incompatible'
          ? `codex ${version} is not compatible with wow, which is tested with codex ${tested}: ${check.problems.join('; ')}.`
          : `codex ${version} cannot describe its app-server protocol ("codex app-server generate-json-schema" failed: ${check.detail}), so wow cannot check it against the tested codex ${tested}.`;
      return {
        ok: false,
        message: `${reason} Update codex to ${tested}.`,
        update: await this.#updateOffer('incompatible', launch),
      };
    });
  }

  async #updateOffer(
    reason: ProviderUpdate['reason'],
    launch: SchemaLaunch,
  ): Promise<ProviderUpdate> {
    const io: InstallIo = { ...(this.#options.installIo ?? systemInstallIo), env: launch.env };
    const install = detectCodexInstall(launch.binaryPath, io);
    let npmGlobalPrefix: string | null = null;
    if (install.method === 'npm') {
      const run = await (this.#options.runCommand ?? runCommand)({
        file: io.platform === 'win32' ? 'npm.cmd' : 'npm',
        args: ['prefix', '-g'],
        env: launch.env,
        timeoutMs: launch.timeoutMs,
      });
      const printed = run.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? '';
      npmGlobalPrefix = run.code === 0 && printed !== '' ? printed : null;
    }
    return codexUpdateOffer({
      install,
      targetVersion: this.#fingerprint.codexVersion,
      reason,
      npmGlobalPrefix,
      platform: io.platform,
    });
  }

  #request(connection: CodexConnection, message: ServerRequest): void {
    const params: unknown = message.params;
    const codexThreadId = isRecord(params) ? params['threadId'] : undefined;
    const thread =
      typeof codexThreadId === 'string' ? this.#byCodexId.get(codexThreadId) : undefined;
    if (!thread) {
      connection.respondError(message.id, -32602, 'wow does not know this thread');
      return;
    }
    const threadId = thread.wowId;
    // A tools-only thread never gets more than it started with, and the user is not asked.
    if (thread.toolsOnly) {
      switch (message.method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval':
          connection.respond(message.id, message.method, { decision: 'decline' });
          return;
        case 'item/permissions/requestApproval':
          connection.respond(message.id, message.method, { permissions: {}, scope: 'turn' });
          return;
        default:
          break;
      }
    }
    switch (message.method) {
      case 'item/commandExecution/requestApproval': {
        const approvalId = this.#newId();
        this.#approvals.set(approvalId, {
          requestId: message.id,
          method: message.method,
          codexThreadId: thread.codexId,
          params: message.params,
        });
        const { command, reason } = message.params;
        this.#emit({
          type: 'approvalRequested',
          threadId,
          approvalId,
          kind: 'command',
          summary: command ?? reason ?? 'Run a command',
          request: message.params,
        });
        return;
      }
      case 'item/fileChange/requestApproval': {
        const approvalId = this.#newId();
        this.#approvals.set(approvalId, {
          requestId: message.id,
          method: message.method,
          codexThreadId: thread.codexId,
          params: message.params,
        });
        const changes = thread.fileChanges.get(message.params.itemId);
        this.#emit({
          type: 'approvalRequested',
          threadId,
          approvalId,
          kind: 'fileChange',
          summary: message.params.reason ?? 'Apply file changes',
          request: { ...message.params, changes },
        });
        return;
      }
      case 'item/permissions/requestApproval': {
        const approvalId = this.#newId();
        this.#approvals.set(approvalId, {
          requestId: message.id,
          method: message.method,
          codexThreadId: thread.codexId,
          params: message.params,
        });
        this.#emit({
          type: 'approvalRequested',
          threadId,
          approvalId,
          kind: 'tool',
          summary: message.params.reason ?? 'Grant additional permissions',
          request: message.params,
        });
        return;
      }
      case 'item/tool/requestUserInput': {
        const input: OpenInput = {
          requestId: message.id,
          codexThreadId: thread.codexId,
          questions: new Map(),
          answers: new Map(),
        };
        const asked: ProviderEvent[] = [];
        // The questions of one request are answered together.
        const askId = message.params.itemId;
        for (const question of message.params.questions) {
          const questionId = this.#newId();
          input.questions.set(questionId, question.id);
          asked.push({
            type: 'questionAsked',
            threadId,
            questionId,
            question: question.question,
            ...(question.header.trim() ? { header: question.header.trim() } : {}),
            askId,
            options: (question.options ?? []).map((option) =>
              markRecommended({ label: option.label, description: option.description }),
            ),
            multiSelect: false,
          });
        }
        if (input.questions.size === 0) {
          connection.respond(message.id, message.method, { answers: {} });
          return;
        }
        this.#inputs.set(this.#newId(), input);
        for (const event of asked) this.#emit(event);
        return;
      }
    }
  }

  // Notifications of methods the adapter does not know, or without params, are dropped here: a
  // newer codex may send more than the tested one.
  #notification(message: ServerNotification): void {
    const params: unknown = message.params;
    if (!isRecord(params)) return;
    if (message.method === 'serverRequest/resolved') {
      this.#forgetRequest(message.params.requestId);
      return;
    }
    const codexThreadId = params['threadId'];
    if (typeof codexThreadId !== 'string') return;
    const thread = this.#byCodexId.get(codexThreadId);
    if (!thread) return;
    const threadId = thread.wowId;
    switch (message.method) {
      case 'turn/started':
        // A turn codex started without a turn/start of wow is still a turn of the thread.
        if (
          thread.turnId === null &&
          !thread.starting &&
          message.params.turn.id !== thread.lastFinishedTurnId
        ) {
          this.#emit({ type: 'turnStartedByProvider', threadId });
        }
        thread.turnId = message.params.turn.id;
        thread.usageBaseline = thread.usageTotal;
        return;
      case 'turn/completed':
        this.#turnCompleted(thread, message.params.turn);
        return;
      case 'error':
        if (!message.params.willRetry) {
          const { message: text, additionalDetails } = message.params.error;
          thread.lastError = additionalDetails ? `${text} (${additionalDetails})` : text;
        }
        return;
      case 'thread/tokenUsage/updated': {
        const { total, last, modelContextWindow } = message.params.tokenUsage;
        thread.usageTotal = total;
        if (modelContextWindow && modelContextWindow > 0)
          this.#emit({
            type: 'contextUsage',
            threadId,
            usedTokens: last.totalTokens,
            maxTokens: modelContextWindow,
          });
        return;
      }
      case 'turn/plan/updated':
        this.#emit({
          type: 'taskListUpdated',
          threadId,
          tasks: message.params.plan.map((step, index) => ({
            id: `${message.params.turnId}-${index}`,
            content: step.step,
            status: taskStatus(step.status),
          })),
        });
        return;
      case 'item/agentMessage/delta':
        thread.streamed.add(message.params.itemId);
        this.#emit({
          type: 'textDelta',
          threadId,
          itemId: message.params.itemId,
          delta: message.params.delta,
        });
        return;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        thread.streamed.add(message.params.itemId);
        this.#emit({
          type: 'reasoningDelta',
          threadId,
          itemId: message.params.itemId,
          delta: message.params.delta,
        });
        return;
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
        thread.streamed.add(message.params.itemId);
        this.#emit({
          type: 'toolCallOutput',
          threadId,
          itemId: message.params.itemId,
          output: message.params.delta,
        });
        return;
      case 'item/started': {
        const { item } = message.params;
        if (item.type === 'fileChange') thread.fileChanges.set(item.id, item.changes);
        const view = toolView(item);
        if (view) this.#emit({ type: 'toolCallStarted', threadId, itemId: item.id, ...view });
        return;
      }
      case 'item/completed':
        this.#itemCompleted(thread, message.params.item);
        return;
    }
  }

  #itemCompleted(thread: ThreadState, item: ThreadItem): void {
    const threadId = thread.wowId;
    const streamed = thread.streamed.delete(item.id);
    if (item.type === 'agentMessage') {
      if (!streamed && item.text)
        this.#emit({ type: 'textDelta', threadId, itemId: item.id, delta: item.text });
      return;
    }
    if (item.type === 'reasoning') {
      const text = item.summary.join('\n');
      if (!streamed && text)
        this.#emit({ type: 'reasoningDelta', threadId, itemId: item.id, delta: text });
      return;
    }
    if (!toolView(item)) return;
    thread.fileChanges.delete(item.id);
    const { output, ok } = toolResult(item);
    if (!streamed && output)
      this.#emit({ type: 'toolCallOutput', threadId, itemId: item.id, output });
    this.#emit({
      type: 'toolCallCompleted',
      threadId,
      itemId: item.id,
      status: ok ? 'ok' : 'error',
    });
  }

  #turnCompleted(
    thread: ThreadState,
    turn: Extract<ServerNotification, { method: 'turn/completed' }>['params']['turn'],
  ): void {
    const threadId = thread.wowId;
    if (turn.status === 'inProgress') return;
    if (thread.usageTotal) {
      const usage = subtract(thread.usageTotal, thread.usageBaseline);
      this.#emit({
        type: 'usage',
        threadId,
        inputTokens: Math.max(0, usage.inputTokens),
        outputTokens: Math.max(0, usage.outputTokens),
        cachedInputTokens: Math.max(0, usage.cachedInputTokens),
      });
    }
    const error = turn.error?.message ?? thread.lastError ?? 'The codex turn failed';
    thread.turnId = null;
    thread.lastFinishedTurnId = turn.id;
    thread.lastError = null;
    thread.usageBaseline = null;
    thread.streamed.clear();
    thread.fileChanges.clear();
    // Requests of a finished turn can no longer be answered.
    for (const [id, approval] of this.#approvals)
      if (approval.codexThreadId === thread.codexId) this.#approvals.delete(id);
    for (const [id, input] of this.#inputs)
      if (input.codexThreadId === thread.codexId) this.#inputs.delete(id);
    if (turn.status === 'completed') this.#emit({ type: 'turnCompleted', threadId });
    else if (turn.status === 'interrupted') this.#emit({ type: 'turnInterrupted', threadId });
    else this.#emit({ type: 'turnFailed', threadId, error });
  }

  #forgetRequest(requestId: RequestId): void {
    for (const [id, approval] of this.#approvals)
      if (approval.requestId === requestId) this.#approvals.delete(id);
    for (const [id, input] of this.#inputs)
      if (input.requestId === requestId) this.#inputs.delete(id);
  }
}

export const createCodexAdapter = (options: CodexAdapterOptions): CodexAdapter =>
  new CodexAdapter(options);
