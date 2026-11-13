import type { AgentInfo, McpServerStatus, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import {
  boundedSessionTools,
  hiddenText,
  withoutAddressAccount,
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

// The program of a stdio server's `command` and the arguments written after it, when the whole
// command line is in `command`. A Windows path often has a space in it (`C:\\Program Files\\…`),
// so the program is decided before the line is split: a leading quoted part; else a path up to
// the first word that ends in an executable's extension; else, when the text before the last
// path separator has a space and the last part has none, the whole text; else the first word.
export function commandParts(command: string): { readonly program: string; readonly rest: string } {
  const text = command.trim();
  const quoted = /^(["'])(.*?)\1(?:\s+|$)/.exec(text);
  if (quoted) return { program: quoted[2] ?? '', rest: text.slice(quoted[0].length) };
  // Only text that starts as a path can be a path with a space: `npx -y @tea/server` is not one.
  if (/^(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/]|~[\\/])/.test(text)) {
    const executable = /^(.*?[\\/][^\\/]*?\.(?:exe|cmd|bat|com|ps1))(?:\s+|$)/i.exec(text);
    if (executable?.[1] && /\s/.test(executable[1])) {
      return { program: executable[1], rest: text.slice(executable[0].length) };
    }
    const separator = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
    if (/\s/.test(text.slice(0, separator)) && !/\s/.test(text.slice(separator))) {
      return { program: text, rest: '' };
    }
  }
  const first = /^\S*/.exec(text)?.[0] ?? '';
  return { program: first, rest: text.slice(first.length).trim() };
}

const fileName = (program: string): string | null =>
  program
    .split(/[\\/]/)
    .filter((part) => part !== '')
    .at(-1) ?? null;

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
    // A whole command line written into `command` keeps its arguments out: only the program.
    const name = fileName(commandParts(command).program);
    return name === null || name === '' ? null : name;
  }
  return null;
}

// The string values of a list or a record (`args`, `env`, `headers`).
const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : Object.values(record(value) ?? {})).filter(
    (inner): inner is string => typeof inner === 'string',
  );

// Shorter values would hide parts of ordinary words.
const shortestHidden = 4;

const webAddress = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;
const credential = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi;

// Text a server or plugin reported about itself, such as a failure: every web address cut to its
// origin and a credential after Bearer, Basic or Token hidden. With the server's config, its
// command reads as the program's name and the values of its URL, arguments, environment and
// headers are hidden (spec 41). The server's secret net runs over it again before it is stored.
export function cleanReportedText(text: string, config?: unknown): string {
  let out = text;
  const fields = record(config);
  if (fields) {
    const command = fields['command'];
    const program = mcpAddress(config);
    let words: string[] = [];
    if (typeof command === 'string' && command.trim() !== '' && program !== null) {
      const parts = commandParts(command);
      out = out.split(command.trim()).join(program);
      // The program's path, quoted or not, reads as its file name too.
      for (const path of [`"${parts.program}"`, `'${parts.program}'`, parts.program]) {
        if (path.length >= shortestHidden) out = out.split(path).join(program);
      }
      // Each argument written after it is hidden as `args` are.
      words = parts.rest.split(/\s+/).flatMap((word) => [word, word.replace(/^["']|["']$/g, '')]);
    }
    const url = fields['url'];
    const urlParts: string[] = [];
    if (typeof url === 'string' && url !== '') {
      out = out.split(url).join(mcpAddress({ url }) ?? hiddenText);
      if (URL.canParse(url)) {
        const parsed = new URL(url);
        // The address written without its scheme reads as its host.
        for (const bare of [
          `${parsed.host}${parsed.pathname}${parsed.search}`,
          `${parsed.host}${parsed.pathname}`,
        ]) {
          if (bare !== parsed.host && parsed.host !== '') out = out.split(bare).join(parsed.host);
        }
        if (parsed.pathname !== '/') urlParts.push(parsed.pathname);
        urlParts.push(
          parsed.search,
          ...parsed.searchParams.values(),
          decodeURIComponent(parsed.username),
          decodeURIComponent(parsed.password),
        );
      }
    }
    const values = [
      ...words,
      ...urlParts,
      ...strings(fields['args']),
      ...strings(fields['env']),
      ...strings(fields['headers']),
    ]
      .filter((value) => value.length >= shortestHidden)
      .toSorted((a, b) => b.length - a.length);
    for (const value of values) out = out.split(value).join(hiddenText);
  }
  out = withoutAddressAccount(out).replace(webAddress, (found) => {
    // Punctuation that ends the sentence is not part of the address.
    const address = found.replace(/[.,;:!?)\]]+$/, '');
    const rest = found.slice(address.length);
    if (!URL.canParse(address)) return hiddenText + rest;
    const parsed = new URL(address);
    return (parsed.host === '' ? hiddenText : `${parsed.protocol}//${parsed.host}`) + rest;
  });
  return out.replace(credential, (_, word: string) => `${word} ${hiddenText}`);
}

// The user's own Claude Code binary writes the init message, and its lists were read from the SDK
// types only (spec Open risks): each is read as what it is, a list that is missing or of another
// shape reads as empty, and an entry without a string name is left out.
const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const textsOf = (value: unknown): string[] =>
  listOf(value).filter((entry): entry is string => typeof entry === 'string' && entry !== '');
const textOf = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;
const entriesOf = (value: unknown, key: string): Record<string, unknown>[] =>
  listOf(value)
    .map(record)
    .filter((entry): entry is Record<string, unknown> => textOf(entry?.[key]) !== null);

function pluginsOf(init: InitMessage): SessionPlugin[] {
  const errors = entriesOf(init.plugin_errors, 'plugin').map((error) => ({
    plugin: String(error['plugin']),
    text: cleanReportedText(`${String(error['type'])}: ${String(error['message'])}`),
  }));
  const plugins = entriesOf(init.plugins, 'name').map((plugin) => ({
    name: String(plugin['name']),
    version: textOf(plugin['version']),
  }));
  const errorsOf = (name: string) =>
    errors
      .filter((error) => error.plugin === name || error.plugin.split('@')[0] === name)
      .map((error) => error.text);
  const loaded = plugins.map((plugin) => ({
    name: plugin.name,
    version: plugin.version,
    loaded: true,
    errors: errorsOf(plugin.name),
  }));
  const known = new Set(plugins.map((plugin) => plugin.name));
  const failed = new Map<string, string[]>();
  for (const error of errors) {
    if (known.has(error.plugin) || known.has(error.plugin.split('@')[0] ?? '')) continue;
    failed.set(error.plugin, [...(failed.get(error.plugin) ?? []), error.text]);
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
  const tools = textsOf(init.tools);
  const servers = entriesOf(init.mcp_servers, 'name').map((server): McpServerInfo => {
    const name = String(server['name']);
    const word = textOf(server['status']) ?? 'unknown';
    return {
      name,
      state: stateOf(word),
      stateWord: word,
      error: null,
      source: textOf(server['source']),
      version: null,
      address: null,
      tools: tools
        .filter((tool) => tool.startsWith(mcpPrefix(name)))
        .map((tool) => ({
          name: tool.slice(mcpPrefix(name).length),
          description: '',
          readOnly: false,
          destructive: false,
        })),
    };
  });
  return boundedSessionTools({
    reportedAt,
    complete: false,
    mcpServers: servers,
    builtInTools: tools.filter((tool) => !tool.startsWith('mcp__')),
    skills: textsOf(init.skills).map((name) => ({ name, description: null })),
    commands: textsOf(init.slash_commands).map((name) => ({ name, description: '' })),
    agents: textsOf(init.agents).map((name) => ({ name, description: '', model: null })),
    plugins: pluginsOf(init),
    instructionFiles: [],
  });
}

export interface LiveAnswers {
  readonly status: readonly McpServerStatus[];
  readonly commands: readonly SlashCommand[];
  readonly agents: readonly AgentInfo[];
}

// Commands as the live query or `commands_changed` gave them, each with a string name.
const commandsOf = (value: unknown) =>
  entriesOf(value, 'name').map((command) => {
    const hint = textOf(command['argumentHint']);
    return {
      name: String(command['name']),
      description: textOf(command['description']) ?? '',
      ...(hint ? { argumentHint: hint } : {}),
    };
  });

// The init message's list completed with what the live query answered, read as defensively as
// the init message: an entry without a string name is left out.
export function completeSessionTools(base: SessionTools, live: LiveAnswers): SessionTools {
  const sourceOf = (name: string) =>
    base.mcpServers.find((server) => server.name === name)?.source ?? null;
  const commands = commandsOf(live.commands);
  const described = new Map(commands.map((command) => [command.name, command.description]));
  return boundedSessionTools({
    ...base,
    complete: true,
    mcpServers: entriesOf(live.status, 'name').map((server): McpServerInfo => {
      const name = String(server['name']);
      const word = textOf(server['status']) ?? 'unknown';
      const error = textOf(server['error']);
      const annotationsOf = (tool: Record<string, unknown>) => record(tool['annotations']);
      return {
        name,
        state: stateOf(word),
        stateWord: word,
        error:
          word === 'failed' && error !== null ? cleanReportedText(error, server['config']) : null,
        source: textOf(server['source']) ?? textOf(server['scope']) ?? sourceOf(name),
        version: textOf(record(server['serverInfo'])?.['version']),
        address: mcpAddress(server['config']),
        tools: entriesOf(server['tools'], 'name').map((tool) => ({
          name: String(tool['name']),
          description: textOf(tool['description']) ?? '',
          readOnly: annotationsOf(tool)?.['readOnly'] === true,
          destructive: annotationsOf(tool)?.['destructive'] === true,
        })),
      };
    }),
    skills: base.skills.map((skill) => ({
      name: skill.name,
      description: described.get(skill.name) || skill.description,
    })),
    commands,
    agents: entriesOf(live.agents, 'name').map((agent) => ({
      name: String(agent['name']),
      description: textOf(agent['description']) ?? '',
      model: textOf(agent['model']),
    })),
  });
}

// `system/commands_changed`: the commands replace the ones before.
export const withCommands = (tools: SessionTools, commands: unknown): SessionTools =>
  boundedSessionTools({ ...tools, commands: commandsOf(commands) });
