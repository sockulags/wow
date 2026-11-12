import { z } from 'zod';

// What a thread's provider session can use (thread work spec 37 to 43): the MCP servers with their
// state, their tools, the built-in tools, skills, slash commands, subagents, plugins and the
// instruction files, as the provider reported them. Only named fields: nothing here can hold a
// server's configuration, environment, headers, arguments or a URL's path (spec 41), and every
// list and text is bounded, so a session with thousands of tools cannot fill the store.

export const sessionToolsLimits = {
  name: 200,
  text: 2000,
  word: 100,
  address: 300,
  path: 1000,
  servers: 200,
  serverTools: 500,
  builtInTools: 500,
  skills: 1000,
  commands: 1000,
  agents: 200,
  plugins: 200,
  pluginErrors: 20,
  instructionFiles: 200,
} as const;

const limits = sessionToolsLimits;
const Name = z.string().min(1).max(limits.name);
const Text = z.string().max(limits.text);
const Word = z.string().max(limits.word);

// Claude Code's states in wow's words; `other` keeps a state an adapter does not know, with the
// provider's own word in `stateWord`.
export const McpServerState = z.enum([
  'connected',
  'failed',
  'needsAuth',
  'pending',
  'disabled',
  'other',
]);
export type McpServerState = z.infer<typeof McpServerState>;

export const mcpServerStateLabels: Readonly<Record<McpServerState, string>> = {
  connected: 'Connected',
  failed: 'Failed',
  needsAuth: 'Needs sign-in',
  pending: 'Connecting',
  disabled: 'Turned off',
  other: 'Unknown state',
};

export const McpToolInfo = z.object({
  name: Name,
  description: Text,
  readOnly: z.boolean(),
  destructive: z.boolean(),
});
export type McpToolInfo = z.infer<typeof McpToolInfo>;

export const McpServerInfo = z.object({
  name: Name,
  state: McpServerState,
  // The provider's own word for the state, as it reported it.
  stateWord: Word,
  // What a failed server said.
  error: Text.nullable(),
  // Where it is configured: user, project, local, plugin…
  source: Word.nullable(),
  version: Word.nullable(),
  // A remote server's scheme, host and port, or a local one's program file name (spec 41).
  address: z.string().max(limits.address).nullable(),
  tools: z.array(McpToolInfo).max(limits.serverTools),
});
export type McpServerInfo = z.infer<typeof McpServerInfo>;

export const SessionSkill = z.object({ name: Name, description: Text.nullable() });
export type SessionSkill = z.infer<typeof SessionSkill>;

// The shape of `ProviderSlashCommand`, bounded.
export const SessionCommand = z.object({
  name: Name,
  description: Text,
  argumentHint: Word.optional(),
});
export type SessionCommand = z.infer<typeof SessionCommand>;

export const SessionAgent = z.object({
  name: Name,
  description: Text,
  model: Word.nullable(),
});
export type SessionAgent = z.infer<typeof SessionAgent>;

// A plugin that did not load is listed with `loaded` false and its errors.
export const SessionPlugin = z.object({
  name: Name,
  version: Word.nullable(),
  loaded: z.boolean(),
  errors: z.array(Text).max(limits.pluginErrors),
});
export type SessionPlugin = z.infer<typeof SessionPlugin>;

export const SessionTools = z.object({
  // When the provider reported it; the server stores its own clock's time.
  reportedAt: z.iso.datetime({ offset: true }),
  // False when only part could be read (Claude Code's live calls failed and only the init
  // message's names and states are known, or a provider that reports no list: Codex).
  complete: z.boolean(),
  mcpServers: z.array(McpServerInfo).max(limits.servers),
  builtInTools: z.array(Name).max(limits.builtInTools),
  skills: z.array(SessionSkill).max(limits.skills),
  commands: z.array(SessionCommand).max(limits.commands),
  agents: z.array(SessionAgent).max(limits.agents),
  plugins: z.array(SessionPlugin).max(limits.plugins),
  instructionFiles: z.array(z.string().min(1).max(limits.path)).max(limits.instructionFiles),
});
export type SessionTools = z.infer<typeof SessionTools>;

// Where a stored list came from: the start of a turn (Claude Code's init message, Codex's thread
// start) or the user's Refresh.
export const ThreadToolsSource = z.enum(['turn', 'refresh']);
export type ThreadToolsSource = z.infer<typeof ThreadToolsSource>;

// The `threadTools` topic: a thread's last stored list. `live` says whether the session that
// reported it is still open in its adapter, so Refresh can ask it (spec 39); it goes false when
// the server restarts, the adapter is released or the session is found gone.
export const ThreadTools = z.object({
  threadId: z.string().min(1),
  tools: SessionTools,
  source: ThreadToolsSource,
  live: z.boolean(),
});
export type ThreadTools = z.infer<typeof ThreadTools>;

// What Refresh did (spec 39): stored a changed list, found the same one, or found no live session.
export const RefreshToolsOutcome = z.enum(['changed', 'unchanged', 'noSession']);
export type RefreshToolsOutcome = z.infer<typeof RefreshToolsOutcome>;

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
const cutName = (text: string): string => cut(text, limits.name);
const cutOrNull = (text: string | null | undefined, max: number): string | null =>
  text === null || text === undefined || text === '' ? null : cut(text, max);

// Cuts what an adapter read to the schema's bounds and drops entries without a name, so an
// adapter always emits a list the schema takes.
const named = <T extends { name: string }>(entries: readonly T[], max: number): T[] =>
  entries.filter((entry) => entry.name !== '').slice(0, max);

export function boundedSessionTools(tools: SessionTools): SessionTools {
  return {
    reportedAt: tools.reportedAt,
    complete: tools.complete,
    mcpServers: named(tools.mcpServers, limits.servers).map((server) => ({
      name: cutName(server.name),
      state: server.state,
      stateWord: cut(server.stateWord, limits.word),
      error: cutOrNull(server.error, limits.text),
      source: cutOrNull(server.source, limits.word),
      version: cutOrNull(server.version, limits.word),
      address: cutOrNull(server.address, limits.address),
      tools: named(server.tools, limits.serverTools).map((tool) => ({
        name: cutName(tool.name),
        description: cut(tool.description, limits.text),
        readOnly: tool.readOnly,
        destructive: tool.destructive,
      })),
    })),
    builtInTools: tools.builtInTools
      .filter((name) => name !== '')
      .slice(0, limits.builtInTools)
      .map(cutName),
    skills: named(tools.skills, limits.skills).map((skill) => ({
      name: cutName(skill.name),
      description: cutOrNull(skill.description, limits.text),
    })),
    commands: named(tools.commands, limits.commands).map((command) => ({
      name: cutName(command.name),
      description: cut(command.description, limits.text),
      ...(command.argumentHint === undefined || command.argumentHint === ''
        ? {}
        : { argumentHint: cut(command.argumentHint, limits.word) }),
    })),
    agents: named(tools.agents, limits.agents).map((agent) => ({
      name: cutName(agent.name),
      description: cut(agent.description, limits.text),
      model: cutOrNull(agent.model, limits.word),
    })),
    plugins: named(tools.plugins, limits.plugins).map((plugin) => ({
      name: cutName(plugin.name),
      version: cutOrNull(plugin.version, limits.word),
      loaded: plugin.loaded,
      errors: plugin.errors.slice(0, limits.pluginErrors).map((error) => cut(error, limits.text)),
    })),
    instructionFiles: tools.instructionFiles
      .filter((file) => file !== '')
      .slice(0, limits.instructionFiles)
      .map((file) => cut(file, limits.path)),
  };
}

// Two lists are the same when everything but the time they were reported at is (spec 39: a
// Refresh stores only a changed list).
export function sameSessionTools(a: SessionTools, b: SessionTools): boolean {
  const { reportedAt: _a, ...left } = a;
  const { reportedAt: _b, ...right } = b;
  return JSON.stringify(left) === JSON.stringify(right);
}

// The servers that need the user: failed or waiting for a sign-in, for the header chip (spec 37).
export function mcpServersNeedingYou(tools: SessionTools | undefined): {
  readonly failed: number;
  readonly needsAuth: number;
} {
  const servers = tools?.mcpServers ?? [];
  return {
    failed: servers.filter((server) => server.state === 'failed').length,
    needsAuth: servers.filter((server) => server.state === 'needsAuth').length,
  };
}
