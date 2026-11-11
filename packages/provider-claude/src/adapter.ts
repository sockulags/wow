import {
  query as sdkQuery,
  type AccountInfo,
  type ModelInfo,
  type PermissionResult,
  type PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  ApprovalDecision,
  ApprovalKind,
  ProviderAdapter,
  ProviderAdapterContext,
  ProviderCommand,
  ProviderEvent,
  ProviderInstance,
  ProviderModel,
  ProviderTestResult,
  TaskStatus,
} from '@wow/contracts';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { AsyncQueue } from './queue.js';
import {
  extraArgs,
  isEffortLevel,
  isPermissionMode,
  userMessage,
  type CanUseTool,
  type ClaudeQuery,
  type Options,
  type QueryFunction,
  type SDKMessage,
  type SDKUserMessage,
} from './sdk.js';

type StartTurn = Extract<ProviderCommand, { type: 'startTurn' }>;
type Toolset = NonNullable<StartTurn['toolset']>;
type Listener = (event: ProviderEvent) => void;
type PermissionOptions = Parameters<CanUseTool>[2];

// The mode of a turn that only has the app's tools: what is not allowed is denied, never asked.
const toolsOnlyMode = 'dontAsk';
// How Claude Code names the tools of an MCP server.
const toolPrefix = (toolset: Toolset) => `mcp__${toolset.name}__`;

// "default" leaves the effort to Claude Code (the model's default or the user's /effort).
const defaultEffort = 'default';
const testPrompt = 'Reply with the single word OK.';
const stderrLines = 20;

const TodoWriteInput = z.object({
  todos: z.array(
    z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) }),
  ),
});
const TaskCreateInput = z.object({ subject: z.string() });
const TaskCreateResult = z.object({
  task: z.object({ id: z.string().min(1), subject: z.string() }),
});
const TaskUpdateInput = z.object({
  taskId: z.string().min(1),
  subject: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']).optional(),
});
const AskUserQuestionInput = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        options: z.array(
          z.object({ label: z.string().min(1), description: z.string().optional() }),
        ),
        multiSelect: z.boolean().optional(),
      }),
    )
    .min(1),
});

interface Task {
  readonly id: string;
  content: string;
  status: TaskStatus;
}

interface Session {
  readonly threadId: string;
  readonly input: AsyncQueue<SDKUserMessage>;
  readonly stderr: string[];
  query: ClaudeQuery | undefined;
  model: string;
  effort: string;
  permissionMode: string;
  // Started with a toolset: only the app's tools, for the life of the session.
  readonly toolsOnly: boolean;
  // The instruction text the session was opened with; a turn with another text reopens it.
  readonly instructions: string | undefined;
  providerSessionId: string | undefined;
  turnActive: boolean;
  interrupted: boolean;
  messageId: string;
  // Text streamed per item id, so a complete assistant message does not repeat it.
  readonly streamed: Map<string, string>;
  readonly taskCreates: Map<string, string>;
  readonly tasks: Map<string, Task>;
  // total_cost_usd is cumulative per query(); a turn's cost is the difference.
  costUsd: number;
}

interface Pending<T> {
  readonly threadId: string;
  resolve(value: T | undefined): void;
}

export interface ClaudeAdapterOptions {
  // Replaces the Agent SDK's query(), for tests.
  readonly query?: QueryFunction;
  readonly baseEnv?: Record<string, string | undefined>;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const approvalKind = (toolName: string): ApprovalKind => {
  if (toolName === 'Bash' || toolName === 'PowerShell') return 'command';
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return 'fileChange';
  return 'tool';
};

function describeAccount(account: AccountInfo | undefined): string | null {
  if (!account) return null;
  if (account.email)
    return account.organization ? `${account.email} (${account.organization})` : account.email;
  if (account.organization) return account.organization;
  if (account.apiKeySource) return `API key from ${account.apiKeySource}`;
  return account.apiProvider ?? null;
}

const toProviderModel = (model: ModelInfo): ProviderModel => ({
  id: model.value,
  label: model.displayName,
  description: model.description,
  efforts: model.supportedEffortLevels ?? [],
});

const toolOutput = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) => {
      if (block && typeof block === 'object' && 'type' in block) {
        if (block.type === 'text' && 'text' in block && typeof block.text === 'string')
          return block.text;
        return `[${String(block.type)}]`;
      }
      return '';
    })
    .join('\n');
};

// One adapter per provider instance. Each thread gets one Agent SDK query() in streaming input
// mode that lives across turns, so interrupt, setModel and setPermissionMode work mid-session.
export class ClaudeAdapter implements ProviderAdapter {
  readonly kind = 'claude' as const;
  readonly #instance: ProviderInstance;
  readonly #context: ProviderAdapterContext;
  readonly #query: QueryFunction;
  readonly #baseEnv: Record<string, string | undefined>;
  readonly #sessions = new Map<string, Session>();
  readonly #approvals = new Map<string, Pending<ApprovalDecision>>();
  readonly #questions = new Map<string, Pending<string>>();
  readonly #listeners = new Set<Listener>();

  constructor(
    instance: ProviderInstance,
    context: ProviderAdapterContext,
    options: ClaudeAdapterOptions = {},
  ) {
    this.#instance = instance;
    this.#context = context;
    this.#query = options.query ?? ((params) => sdkQuery(params));
    this.#baseEnv = options.baseEnv ?? process.env;
  }

  onEvent(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async send(command: ProviderCommand): Promise<unknown> {
    switch (command.type) {
      case 'startTurn':
        await this.#startTurn(command);
        return { ok: true };
      case 'interrupt':
        await this.#interrupt(command.threadId);
        return { ok: true };
      case 'answerApproval':
        this.#settle(this.#approvals, command.approvalId, command.decision, 'approval');
        return { ok: true };
      case 'answerQuestion':
        this.#settle(this.#questions, command.questionId, command.answer, 'question');
        return { ok: true };
      case 'closeThread':
        this.#close(command.threadId);
        return { ok: true };
      case 'setModel': {
        const session = this.#sessions.get(command.threadId);
        if (session?.query && session.model !== command.model) {
          await session.query.setModel(command.model);
          session.model = command.model;
        }
        return { ok: true };
      }
      case 'setPermissionMode': {
        const mode = command.permissionMode;
        if (!isPermissionMode(mode)) throw new Error(`Unknown Claude permission mode "${mode}"`);
        const session = this.#sessions.get(command.threadId);
        if (session?.query && !session.toolsOnly && session.permissionMode !== mode) {
          await session.query.setPermissionMode(mode);
          session.permissionMode = mode;
        }
        return { ok: true };
      }
      case 'listModels':
        return this.#listModels();
      case 'test':
        return this.#test();
    }
  }

  async dispose(): Promise<void> {
    for (const session of this.#sessions.values()) {
      this.#cancelPending(session.threadId);
      session.input.end();
      session.query?.close();
    }
    this.#sessions.clear();
    this.#listeners.clear();
    return Promise.resolve();
  }

  #emit(event: ProviderEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  // Ends the thread's live session without a turn event; the next turn opens a new one.
  #close(threadId: string): void {
    const session = this.#sessions.get(threadId);
    if (!session) return;
    this.#sessions.delete(threadId);
    this.#cancelPending(threadId);
    session.input.end();
    session.query?.close();
  }

  #options(env: Record<string, string>, stderr: string[]): Options {
    const options: Options = {
      env: {
        ...this.#baseEnv,
        CLAUDE_AGENT_SDK_CLIENT_APP: 'wow',
        ...(this.#instance.configDir ? { CLAUDE_CONFIG_DIR: this.#instance.configDir } : {}),
        ...env,
      },
      // Skills, plugins and CLAUDE.md load the same way they do in the terminal.
      settingSources: ['user', 'project', 'local'],
      extraArgs: extraArgs(this.#instance.launchArgs),
      stderr: (data) => {
        stderr.push(data.trimEnd());
        if (stderr.length > stderrLines) stderr.shift();
      },
    };
    if (this.#instance.binaryPath) options.pathToClaudeCodeExecutable = this.#instance.binaryPath;
    return options;
  }

  // What a turn with a toolset changes (app assistant spec 2): the agent gets the app's MCP
  // server and nothing else. No built-in tool, so no file, shell or network tool; no settings of
  // the user or a project, so none of their permission rules, hooks, plugins, skills, MCP servers
  // or CLAUDE.md; no launch arguments, which could bring any of those back.
  #toolsOnly(options: Options, toolset: Toolset, instructions: string | undefined): void {
    options.settingSources = [];
    options.extraArgs = {};
    options.tools = [];
    options.mcpServers = {
      [toolset.name]: {
        type: 'http',
        url: toolset.url,
        headers: { Authorization: `Bearer ${toolset.token}` },
      },
    };
    options.strictMcpConfig = true;
    options.allowedTools = [`${toolPrefix(toolset)}*`];
    options.permissionMode = toolsOnlyMode;
    // Should Claude Code ask all the same, the answer is no for anything but the app's tools.
    options.canUseTool = (toolName, input) =>
      Promise.resolve(
        toolName.startsWith(toolPrefix(toolset))
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: `This conversation only has the ${toolset.name} tools.` },
      );
    if (instructions !== undefined) options.systemPrompt = instructions;
  }

  async #startTurn(input: StartTurn): Promise<void> {
    const command: StartTurn = input.toolset ? { ...input, permissionMode: toolsOnlyMode } : input;
    if (command.effort !== defaultEffort && !isEffortLevel(command.effort)) {
      throw new Error(`Unknown Claude effort "${command.effort}"`);
    }
    if (!isPermissionMode(command.permissionMode)) {
      throw new Error(`Unknown Claude permission mode "${command.permissionMode}"`);
    }
    let session = this.#sessions.get(command.threadId);
    if (session?.turnActive)
      throw new Error(`Thread ${command.threadId} already has a running turn`);
    if (session && session.toolsOnly !== (command.toolset !== undefined)) {
      throw new Error(
        `Thread ${command.threadId} was started ${session.toolsOnly ? 'with' : 'without'} the app's tools only and cannot change that`,
      );
    }
    // The instruction text is fixed when Claude Code starts, so a changed text needs a new
    // process. It goes on with the same conversation.
    if (session?.toolsOnly && session.instructions !== command.instructions) {
      const resumeId = command.resumeId ?? session.providerSessionId;
      this.#close(command.threadId);
      session = await this.#open({ ...command, ...(resumeId ? { resumeId } : {}) });
    } else if (session?.query) {
      const query = session.query;
      if (session.model !== command.model) await query.setModel(command.model);
      if (session.permissionMode !== command.permissionMode)
        await query.setPermissionMode(command.permissionMode);
      if (session.effort !== command.effort) {
        await query.applyFlagSettings({
          effortLevel: isEffortLevel(command.effort) ? command.effort : null,
        });
      }
      session.model = command.model;
      session.permissionMode = command.permissionMode;
      session.effort = command.effort;
    } else {
      session = await this.#open(command);
    }
    session.turnActive = true;
    session.interrupted = false;
    session.input.push(userMessage(command.prompt));
  }

  async #open(command: StartTurn): Promise<Session> {
    const session: Session = {
      threadId: command.threadId,
      input: new AsyncQueue<SDKUserMessage>(),
      stderr: [],
      query: undefined,
      model: command.model,
      effort: command.effort,
      permissionMode: command.permissionMode,
      toolsOnly: command.toolset !== undefined,
      instructions: command.toolset ? command.instructions : undefined,
      providerSessionId: command.resumeId,
      turnActive: false,
      interrupted: false,
      messageId: '',
      streamed: new Map(),
      taskCreates: new Map(),
      tasks: new Map(),
      costUsd: 0,
    };
    // Claimed before the await so a second startTurn for the thread sees it.
    this.#sessions.set(command.threadId, session);
    try {
      const options = this.#options(await this.#context.resolveEnv(), session.stderr);
      options.cwd = command.cwd;
      options.model = command.model;
      options.includePartialMessages = true;
      options.canUseTool = (toolName, input, permission) =>
        this.#permission(session, toolName, input, permission);
      if (isEffortLevel(command.effort)) options.effort = command.effort;
      if (isPermissionMode(command.permissionMode)) {
        options.permissionMode = command.permissionMode;
        if (command.permissionMode === 'bypassPermissions')
          options.allowDangerouslySkipPermissions = true;
      }
      if (command.resumeId) options.resume = command.resumeId;
      if (command.toolset) this.#toolsOnly(options, command.toolset, command.instructions);
      session.query = this.#query({ prompt: session.input, options });
    } catch (error) {
      this.#sessions.delete(command.threadId);
      throw error;
    }
    void this.#pump(session);
    return session;
  }

  async #pump(session: Session): Promise<void> {
    let failure: string | undefined;
    try {
      if (!session.query) return;
      for await (const message of session.query) await this.#handle(session, message);
    } catch (error) {
      failure = describeError(error);
    } finally {
      // A session that was closed has given its thread up; a newer one may hold it by now.
      const current = this.#sessions.get(session.threadId) === session;
      if (current) this.#sessions.delete(session.threadId);
      session.input.end();
      if (current) this.#cancelPending(session.threadId);
      if (session.turnActive) {
        session.turnActive = false;
        if (session.interrupted) {
          this.#emit({ type: 'turnInterrupted', threadId: session.threadId });
        } else {
          const detail = session.stderr.at(-1);
          const error = failure ?? 'Claude Code stopped before the turn finished';
          this.#emit({
            type: 'turnFailed',
            threadId: session.threadId,
            error: detail ? `${error}: ${detail}` : error,
          });
        }
      }
    }
  }

  async #handle(session: Session, message: SDKMessage): Promise<void> {
    const threadId = session.threadId;
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init' && message.session_id !== session.providerSessionId) {
          session.providerSessionId = message.session_id;
          this.#emit({ type: 'session', threadId, providerSessionId: message.session_id });
        }
        return;
      case 'stream_event': {
        if (message.parent_tool_use_id !== null) return;
        const event = message.event;
        if (event.type === 'message_start') session.messageId = event.message.id;
        if (event.type !== 'content_block_delta') return;
        const itemId = `${session.messageId}:${event.index}`;
        if (event.delta.type === 'text_delta') {
          this.#stream(session, itemId, event.delta.text, 'textDelta');
        } else if (event.delta.type === 'thinking_delta') {
          this.#stream(session, itemId, event.delta.thinking, 'reasoningDelta');
        }
        return;
      }
      case 'assistant': {
        if (message.parent_tool_use_id !== null) return;
        const id = message.message.id;
        message.message.content.forEach((block, index) => {
          if (block.type === 'text' || block.type === 'thinking') {
            const text = block.type === 'text' ? block.text : block.thinking;
            const already = [...session.streamed].some(
              ([key, streamed]) => key.startsWith(`${id}:`) && streamed === text,
            );
            if (!already && text.length > 0) {
              this.#stream(
                session,
                `${id}:full:${index}`,
                text,
                block.type === 'text' ? 'textDelta' : 'reasoningDelta',
              );
            }
          } else if (block.type === 'tool_use') {
            this.#emit({
              type: 'toolCallStarted',
              threadId,
              itemId: block.id,
              name: block.name,
              input: block.input,
            });
            this.#trackTasks(session, block.id, block.name, block.input);
          }
        });
        return;
      }
      case 'user': {
        if (message.parent_tool_use_id !== null) return;
        const content = message.message.content;
        if (typeof content === 'string') return;
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          this.#emit({
            type: 'toolCallOutput',
            threadId,
            itemId: block.tool_use_id,
            output: toolOutput(block.content),
          });
          this.#emit({
            type: 'toolCallCompleted',
            threadId,
            itemId: block.tool_use_id,
            status: block.is_error ? 'error' : 'ok',
          });
          const subject = session.taskCreates.get(block.tool_use_id);
          const created = TaskCreateResult.safeParse(message.tool_use_result);
          if (subject !== undefined && created.success) {
            session.taskCreates.delete(block.tool_use_id);
            session.tasks.set(created.data.task.id, {
              id: created.data.task.id,
              content: subject,
              status: 'pending',
            });
            this.#emitTasks(session);
          }
        }
        return;
      }
      case 'result': {
        const usage = message.usage;
        const costUsd = Math.max(0, message.total_cost_usd - session.costUsd);
        session.costUsd = message.total_cost_usd;
        this.#emit({
          type: 'usage',
          threadId,
          inputTokens: usage.input_tokens + usage.cache_creation_input_tokens,
          outputTokens: usage.output_tokens,
          cachedInputTokens: usage.cache_read_input_tokens,
          costUsd,
        });
        if (session.query) {
          try {
            const context = await session.query.getContextUsage({ detail: 'summary' });
            if (context.maxTokens > 0) {
              this.#emit({
                type: 'contextUsage',
                threadId,
                usedTokens: Math.max(0, Math.round(context.totalTokens)),
                maxTokens: Math.round(context.maxTokens),
              });
            }
          } catch {
            // The context meter is optional; a turn does not fail because it is missing.
          }
        }
        session.turnActive = false;
        session.streamed.clear();
        if (session.interrupted) {
          this.#emit({ type: 'turnInterrupted', threadId });
        } else if (message.subtype !== 'success') {
          this.#emit({
            type: 'turnFailed',
            threadId,
            error: message.errors.join('\n') || message.subtype,
          });
        } else if (message.is_error) {
          this.#emit({ type: 'turnFailed', threadId, error: message.result });
        } else {
          this.#emit({ type: 'turnCompleted', threadId });
        }
        return;
      }
      default:
        return;
    }
  }

  #stream(
    session: Session,
    itemId: string,
    delta: string,
    type: 'textDelta' | 'reasoningDelta',
  ): void {
    session.streamed.set(itemId, (session.streamed.get(itemId) ?? '') + delta);
    this.#emit({ type, threadId: session.threadId, itemId, delta });
  }

  // Claude has two task list tools: TodoWrite replaces the whole list, TaskCreate and TaskUpdate
  // change one task. Either way the thread gets the whole list.
  #trackTasks(session: Session, toolUseId: string, name: string, input: unknown): void {
    if (name === 'TodoWrite') {
      const parsed = TodoWriteInput.safeParse(input);
      if (!parsed.success) return;
      session.tasks.clear();
      parsed.data.todos.forEach((todo, index) => {
        const id = String(index + 1);
        session.tasks.set(id, { id, content: todo.content, status: todo.status });
      });
      this.#emitTasks(session);
    } else if (name === 'TaskCreate') {
      const parsed = TaskCreateInput.safeParse(input);
      if (parsed.success) session.taskCreates.set(toolUseId, parsed.data.subject);
    } else if (name === 'TaskUpdate') {
      const parsed = TaskUpdateInput.safeParse(input);
      if (!parsed.success) return;
      const task = session.tasks.get(parsed.data.taskId);
      if (!task) return;
      if (parsed.data.status === 'deleted') session.tasks.delete(task.id);
      else {
        if (parsed.data.status) task.status = parsed.data.status;
        if (parsed.data.subject !== undefined) task.content = parsed.data.subject;
      }
      this.#emitTasks(session);
    }
  }

  #emitTasks(session: Session): void {
    this.#emit({
      type: 'taskListUpdated',
      threadId: session.threadId,
      tasks: [...session.tasks.values()].map((task) => ({ ...task })),
    });
  }

  async #permission(
    session: Session,
    toolName: string,
    input: Record<string, unknown>,
    options: PermissionOptions,
  ): Promise<PermissionResult> {
    const threadId = session.threadId;
    if (toolName === 'AskUserQuestion') return this.#ask(session, input, options);
    const approvalId = options.toolUseID;
    const request: Record<string, unknown> = { toolName, input };
    if (options.description) request['description'] = options.description;
    if (options.blockedPath) request['blockedPath'] = options.blockedPath;
    if (options.decisionReason) request['decisionReason'] = options.decisionReason;
    const decision = await this.#wait(this.#approvals, approvalId, threadId, options.signal, () =>
      this.#emit({
        type: 'approvalRequested',
        threadId,
        approvalId,
        kind: approvalKind(toolName),
        summary: options.title ?? toolName,
        request,
      }),
    );
    if (decision === undefined) {
      return { behavior: 'deny', message: 'The turn was interrupted.', interrupt: true };
    }
    if (decision === 'deny') return { behavior: 'deny', message: 'The user denied this request.' };
    if (decision === 'allowSession' && options.suggestions) {
      const updatedPermissions = options.suggestions.map((suggestion): PermissionUpdate => ({
        ...suggestion,
        destination: 'session',
      }));
      return { behavior: 'allow', updatedInput: input, updatedPermissions };
    }
    return { behavior: 'allow', updatedInput: input };
  }

  // AskUserQuestion asks one or more questions at once; each becomes a question in the thread and
  // the tool runs with the answers once all are answered.
  async #ask(
    session: Session,
    input: Record<string, unknown>,
    options: PermissionOptions,
  ): Promise<PermissionResult> {
    const parsed = AskUserQuestionInput.safeParse(input);
    if (!parsed.success) {
      return { behavior: 'deny', message: 'wow could not read the questions in this request.' };
    }
    const questions = parsed.data.questions;
    const answers = await Promise.all(
      questions.map((question, index) => {
        const questionId = `${options.toolUseID}:${index}`;
        return this.#wait(this.#questions, questionId, session.threadId, options.signal, () =>
          this.#emit({
            type: 'questionAsked',
            threadId: session.threadId,
            questionId,
            question: question.question,
            options: question.options.map((option) =>
              option.description === undefined
                ? { label: option.label }
                : { label: option.label, description: option.description },
            ),
            multiSelect: question.multiSelect ?? false,
          }),
        );
      }),
    );
    if (answers.some((answer) => answer === undefined)) {
      return { behavior: 'deny', message: 'The turn was interrupted.', interrupt: true };
    }
    return {
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers: Object.fromEntries(
          questions.map((question, index) => [question.question, answers[index] ?? '']),
        ),
      },
    };
  }

  #wait<T>(
    pending: Map<string, Pending<T>>,
    id: string,
    threadId: string,
    signal: AbortSignal,
    announce: () => void,
  ): Promise<T | undefined> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(undefined);
        return;
      }
      const onAbort = () => settle(undefined);
      const settle = (value: T | undefined) => {
        pending.delete(id);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.set(id, { threadId, resolve: settle });
      announce();
    });
  }

  #settle<T>(pending: Map<string, Pending<T>>, id: string, value: T, what: string): void {
    const waiting = pending.get(id);
    if (!waiting) throw new Error(`Claude is not waiting for ${what} ${id}`);
    waiting.resolve(value);
  }

  #cancelPending(threadId: string): void {
    for (const pending of [this.#approvals, this.#questions] as const) {
      for (const waiting of pending.values()) {
        if (waiting.threadId === threadId) waiting.resolve(undefined);
      }
    }
  }

  async #interrupt(threadId: string): Promise<void> {
    const session = this.#sessions.get(threadId);
    if (!session?.turnActive || !session.query) {
      // Nothing runs here (for example after a restart); say so, so the thread can settle.
      this.#emit({ type: 'turnInterrupted', threadId });
      return;
    }
    session.interrupted = true;
    this.#cancelPending(threadId);
    await session.query.interrupt();
  }

  // Opens a short-lived query that never receives a prompt, for questions about the installation.
  async #probe<T>(read: (query: ClaudeQuery) => Promise<T>): Promise<T> {
    const input = new AsyncQueue<SDKUserMessage>();
    const options = this.#options(await this.#context.resolveEnv(), []);
    options.persistSession = false;
    const query = this.#query({ prompt: input, options });
    try {
      return await read(query);
    } finally {
      input.end();
      query.close();
    }
  }

  async #listModels(): Promise<ProviderModel[]> {
    const live = [...this.#sessions.values()].find((session) => session.query)?.query;
    const models = live
      ? await live.supportedModels()
      : await this.#probe((query) => query.supportedModels());
    return models.map(toProviderModel);
  }

  // A trivial turn without tools: it proves the binary starts, the account can call the model,
  // and reports the account and the Claude Code version.
  async #test(): Promise<ProviderTestResult> {
    const stderr: string[] = [];
    const input = new AsyncQueue<SDKUserMessage>();
    input.push(userMessage(testPrompt));
    const abort = new AbortController();
    const timeoutMs = this.#context.testTimeoutMs();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let version: string | null = null;
    let account: Promise<AccountInfo | undefined> = Promise.resolve(undefined);
    let query: ClaudeQuery | undefined;
    try {
      const options = this.#options(await this.#context.resolveEnv(), stderr);
      Object.assign(options, {
        cwd: tmpdir(),
        maxTurns: 1,
        persistSession: false,
        permissionMode: 'dontAsk',
        tools: [],
        abortController: abort,
      } satisfies Options);
      query = this.#query({ prompt: input, options });
      const opened = query;
      for await (const message of opened) {
        if (message.type === 'system' && message.subtype === 'init') {
          version = message.claude_code_version;
          account = opened.accountInfo().catch(() => undefined);
        }
        if (message.type !== 'result') continue;
        input.end();
        const ok = message.subtype === 'success' && !message.is_error;
        const failure = message.subtype === 'success' ? message.result : message.errors.join('\n');
        return {
          ok,
          account: describeAccount(await account),
          version,
          message: ok ? null : failure || message.subtype,
        };
      }
      return {
        ok: false,
        account: null,
        version,
        message: abort.signal.aborted
          ? `Claude Code did not finish the test turn within ${timeoutMs} ms`
          : (stderr.at(-1) ?? 'Claude Code stopped before answering'),
      };
    } catch (error) {
      const detail = stderr.at(-1);
      return {
        ok: false,
        account: null,
        version,
        message: abort.signal.aborted
          ? `Claude Code did not finish the test turn within ${timeoutMs} ms`
          : detail
            ? `${describeError(error)}: ${detail}`
            : describeError(error),
      };
    } finally {
      clearTimeout(timer);
      input.end();
      query?.close();
    }
  }
}

export const createClaudeAdapter = (
  instance: ProviderInstance,
  context: ProviderAdapterContext,
): ClaudeAdapter => new ClaudeAdapter(instance, context);
