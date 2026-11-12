import type {
  AccountInfo,
  AgentInfo,
  EffortLevel,
  McpServerStatus,
  ModelInfo,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import type { ClaudeQuery, Options, QueryFunction, SDKMessage, SDKUserMessage } from '../sdk.js';

// A stand-in for the Agent SDK's query(): it replays fixture steps, one list of steps per user
// message, and calls canUseTool for permission steps the way Claude Code does.

export interface PermissionStep {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly toolUseID: string;
  readonly title?: string;
  readonly suggestions?: PermissionUpdate[];
}

export type FakeStep =
  | { readonly message: SDKMessage }
  | { readonly permission: PermissionStep }
  // Claude Code exits mid-turn; the SDK's iterator throws.
  | { readonly crash: string }
  // Nothing comes until the test lets it go on (background work running in Claude Code).
  | { readonly hold: Promise<unknown> };

export const loadFixture = (name: string): FakeStep[] =>
  (
    JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as {
      steps: FakeStep[];
    }
  ).steps;

export const errorResult = (subtype: 'error_during_execution', sessionId: string): SDKMessage =>
  ({
    type: 'result',
    subtype,
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    errors: ['Request was aborted'],
    uuid: '00000000-0000-4000-8000-0000000000ff',
    session_id: sessionId,
  }) as unknown as SDKMessage;

// What the live calls answer: the MCP servers' status (an Error makes the call fail) and the
// subagents.
export interface FakeLive {
  readonly mcpStatus?: McpServerStatus[] | Error;
  readonly agents?: AgentInfo[];
}

export class FakeQuery implements ClaudeQuery {
  readonly options: Options;
  readonly prompts: string[] = [];
  // Every user message as the adapter wrote it, content blocks included.
  readonly messages: SDKUserMessage[] = [];
  // The priority each user message came with (a message handed to a running turn has one).
  readonly priorities: Array<string | undefined> = [];
  readonly permissionResults: PermissionResult[] = [];
  readonly calls: string[] = [];
  readonly #prompt: AsyncIterable<SDKUserMessage>;
  readonly #turns: FakeStep[][];
  readonly #live: FakeLive;
  #interrupted = false;
  #abort: AbortController | undefined;
  closed = false;

  constructor(
    prompt: AsyncIterable<SDKUserMessage>,
    options: Options,
    turns: FakeStep[][],
    live: FakeLive = {},
  ) {
    this.#prompt = prompt;
    this.options = options;
    this.#turns = turns;
    this.#live = live;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    let turn = 0;
    for await (const user of this.#prompt) {
      const content = user.message.content;
      this.prompts.push(typeof content === 'string' ? content : '');
      this.messages.push(user);
      this.priorities.push(user.priority);
      this.#interrupted = false;
      for (const step of this.#turns[turn] ?? []) {
        if (this.#interrupted) break;
        if ('message' in step) {
          yield step.message;
          continue;
        }
        if ('crash' in step) throw new Error(step.crash);
        if ('hold' in step) {
          await step.hold;
          continue;
        }
        this.#abort = new AbortController();
        const canUseTool = this.options.canUseTool;
        if (!canUseTool) throw new Error('The fake needs canUseTool for a permission step');
        const result = await canUseTool(step.permission.toolName, step.permission.input, {
          signal: this.#abort.signal,
          toolUseID: step.permission.toolUseID,
          requestId: `req-${step.permission.toolUseID}`,
          ...(step.permission.title ? { title: step.permission.title } : {}),
          ...(step.permission.suggestions ? { suggestions: step.permission.suggestions } : {}),
        });
        if (!result) throw new Error('canUseTool answered out of band');
        this.permissionResults.push(result);
      }
      if (this.#interrupted) yield errorResult('error_during_execution', 'sess-1');
      turn += 1;
    }
  }

  interrupt(): Promise<unknown> {
    this.calls.push('interrupt');
    this.#interrupted = true;
    this.#abort?.abort();
    return Promise.resolve(undefined);
  }

  setModel(model?: string): Promise<void> {
    this.calls.push(`setModel:${model ?? ''}`);
    return Promise.resolve();
  }

  setPermissionMode(mode: PermissionMode): Promise<void> {
    this.calls.push(`setPermissionMode:${mode}`);
    return Promise.resolve();
  }

  applyFlagSettings(settings: { effortLevel?: EffortLevel | null }): Promise<void> {
    this.calls.push(`effort:${settings.effortLevel ?? 'null'}`);
    return Promise.resolve();
  }

  supportedModels(): Promise<ModelInfo[]> {
    return Promise.resolve([
      {
        value: 'sonnet',
        displayName: 'Sonnet',
        description: 'Fast and capable',
        supportedEffortLevels: ['low', 'medium', 'high'],
      },
      { value: 'haiku', displayName: 'Haiku', description: 'Fastest' },
    ]);
  }

  supportedCommands(): Promise<SlashCommand[]> {
    return Promise.resolve([
      {
        name: 'compact',
        description: 'Clear history but keep a summary',
        argumentHint: '',
        builtin: true,
      },
      {
        name: 'release-notes',
        description: 'Write the release notes (invented)',
        argumentHint: '<version>',
      },
    ]);
  }

  mcpServerStatus(): Promise<McpServerStatus[]> {
    this.calls.push('mcpServerStatus');
    const answer = this.#live.mcpStatus ?? [];
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }

  supportedAgents(): Promise<AgentInfo[]> {
    this.calls.push('supportedAgents');
    return Promise.resolve(this.#live.agents ?? []);
  }

  getContextUsage(): Promise<{ totalTokens: number; maxTokens: number }> {
    return Promise.resolve({ totalTokens: 1500, maxTokens: 200_000 });
  }

  accountInfo(): Promise<AccountInfo> {
    return Promise.resolve({ email: 'someone@example.com', organization: 'Example' });
  }

  stopTask(taskId: string): Promise<void> {
    this.calls.push(`stopTask:${taskId}`);
    return Promise.resolve();
  }

  // Answers false for a tool use id that names no foreground task, as the SDK does.
  backgroundTasks(toolUseId?: string): Promise<boolean> {
    this.calls.push(`backgroundTasks:${toolUseId ?? ''}`);
    return Promise.resolve(toolUseId !== 'none-running');
  }

  close(): void {
    this.closed = true;
  }
}

// A query() replacement that records every query it opens.
export function fakeQueryFunction(
  turns: FakeStep[][],
  live: FakeLive = {},
): QueryFunction & { opened: FakeQuery[] } {
  const opened: FakeQuery[] = [];
  const create: QueryFunction = ({ prompt, options }) => {
    const query = new FakeQuery(prompt, options, turns, live);
    opened.push(query);
    return query;
  };
  return Object.assign(create, { opened });
}
