import type {
  AccountInfo,
  CanUseTool,
  EffortLevel,
  ModelInfo,
  Options,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';

// The part of the Agent SDK's `Query` the adapter uses, with only the fields it reads. Tests
// replace `query()` with a fake that implements this, so nothing else of the SDK may be called.
export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  applyFlagSettings(settings: { effortLevel?: EffortLevel | null }): Promise<void>;
  supportedModels(): Promise<ModelInfo[]>;
  supportedCommands(): Promise<SlashCommand[]>;
  getContextUsage(options?: {
    detail?: 'summary' | 'full';
  }): Promise<{ totalTokens: number; maxTokens: number }>;
  accountInfo(): Promise<AccountInfo>;
  // A background task by its task id; Claude Code then reports it stopped (spec 90).
  stopTask(taskId: string): Promise<void>;
  // Ctrl+B: the foreground call with this tool use id, or every one, goes to the background.
  backgroundTasks(toolUseId?: string): Promise<boolean>;
  close(): void;
}

export type QueryFunction = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeQuery;

export type { CanUseTool, Options, SDKMessage, SDKUserMessage };

export const effortLevels: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const permissionModes: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
];

export const isEffortLevel = (value: string): value is EffortLevel =>
  (effortLevels as readonly string[]).includes(value);

export const isPermissionMode = (value: string): value is PermissionMode =>
  (permissionModes as readonly string[]).includes(value);

// Turns `launchArgs` such as ["--add-dir", "../shared", "--verbose"] into the SDK's extraArgs
// map. A flag followed by a value that is not itself a flag takes that value.
export function extraArgs(launchArgs: readonly string[]): Record<string, string | null> {
  const args: Record<string, string | null> = {};
  for (let index = 0; index < launchArgs.length; index += 1) {
    const arg = launchArgs[index] ?? '';
    if (!arg.startsWith('--')) throw new Error(`Launch argument "${arg}" is not a --flag`);
    const equals = arg.indexOf('=');
    if (equals > 0) {
      args[arg.slice(2, equals)] = arg.slice(equals + 1);
      continue;
    }
    const next = launchArgs[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[arg.slice(2)] = next;
      index += 1;
    } else {
      args[arg.slice(2)] = null;
    }
  }
  return args;
}

// An image of the message, already read: Claude Code takes it as a base64 image block.
export interface MessageImage {
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  readonly base64: string;
}

// The images go before the text, as the Messages API suggests for a question about an image.
export function userMessage(text: string, images: readonly MessageImage[] = []): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content:
        images.length === 0
          ? text
          : [
              ...images.map((image) => ({
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: image.mediaType,
                  data: image.base64,
                },
              })),
              ...(text === '' ? [] : [{ type: 'text' as const, text }]),
            ],
    },
    parent_tool_use_id: null,
  };
}
