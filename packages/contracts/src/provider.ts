import { z } from 'zod';
import { QuestionOption, QuestionReply } from './questions.js';

// The normalized provider protocol. Adapters translate their own wire format to and from these
// types; orchestration and the UI never see provider-specific shapes.

export const ProviderKind = z.enum(['claude', 'codex']);
export type ProviderKind = z.infer<typeof ProviderKind>;

export const ThreadState = z.enum(['idle', 'working', 'needs_you', 'done', 'failed']);
export type ThreadState = z.infer<typeof ThreadState>;

// Model, effort and permission mode values differ per provider and per installed version, so they
// stay strings here and each adapter validates them against what its provider reports.
const Model = z.string().min(1);
const Effort = z.string().min(1);
const PermissionMode = z.string().min(1);

export const ApprovalDecision = z.enum(['allowOnce', 'allowSession', 'deny']);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

// Tools of the app handed to an agent: one MCP server reached over HTTP with a bearer token. A
// turn that carries a toolset gets these tools and no others (no file, shell or network tool,
// no settings or tools of the user's own), whatever its permission mode says. How that is done
// is each adapter's business.
export const ProviderToolset = z.object({
  // The name the agent knows the server by.
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  url: z.url(),
  token: z.string().min(1),
});
export type ProviderToolset = z.infer<typeof ProviderToolset>;

export const ProviderCommand = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('startTurn'),
    threadId: z.string().min(1),
    cwd: z.string().min(1),
    prompt: z.string(),
    model: Model,
    effort: Effort,
    permissionMode: PermissionMode,
    resumeId: z.string().min(1).optional(),
    toolset: ProviderToolset.optional(),
    // What the agent is told it is for, in place of the provider's own instructions for coding.
    instructions: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal('interrupt'), threadId: z.string().min(1) }),
  // Ends the thread's live session in this adapter, if it has one, without a turn event. The
  // provider's stored conversation stays; a later startTurn opens a new session.
  z.object({ type: z.literal('closeThread'), threadId: z.string().min(1) }),
  z.object({
    type: z.literal('answerApproval'),
    approvalId: z.string().min(1),
    decision: ApprovalDecision,
  }),
  z.object({
    type: z.literal('answerQuestion'),
    questionId: z.string().min(1),
    answer: QuestionReply,
  }),
  z.object({ type: z.literal('setModel'), threadId: z.string().min(1), model: Model }),
  z.object({
    type: z.literal('setPermissionMode'),
    threadId: z.string().min(1),
    permissionMode: PermissionMode,
  }),
  z.object({ type: z.literal('listModels') }),
  z.object({ type: z.literal('test') }),
]);
export type ProviderCommand = z.infer<typeof ProviderCommand>;

export const ApprovalKind = z.enum(['command', 'fileChange', 'tool']);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

export const TaskStatus = z.enum(['pending', 'in_progress', 'completed']);
export type TaskStatus = z.infer<typeof TaskStatus>;

const ThreadScoped = { threadId: z.string().min(1) };

// Work the agent started in the background (a subagent or a shell command) that is still running.
// When it ends, the provider may go on with the thread by itself in a turn wow did not start.
export const BackgroundTask = z.object({ id: z.string().min(1), description: z.string() });
export type BackgroundTask = z.infer<typeof BackgroundTask>;

export const ProviderEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session'), ...ThreadScoped, providerSessionId: z.string().min(1) }),
  // The provider started a turn by itself (after background work ended); it ends with the usual
  // turnCompleted, turnFailed or turnInterrupted.
  z.object({ type: z.literal('turnStartedByProvider'), ...ThreadScoped }),
  // Every background task still running, after a change: the list replaces the one before.
  z.object({
    type: z.literal('backgroundTasks'),
    ...ThreadScoped,
    tasks: z.array(BackgroundTask),
  }),
  z.object({
    type: z.literal('textDelta'),
    ...ThreadScoped,
    itemId: z.string().min(1),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('reasoningDelta'),
    ...ThreadScoped,
    itemId: z.string().min(1),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('toolCallStarted'),
    ...ThreadScoped,
    itemId: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('toolCallOutput'),
    ...ThreadScoped,
    itemId: z.string().min(1),
    output: z.string(),
  }),
  z.object({
    type: z.literal('toolCallCompleted'),
    ...ThreadScoped,
    itemId: z.string().min(1),
    status: z.enum(['ok', 'error']),
  }),
  z.object({
    type: z.literal('approvalRequested'),
    ...ThreadScoped,
    approvalId: z.string().min(1),
    kind: ApprovalKind,
    summary: z.string(),
    request: z.unknown(),
  }),
  z.object({
    type: z.literal('questionAsked'),
    ...ThreadScoped,
    questionId: z.string().min(1),
    question: z.string().min(1),
    // The chip above the question, when the provider gave one.
    header: z.string().min(1).optional(),
    // Questions asked together share it; the card answers them together.
    askId: z.string().min(1).optional(),
    options: z.array(QuestionOption),
    multiSelect: z.boolean(),
  }),
  z.object({
    type: z.literal('taskListUpdated'),
    ...ThreadScoped,
    tasks: z.array(z.object({ id: z.string().min(1), content: z.string(), status: TaskStatus })),
  }),
  z.object({
    type: z.literal('usage'),
    ...ThreadScoped,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('contextUsage'),
    ...ThreadScoped,
    usedTokens: z.number().int().nonnegative(),
    maxTokens: z.number().int().positive(),
  }),
  z.object({ type: z.literal('turnCompleted'), ...ThreadScoped }),
  z.object({ type: z.literal('turnFailed'), ...ThreadScoped, error: z.string() }),
  z.object({ type: z.literal('turnInterrupted'), ...ThreadScoped }),
]);
export type ProviderEvent = z.infer<typeof ProviderEvent>;

export interface PermissionModeOption {
  readonly id: string;
  readonly label: string;
}

export interface ProviderChatOptions {
  // What the thread header offers. The adapters accept exactly these keys: provider-claude checks
  // the SDK's permission modes, provider-codex maps each key to an approval policy and a sandbox.
  readonly permissionModes: readonly PermissionModeOption[];
  // Effort that leaves the choice to the provider, offered next to the model's own levels.
  readonly defaultEffort: string | null;
  // The message that compacts the conversation, or null when the provider has no such action.
  readonly compactPrompt: string | null;
  // The mode the assistant thread is stored with: the one that asks for nothing and allows least.
  readonly assistantPermissionMode: string;
  // Whether a workflow step on this provider must name a model (questions and models spec 13,
  // 17). The adapter owns the fact (`ProviderAdapter.requiresModel`); this copy is what a
  // decision and the web app read, since neither can ask an adapter.
  readonly requiresModel: boolean;
}

export const providerChatOptions: Readonly<Record<ProviderKind, ProviderChatOptions>> = {
  claude: {
    permissionModes: [
      { id: 'default', label: 'Ask for permissions' },
      { id: 'acceptEdits', label: 'Accept edits' },
      { id: 'plan', label: 'Plan only' },
      { id: 'auto', label: 'Auto' },
      { id: 'dontAsk', label: 'Do not ask (deny what is not allowed)' },
      { id: 'bypassPermissions', label: 'Bypass permissions' },
    ],
    defaultEffort: 'default',
    compactPrompt: '/compact',
    assistantPermissionMode: 'dontAsk',
    requiresModel: false,
  },
  codex: {
    permissionModes: [
      { id: 'read-only', label: 'Read only' },
      { id: 'auto', label: 'Auto (workspace write, ask outside it)' },
      { id: 'untrusted', label: 'Ask for every untrusted command' },
      { id: 'full-access', label: 'Full access (no sandbox, never ask)' },
    ],
    defaultEffort: null,
    compactPrompt: null,
    assistantPermissionMode: 'read-only',
    requiresModel: true,
  },
};

// What onboarding needs per provider kind: the executable looked for on PATH and the variable that
// names its config directory (spec 31, 32). The server detects; the settings page labels.
export interface ProviderSetup {
  readonly label: string;
  readonly binaryName: string;
  readonly configDirEnv: string;
  // Under the user's home directory, used when the variable is not set.
  readonly defaultConfigDir: string;
}

export const providerSetup: Readonly<Record<ProviderKind, ProviderSetup>> = {
  claude: {
    label: 'Claude',
    binaryName: 'claude',
    configDirEnv: 'CLAUDE_CONFIG_DIR',
    defaultConfigDir: '.claude',
  },
  codex: {
    label: 'Codex',
    binaryName: 'codex',
    configDirEnv: 'CODEX_HOME',
    defaultConfigDir: '.codex',
  },
};

// One provider CLI as `provider.detect` found it: binaryPath is null when it is not on PATH.
export const DetectedProvider = z.object({
  kind: ProviderKind,
  binaryPath: z.string().min(1).nullable(),
  configDir: z.string().min(1),
});
export type DetectedProvider = z.infer<typeof DetectedProvider>;

// A folder a provider CLI has worked in, as its adapter read it from the CLI's own session files.
// `lastUsedAt` is the newest session's time, when known.
export const ProviderFolder = z.object({
  cwd: z.string().min(1),
  lastUsedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ProviderFolder = z.infer<typeof ProviderFolder>;

// What `projects.discover` answers: one row per existing folder that is not a project yet, with
// the provider instances that worked in it.
export const DiscoveredProject = z.object({
  cwd: z.string().min(1),
  name: z.string().min(1),
  lastUsedAt: z.iso.datetime({ offset: true }).nullable(),
  sources: z
    .array(
      z.object({
        providerInstanceId: z.string().min(1),
        providerInstanceName: z.string(),
        kind: ProviderKind,
      }),
    )
    .min(1),
});
export type DiscoveredProject = z.infer<typeof DiscoveredProject>;

// What `listModels` answers: one row per model the installed provider offers.
export const ProviderModel = z.object({
  id: z.string().min(1),
  label: z.string(),
  description: z.string(),
  efforts: z.array(z.string().min(1)),
});
export type ProviderModel = z.infer<typeof ProviderModel>;

// An npm package at an exact version, the only thing `provider.update` installs.
export const NpmPackageSpec = z
  .string()
  .regex(/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+[\w.+-]*$/);

const UpdateReason = z.enum([
  // The installed CLI does not speak the protocol the adapter needs.
  'incompatible',
  // It works, but it is older than the version the adapter is tested with.
  'older',
]);

// How the installed CLI can be brought to the version the adapter is tested with, from the last
// "Test". wow runs the npm install itself (`provider.update`); anything else is an instruction.
export const ProviderUpdate = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('npm'),
    targetVersion: z.string().min(1),
    reason: UpdateReason,
    packageSpec: NpmPackageSpec,
    // The npm prefix the CLI is installed under, when it is not the one `npm` on the server's
    // PATH installs to.
    prefix: z.string().min(1).nullable(),
  }),
  z.object({
    method: z.literal('manual'),
    targetVersion: z.string().min(1),
    reason: UpdateReason,
    instruction: z.string().min(1),
  }),
]);
export type ProviderUpdate = z.infer<typeof ProviderUpdate>;
export type NpmProviderUpdate = Extract<ProviderUpdate, { method: 'npm' }>;

// The arguments of the npm command an update runs, after `npm`.
export const npmInstallArgs = (update: NpmProviderUpdate): string[] => [
  'install',
  '-g',
  update.packageSpec,
  ...(update.prefix ? ['--prefix', update.prefix] : []),
];

// The command as the confirm dialog names it and a terminal takes it.
export const npmInstallCommand = (update: NpmProviderUpdate): string =>
  ['npm', ...npmInstallArgs(update)]
    .map((arg) => (/^[\w@./:=+-]+$/.test(arg) ? arg : `"${arg}"`))
    .join(' ');

// The last update wow ran for an instance. Output is npm's stdout and stderr as they arrived.
export const ProviderUpdateRun = z.object({
  state: z.enum(['running', 'succeeded', 'failed']),
  command: z.string().min(1),
  targetVersion: z.string().min(1),
  output: z.string(),
  message: z.string().nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ProviderUpdateRun = z.infer<typeof ProviderUpdateRun>;

// What `test` answers. A failed test is a result with ok false and a message, not an exception,
// so the settings page can show why. A passed test may carry a message too: a notice such as a
// version that differs from the tested one.
export const ProviderTestResult = z.object({
  ok: z.boolean(),
  account: z.string().nullable(),
  version: z.string().nullable(),
  message: z.string().nullable(),
  update: ProviderUpdate.nullable().optional(),
});
export type ProviderTestResult = z.infer<typeof ProviderTestResult>;

// What the server hands an adapter when it creates one for an instance.
export interface ProviderAdapterContext {
  // The instance environment with secret references replaced by their values.
  resolveEnv(): Promise<Record<string, string>>;
  // providers.testTimeoutMs, read when a test starts.
  testTimeoutMs(): number;
  // providers.requestTimeoutMs, read before every request to a provider app-server.
  requestTimeoutMs(): number;
}

// What every provider adapter implements. The server owns adapters, feeds them commands and
// turns the events they emit into thread commands; nothing outside an adapter sees its wire format.
export interface ProviderAdapter {
  readonly kind: ProviderKind;
  // A step on this provider must name a model: Claude Code picks one itself, Codex needs one.
  readonly requiresModel: boolean;
  send(command: ProviderCommand): Promise<unknown>;
  onEvent(listener: (event: ProviderEvent) => void): () => void;
  dispose(): Promise<void>;
}
