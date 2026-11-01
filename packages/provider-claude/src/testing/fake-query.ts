import type {
  AccountInfo,
  EffortLevel,
  ModelInfo,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
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
  | { readonly crash: string };

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

export class FakeQuery implements ClaudeQuery {
  readonly options: Options;
  readonly prompts: string[] = [];
  readonly permissionResults: PermissionResult[] = [];
  readonly calls: string[] = [];
  readonly #prompt: AsyncIterable<SDKUserMessage>;
  readonly #turns: FakeStep[][];
  #interrupted = false;
  #abort: AbortController | undefined;
  closed = false;

  constructor(prompt: AsyncIterable<SDKUserMessage>, options: Options, turns: FakeStep[][]) {
    this.#prompt = prompt;
    this.options = options;
    this.#turns = turns;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    let turn = 0;
    for await (const user of this.#prompt) {
      const content = user.message.content;
      this.prompts.push(typeof content === 'string' ? content : '');
      this.#interrupted = false;
      for (const step of this.#turns[turn] ?? []) {
        if (this.#interrupted) break;
        if ('message' in step) {
          yield step.message;
          continue;
        }
        if ('crash' in step) throw new Error(step.crash);
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

  getContextUsage(): Promise<{ totalTokens: number; maxTokens: number }> {
    return Promise.resolve({ totalTokens: 1500, maxTokens: 200_000 });
  }

  accountInfo(): Promise<AccountInfo> {
    return Promise.resolve({ email: 'someone@example.com', organization: 'Example' });
  }

  close(): void {
    this.closed = true;
  }
}

// A query() replacement that records every query it opens.
export function fakeQueryFunction(turns: FakeStep[][]): QueryFunction & { opened: FakeQuery[] } {
  const opened: FakeQuery[] = [];
  const create: QueryFunction = ({ prompt, options }) => {
    const query = new FakeQuery(prompt, options, turns);
    opened.push(query);
    return query;
  };
  return Object.assign(create, { opened });
}
