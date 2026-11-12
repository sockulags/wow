import type { AgentInfo, McpServerStatus, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import {
  boundedSessionTools,
  type McpServerInfo,
  type McpServerState,
  type SessionPlugin,
  type SessionTools,
} from '@wow/contracts';
import type { SDKMessage } from './sdk.js';

// What a Claude Code session can use (thread work spec 38, 41), read from its init message and
// completed from the live query's `mcpServerStatus()`, `supportedCommands()` and
// `supportedAgents()`. Only the fields `SessionTools` has are copied: a server's `config` can
// hold `env`, `headers` and `args`, and gives nothing but its address here.

export type InitMessage = Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;

const states: Readonly<Record<string, McpServerState>> = {
  connected: 'connected',
  failed: 'failed',
  'needs-auth': 'needsAuth',
  pending: 'pending',
  disabled: 'disabled',
};

const stateOf = (word: string): McpServerState => states[word] ?? 'other';

const mcpPrefix = (server: string) => `mcp__${server}__`;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

// A remote server as its scheme, host and port; a local one as its program's file name. Never a
// path, a query, a user name, an argument or a header (spec 41).
export function mcpAddress(config: unknown): string | null {
  const fields = record(config);
  if (!fields) return null;
  const url = fields['url'];
  if (typeof url === 'string') {
    if (!URL.canParse(url)) return null;
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.host}`;
  }
  const command = fields['command'];
  if (typeof command === 'string') {
    const name = command
      .split(/[\\/]/)
      .filter((part) => part !== '')
      .at(-1);
    return name === undefined || name === '' ? null : name;
  }
  return null;
}

function pluginsOf(init: InitMessage): SessionPlugin[] {
  const errors = init.plugin_errors ?? [];
  const errorsOf = (name: string) =>
    errors
      .filter((error) => error.plugin === name || error.plugin.split('@')[0] === name)
      .map((error) => `${error.type}: ${error.message}`);
  const loaded = init.plugins.map((plugin) => ({
    name: plugin.name,
    version: plugin.version ?? null,
    loaded: true,
    errors: errorsOf(plugin.name),
  }));
  const known = new Set(init.plugins.map((plugin) => plugin.name));
  const failed = new Map<string, string[]>();
  for (const error of errors) {
    if (known.has(error.plugin) || known.has(error.plugin.split('@')[0] ?? '')) continue;
    failed.set(error.plugin, [
      ...(failed.get(error.plugin) ?? []),
      `${error.type}: ${error.message}`,
    ]);
  }
  return [
    ...loaded,
    ...[...failed].map(([name, messages]) => ({
      name,
      version: null,
      loaded: false,
      errors: messages,
    })),
  ];
}

// The init message alone: names and states, nothing a live call would add (`complete` false).
export function initSessionTools(init: InitMessage, reportedAt: string): SessionTools {
  const servers = init.mcp_servers.map((server): McpServerInfo => ({
    name: server.name,
    state: stateOf(server.status),
    stateWord: server.status,
    error: null,
    source: server.source ?? null,
    version: null,
    address: null,
    tools: init.tools
      .filter((tool) => tool.startsWith(mcpPrefix(server.name)))
      .map((tool) => ({
        name: tool.slice(mcpPrefix(server.name).length),
        description: '',
        readOnly: false,
        destructive: false,
      })),
  }));
  return boundedSessionTools({
    reportedAt,
    complete: false,
    mcpServers: servers,
    builtInTools: init.tools.filter((tool) => !tool.startsWith('mcp__')),
    skills: init.skills.map((name) => ({ name, description: null })),
    commands: init.slash_commands.map((name) => ({ name, description: '' })),
    agents: (init.agents ?? []).map((name) => ({ name, description: '', model: null })),
    plugins: pluginsOf(init),
    instructionFiles: [],
  });
}

export interface LiveAnswers {
  readonly status: readonly McpServerStatus[];
  readonly commands: readonly SlashCommand[];
  readonly agents: readonly AgentInfo[];
}

// The init message's list completed with what the live query answered.
export function completeSessionTools(base: SessionTools, live: LiveAnswers): SessionTools {
  const sourceOf = (name: string) =>
    base.mcpServers.find((server) => server.name === name)?.source ?? null;
  const described = new Map(live.commands.map((command) => [command.name, command.description]));
  return boundedSessionTools({
    ...base,
    complete: true,
    mcpServers: live.status.map((server): McpServerInfo => ({
      name: server.name,
      state: stateOf(server.status),
      stateWord: server.status,
      error: server.status === 'failed' ? (server.error ?? null) : null,
      source: server.source ?? server.scope ?? sourceOf(server.name),
      version: server.serverInfo?.version ?? null,
      address: mcpAddress(server.config),
      tools: (server.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        readOnly: tool.annotations?.readOnly === true,
        destructive: tool.annotations?.destructive === true,
      })),
    })),
    skills: base.skills.map((skill) => ({
      name: skill.name,
      description: described.get(skill.name) || skill.description,
    })),
    commands: live.commands.map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    })),
    agents: live.agents.map((agent) => ({
      name: agent.name,
      description: agent.description,
      model: agent.model ?? null,
    })),
  });
}

// `system/commands_changed`: the commands replace the ones before.
export const withCommands = (
  tools: SessionTools,
  commands: readonly SlashCommand[],
): SessionTools =>
  boundedSessionTools({
    ...tools,
    commands: commands.map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    })),
  });

export const emptySessionTools = (reportedAt: string): SessionTools => ({
  reportedAt,
  complete: false,
  mcpServers: [],
  builtInTools: [],
  skills: [],
  commands: [],
  agents: [],
  plugins: [],
  instructionFiles: [],
});
