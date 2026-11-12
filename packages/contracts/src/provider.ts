import { z } from 'zod';
import { AttachmentMediaType } from './attachments.js';
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

// How the user answered an approval. `allowAlways` also stores a rule for the thread's project
// (agent workbench spec 38); the provider only ever hears `ProviderApprovalDecision`.
export const ApprovalDecision = z.enum(['allowOnce', 'allowSession', 'allowAlways', 'deny']);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

// What an adapter is told: wow keeps its own rules, so "always" reaches it as "once".
export const ProviderApprovalDecision = z.enum(['allowOnce', 'allowSession', 'deny']);
export type ProviderApprovalDecision = z.infer<typeof ProviderApprovalDecision>;

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
    // Images of the message, as files wow stored (agent workbench spec 53, 55): Claude Code gets
    // them as image blocks, Codex as `localImage` inputs.
    images: z
      .array(z.object({ path: z.string().min(1), mediaType: AttachmentMediaType }))
      .optional(),
  }),
  z.object({ type: z.literal('interrupt'), threadId: z.string().min(1) }),
  // Ends the thread's live session in this adapter, if it has one, without a turn event. The
  // provider's stored conversation stays; a later startTurn opens a new session.
  z.object({ type: z.literal('closeThread'), threadId: z.string().min(1) }),
  z.object({
    type: z.literal('answerApproval'),
    approvalId: z.string().min(1),
    decision: ProviderApprovalDecision,
    // A denial's note, for a provider that takes a message with it (Claude Code); empty or
    // absent denies without one (agent workbench spec 37).
    note: z.string().min(1).optional(),
    // A plan approval that starts the work: the mode the thread goes on in (spec 42).
    permissionMode: PermissionMode.optional(),
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
  // A message for the thread's running turn (agent workbench spec 51). The adapter answers
  // `HandOverResult`: taken when its provider took the message into the turn, as Claude Code's
  // own queue does; not taken when it cannot (Codex, or no turn runs there), and the server then
  // sends it when the turn ends.
  z.object({ type: z.literal('handOver'), threadId: z.string().min(1), prompt: z.string().min(1) }),
  // The provider's own slash commands for a folder (spec 60), answered as `ProviderSlashCommand[]`.
  // `threadId` lets an adapter ask the thread's live session; a provider that reports none
  // answers an empty list.
  z.object({
    type: z.literal('listCommands'),
    cwd: z.string().min(1),
    threadId: z.string().min(1).optional(),
  }),
  // Stops a task running in the background (agent workbench spec 90), by the id the provider
  // gave it in `backgroundTasks`. Only for a provider whose chat options say `stopsTasks`.
  z.object({
    type: z.literal('stopTask'),
    threadId: z.string().min(1),
    taskId: z.string().min(1),
  }),
  // Sends the running turn's command or subagent to the background, as Ctrl+B does in Claude
  // Code: the call with this provider item id, or every one that runs when it is absent. Only for
  // a provider whose chat options say `sendsToBackground`.
  z.object({
    type: z.literal('toBackground'),
    threadId: z.string().min(1),
    itemId: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal('test') }),
]);
export type ProviderCommand = z.infer<typeof ProviderCommand>;

export const HandOverResult = z.object({ taken: z.boolean() });
export type HandOverResult = z.infer<typeof HandOverResult>;

// One of the provider's own slash commands (Claude Code's built-in, user and project commands).
// A pick goes to the provider as text, `/name` and what follows.
export const ProviderSlashCommand = z.object({
  name: z.string().min(1),
  description: z.string(),
  argumentHint: z.string().optional(),
});
export type ProviderSlashCommand = z.infer<typeof ProviderSlashCommand>;

// `plan` is Claude Code asking to leave plan mode (agent workbench spec 42).
export const ApprovalKind = z.enum(['command', 'fileChange', 'tool', 'plan']);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

export const TaskStatus = z.enum(['pending', 'in_progress', 'completed']);
export type TaskStatus = z.infer<typeof TaskStatus>;

const ThreadScoped = { threadId: z.string().min(1) };

// What a tool call is, in wow's words, so the conversation draws it without reading a provider's
// shapes (agent workbench spec 27 to 30). `edit` covers file edits and writes; `other` is any
// tool wow has no row of its own for.
// `subagent` is a call that hands work to another agent (Claude Code's Agent tool, Codex's collab
// agent call), whose own calls are nested under it by `parentItemId` (spec 44).
export const ToolKind = z.enum([
  'command',
  'read',
  'search',
  'web',
  'mcp',
  'edit',
  'subagent',
  'other',
]);
export type ToolKind = z.infer<typeof ToolKind>;

// How a subagent stands, in wow's words, where the provider reports it (Codex's agent states).
export const AgentState = z.enum(['starting', 'running', 'done', 'failed', 'stopped', 'missing']);
export type AgentState = z.infer<typeof AgentState>;

// The facts an adapter reads from a tool call's input, each only where the provider gives it.
export const ToolFacts = z.object({
  kind: ToolKind,
  // A shell command as it was run, and the folder it ran in.
  command: z.string().optional(),
  cwd: z.string().optional(),
  // The file a read or an edit is about, or the folder a search looks in.
  path: z.string().optional(),
  // The lines a read asked for, first and last (last absent: to the end).
  lines: z
    .object({
      from: z.number().int().positive(),
      to: z.number().int().positive().optional(),
    })
    .optional(),
  // What a search looks for (a pattern or a glob).
  pattern: z.string().optional(),
  // The address a web fetch reads, or the words of a web search.
  url: z.string().optional(),
  query: z.string().optional(),
  // An MCP call: the server and its tool.
  server: z.string().optional(),
  tool: z.string().optional(),
  // An edit: its unified diff, hunks only (from the first `@@` on), made by the adapter (spec 33).
  // Several files' hunks each follow a `--- a/<path>` and `+++ b/<path>` pair.
  diff: z.string().optional(),
  // The diff is only what the edit writes, read from its input (a write over a file that may
  // exist): the file's current content is not in it. False once a written result replaced it.
  diffWithoutFile: z.boolean().optional(),
  // A subagent: what it was asked to do in a few words, the whole prompt, its type (Claude
  // Code's subagent type), and how it stands where the provider reports that (Codex).
  description: z.string().optional(),
  prompt: z.string().optional(),
  agentType: z.string().optional(),
  agentState: AgentState.optional(),
});
export type ToolFacts = z.infer<typeof ToolFacts>;

// What an approval request is about, in wow's words (spec 36): the tool facts of the call it
// would allow, an MCP tool's arguments, the plan of a plan approval (absent when the request did
// not carry it), and the command prefix the provider itself proposed to allow from now on, which
// wow reads only to word its own rule (spec 38).
export const ApprovalFacts = ToolFacts.partial().extend({
  arguments: z.unknown().optional(),
  plan: z.string().optional(),
  ruleHint: z.string().min(1).optional(),
});
export type ApprovalFacts = z.infer<typeof ApprovalFacts>;

const PartialToolFacts = ToolFacts.partial();

// The tool facts of an event or payload, without its other fields.
export const toolFactsOf = (value: unknown): Partial<ToolFacts> => {
  const parsed = PartialToolFacts.safeParse(value);
  return parsed.success
    ? Object.fromEntries(Object.entries(parsed.data).filter(([, field]) => field !== undefined))
    : {};
};

// Work the agent started in the background (a subagent or a shell command) that is still running.
// When it ends, the provider may go on with the thread by itself in a turn wow did not start.
// `agent` marks a background agent: a workflow step waits only for those, since a shell command
// such as a dev server or a watcher may never end.
// `kind`, `startedAt` and `lastOutput` are absent in tasks stored before them (spec 48, 90).
// `startedAt` is the server's clock when it first heard of the task; adapters leave it out.
// `lastOutput` is the latest progress line the provider reported for it.
export const BackgroundTask = z.object({
  id: z.string().min(1),
  description: z.string(),
  agent: z.boolean().optional(),
  kind: z.enum(['agent', 'command', 'other']).optional(),
  startedAt: z.iso.datetime({ offset: true }).optional(),
  lastOutput: z.string().optional(),
});
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
    // Text a subagent wrote, under the call that started it (spec 44).
    parentItemId: z.string().min(1).optional(),
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
    // Absent from an adapter that does not normalize this tool; the row then shows its name.
    ...ToolFacts.partial().shape,
    // A call a subagent made: the provider item id of the subagent call it belongs under.
    parentItemId: z.string().min(1).optional(),
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
    // A command's exit code and how long the call took, where the provider says so. Without a
    // duration the server's clock measures it.
    exitCode: z.number().int().optional(),
    durationMs: z.number().nonnegative().optional(),
    // An edit's diff as the provider reported it once it was written; it replaces the one the
    // call started with (made from the call's input).
    diff: z.string().optional(),
    // A subagent call: how many tool calls it made, its final answer and how it ended, where the
    // provider says so.
    toolCount: z.number().int().nonnegative().optional(),
    answer: z.string().optional(),
    agentState: AgentState.optional(),
  }),
  z.object({
    type: z.literal('approvalRequested'),
    ...ThreadScoped,
    approvalId: z.string().min(1),
    kind: ApprovalKind,
    summary: z.string(),
    request: z.unknown(),
    facts: ApprovalFacts.optional(),
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
    // The model the provider says it ran on; without it the server names the model it sent.
    model: z.string().min(1).optional(),
  }),
  // The provider compacted the conversation (agent workbench spec 46), with the counts it gives.
  z.object({
    type: z.literal('compacted'),
    ...ThreadScoped,
    trigger: z.enum(['manual', 'auto']),
    preTokens: z.number().int().nonnegative().optional(),
    postTokens: z.number().int().nonnegative().optional(),
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
  // The provider refused a Stop of a background task or a Ctrl+B; the server reports it, as the
  // request itself changes nothing the user could see.
  z.object({
    type: z.literal('commandRefused'),
    ...ThreadScoped,
    command: z.enum(['stopTask', 'toBackground']),
    error: z.string(),
  }),
]);
export type ProviderEvent = z.infer<typeof ProviderEvent>;

// How the composer bar colours a permission mode by what it allows (agent workbench spec 4):
// Plan only blue, a mode that edits without asking green, a mode without a sandbox or without
// asking red with a warning icon. A mode without a tone is drawn plain.
export type PermissionModeTone = 'plan' | 'edits' | 'danger';

export interface PermissionModeOption {
  readonly id: string;
  readonly label: string;
  // What the composer bar reads ("Opus · High · Ask"); the label when there is none.
  readonly short?: string;
  readonly tone?: PermissionModeTone;
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
  // The modes Shift+Tab steps through in the composer, in order (agent workbench spec 3). A
  // dangerous mode is never here: it is chosen from the list only.
  readonly modeCycle: readonly string[];
  // Whether a background task can be stopped (`stopTask`) and a running command or subagent
  // sent to the background (`toBackground`) on this provider (spec 90). Codex has neither.
  readonly stopsTasks: boolean;
  readonly sendsToBackground: boolean;
}

export const providerChatOptions: Readonly<Record<ProviderKind, ProviderChatOptions>> = {
  claude: {
    permissionModes: [
      { id: 'default', label: 'Ask for permissions', short: 'Ask' },
      { id: 'acceptEdits', label: 'Accept edits', tone: 'edits' },
      { id: 'plan', label: 'Plan only', tone: 'plan' },
      { id: 'auto', label: 'Auto' },
      { id: 'dontAsk', label: 'Do not ask (deny what is not allowed)', short: 'Do not ask' },
      { id: 'bypassPermissions', label: 'Bypass permissions', tone: 'danger' },
    ],
    defaultEffort: 'default',
    compactPrompt: '/compact',
    assistantPermissionMode: 'dontAsk',
    requiresModel: false,
    modeCycle: ['default', 'acceptEdits', 'plan'],
    stopsTasks: true,
    sendsToBackground: true,
  },
  codex: {
    permissionModes: [
      { id: 'read-only', label: 'Read only' },
      { id: 'auto', label: 'Auto (workspace write, ask outside it)', short: 'Auto', tone: 'edits' },
      { id: 'untrusted', label: 'Ask for every untrusted command', short: 'Ask untrusted' },
      {
        id: 'full-access',
        label: 'Full access (no sandbox, never ask)',
        short: 'Full access',
        tone: 'danger',
      },
    ],
    defaultEffort: null,
    compactPrompt: null,
    assistantPermissionMode: 'read-only',
    requiresModel: true,
    modeCycle: ['read-only', 'auto', 'untrusted'],
    stopsTasks: false,
    sendsToBackground: false,
  },
};

// The mode Shift+Tab moves to from `current` (agent workbench spec 3). From a mode outside the
// cycle (Bypass permissions, Full access, or one the cycle leaves out) it starts the cycle again.
export function nextPermissionMode(kind: ProviderKind, current: string): string {
  const cycle = providerChatOptions[kind].modeCycle;
  const at = cycle.indexOf(current);
  return cycle[(at + 1) % cycle.length] ?? current;
}

export const permissionModeOption = (
  kind: ProviderKind,
  id: string,
): PermissionModeOption | undefined =>
  providerChatOptions[kind].permissionModes.find((mode) => mode.id === id);

export const isDangerousMode = (kind: ProviderKind, id: string): boolean =>
  permissionModeOption(kind, id)?.tone === 'danger';

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

// What `listModels` answers: one row per model the installed provider offers. The optional
// fields are filled only where the provider reports them (agent workbench spec 7, 8, 54); a field
// it does not report stays absent and nothing is guessed. Codex reports all three; Claude Code
// reports none of them.
export const ProviderModel = z.object({
  id: z.string().min(1),
  label: z.string(),
  description: z.string(),
  efforts: z.array(z.string().min(1)),
  // The model's own default effort level.
  defaultEffort: z.string().min(1).optional(),
  // The provider's own default model, which it uses when none is named.
  isDefault: z.boolean().optional(),
  // Whether the model takes images in a message.
  imageInput: z.boolean().optional(),
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
