import {
  mcpServerStateLabels,
  mcpServersNeedingYou,
  rpcMethods,
  ToolCallItemPayload,
  type McpServerInfo,
  type ProviderKind,
  type SessionTools,
  type ThreadItem,
  type ThreadTools,
} from '@wow/contracts';
import { useRouter } from '@tanstack/react-router';
import { PlugZapIcon, RefreshCwIcon, WrenchIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import type { AppCommand, CommandContext } from '@/app/commands';
import { useRuntime, type LayoutStore, type ViewerTools } from '@/app/runtime';
import { errorMessage, useTopic } from '@/chat/data';
import { EmptyState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { notify } from '@/lib/feedback';
import { useDateFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { routerPanelRoute } from './model';
import { closeTab, openTools, panelTabsOf, toolsTabId } from './viewer';

// What a chat thread's session can use (thread work spec 37 to 43): the provider's last report,
// stored by the server (`threadTools`), shown with a filter. Refresh asks the live session only.
// Names and descriptions are plain text; nothing here starts a session or a server.

interface PanelContext {
  readonly layout: LayoutStore;
  readonly settings: CommandContext['settings'];
}

export const openThreadTools = (context: PanelContext, threadId: string, from: string): void =>
  openTools(context, { threadId, from });

export const closeThreadTools = (layout: LayoutStore, from: string, threadId: string): void =>
  closeTab(layout, from, toolsTabId(threadId));

export const toolsShown = (
  state: Parameters<typeof panelTabsOf>[0],
  from: string,
  threadId: string | undefined,
): boolean => threadId !== undefined && panelTabsOf(state, from).selected === toolsTabId(threadId);

export const signInText = 'Sign in from Claude Code: /mcp in a terminal';
export const codexNoListText =
  'Codex reports no list of its servers, tools or skills to wow. Shown here: the instruction files the thread loaded and the MCP servers its own tool calls used.';
export const seenText = "Seen in this thread's tool calls";

const serverCount = (n: number) => `${n} MCP ${n === 1 ? 'server' : 'servers'}`;
const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// "1 MCP server failed", "2 MCP servers need sign-in", both joined; undefined while none does.
export function toolsChipText(tools: SessionTools | undefined): string | undefined {
  const { failed, needsAuth } = mcpServersNeedingYou(tools);
  if (failed > 0 && needsAuth > 0)
    return `${serverCount(failed)} failed, ${needsAuth} ${needsAuth === 1 ? 'needs' : 'need'} sign-in`;
  if (failed > 0) return `${serverCount(failed)} failed`;
  if (needsAuth > 0)
    return `${serverCount(needsAuth)} ${needsAuth === 1 ? 'needs' : 'need'} sign-in`;
  return undefined;
}

// The MCP servers and tools a thread's own tool rows name (spec 42), for a provider that lists
// none: Codex.
export function seenServers(items: readonly ThreadItem[]): McpServerInfo[] {
  const servers = new Map<string, Set<string>>();
  for (const item of items) {
    if (item.kind !== 'tool_call') continue;
    const call = ToolCallItemPayload.safeParse(item.payload);
    if (!call.success || call.data.kind !== 'mcp' || !call.data.server) continue;
    const tools = servers.get(call.data.server) ?? new Set<string>();
    if (call.data.tool) tools.add(call.data.tool);
    servers.set(call.data.server, tools);
  }
  return [...servers].map(([name, tools]) => ({
    name,
    state: 'other',
    stateWord: '',
    error: null,
    source: null,
    version: null,
    address: null,
    tools: [...tools].map((tool) => ({
      name: tool,
      description: '',
      readOnly: false,
      destructive: false,
    })),
  }));
}

const matches = (query: string, ...texts: readonly (string | null | undefined)[]) =>
  texts.some((text) => text?.toLowerCase().includes(query) === true);

// The lists narrowed to what holds every word typed in the filter (spec 38). A server stays
// when its name or one of its tools matches; then only the matching tools are shown, unless the
// server itself matched.
export function filterSessionTools(tools: SessionTools, filter: string): SessionTools {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return tools;
  const all = (...texts: readonly (string | null | undefined)[]) =>
    words.every((word) => matches(word, ...texts));
  return {
    ...tools,
    mcpServers: tools.mcpServers.flatMap((server) => {
      if (all(server.name, server.address, server.source, server.error)) return [server];
      const shown = server.tools.filter((tool) => all(tool.name, tool.description));
      return shown.length > 0 ? [{ ...server, tools: shown }] : [];
    }),
    builtInTools: tools.builtInTools.filter((name) => all(name)),
    skills: tools.skills.filter((skill) => all(skill.name, skill.description)),
    commands: tools.commands.filter((command) => all(command.name, command.description)),
    agents: tools.agents.filter((agent) => all(agent.name, agent.description, agent.model)),
    plugins: tools.plugins.filter((plugin) => all(plugin.name, ...plugin.errors)),
    instructionFiles: tools.instructionFiles.filter((file) => all(file)),
  };
}

// The list the tab shows: the stored report, with what the thread's tool calls used on a
// provider that reports no servers.
export function shownTools(
  row: ThreadTools | undefined,
  kind: ProviderKind | undefined,
  items: readonly ThreadItem[],
): { readonly tools: SessionTools | undefined; readonly seen: ReadonlySet<string> } {
  if (kind !== 'codex') return { tools: row?.tools, seen: new Set() };
  const reported = new Set(row?.tools.mcpServers.map((server) => server.name));
  const extra = seenServers(items).filter((server) => !reported.has(server.name));
  if (!row && extra.length === 0) return { tools: undefined, seen: new Set() };
  const base: SessionTools = row?.tools ?? {
    reportedAt: '',
    complete: false,
    mcpServers: [],
    builtInTools: [],
    skills: [],
    commands: [],
    agents: [],
    plugins: [],
    instructionFiles: [],
  };
  return {
    tools: { ...base, mcpServers: [...base.mcpServers, ...extra] },
    seen: new Set(extra.map((server) => server.name)),
  };
}

// Refresh (spec 39): asks the live session, says what came of it.
export async function refreshThreadTools(
  connection: CommandContext['connection'],
  threadId: string,
): Promise<void> {
  if (!connection) return;
  try {
    const { outcome } = rpcMethods['threads.refreshTools'].result.parse(
      await connection.request('threads.refreshTools', { threadId }),
    );
    if (outcome === 'unchanged') notify.info('The session reports the same list');
    else if (outcome === 'noSession') {
      notify.info('The session is no longer open', {
        description: 'The list is filled again at the next turn.',
      });
    }
  } catch (error) {
    notify.error('The session was not asked', { description: errorMessage(error) });
  }
}

// The palette's commands for the thread on screen (spec 37, 39).
export function sessionToolsCommands(
  threadId: string | undefined,
  route: string,
  open: boolean,
  live: boolean,
): AppCommand[] {
  if (threadId === undefined) return [];
  return [
    {
      id: 'chat.sessionTools',
      title: open ? 'Hide session tools' : 'Show session tools',
      group: 'Chat',
      keywords: ['tools', 'mcp', 'servers', 'skills', 'commands', 'agents', 'plugins'],
      run: (context) => {
        if (open) closeThreadTools(context.layout, route, threadId);
        else openThreadTools(context, threadId, route);
      },
    },
    ...(live
      ? [
          {
            id: 'chat.refreshTools',
            title: 'Refresh session tools',
            group: 'Chat',
            keywords: ['tools', 'mcp', 'refresh', 'reload'],
            run: (context: CommandContext) => void refreshThreadTools(context.connection, threadId),
          } satisfies AppCommand,
        ]
      : []),
  ];
}

// The header chip (spec 37): shown while a server failed or needs sign-in; it opens the tab.
export function ToolsChip({ threadId }: { readonly threadId: string }) {
  const { settings, layout } = useRuntime();
  const router: ReturnType<typeof useRouter> | undefined = useRouter({ warn: false });
  const row = useTopic('threadTools', threadId)?.[0];
  const text = toolsChipText(row?.tools);
  if (text === undefined) return null;
  return (
    <Badge asChild variant="warning" className="min-w-0 shrink">
      <button
        type="button"
        data-testid="tools-chip"
        title={text}
        onClick={() => openThreadTools({ settings, layout }, threadId, routerPanelRoute(router))}
      >
        <PlugZapIcon aria-hidden />
        <span className="truncate">{text}</span>
      </button>
    </Badge>
  );
}

// "3 MCP servers, 12 tools, 2 skills" for Details; undefined before the first report.
export function toolsSummary(tools: SessionTools | undefined): string | undefined {
  if (!tools) return undefined;
  const toolCount =
    tools.builtInTools.length +
    tools.mcpServers.reduce((sum, server) => sum + server.tools.length, 0);
  return [
    counted(tools.mcpServers.length, 'MCP server', 'MCP servers'),
    counted(toolCount, 'tool', 'tools'),
    counted(tools.skills.length, 'skill', 'skills'),
  ].join(', ');
}

function Section({
  label,
  count,
  children,
}: {
  readonly label: string;
  readonly count: number;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5 px-4 pt-4">
      <h4 id={id} className="text-2xs font-medium text-muted-foreground">
        {label} <span className="tabular-nums">({count})</span>
      </h4>
      {count === 0 ? <p className="text-xs text-muted-foreground">None.</p> : children}
    </section>
  );
}

const stateVariant = (state: McpServerInfo['state']) =>
  state === 'connected'
    ? 'secondary'
    : state === 'failed'
      ? 'destructive'
      : state === 'needsAuth'
        ? 'warning'
        : 'outline';

function ServerRow({ server, seen }: { readonly server: McpServerInfo; readonly seen: boolean }) {
  const facts = [server.source, server.version, server.address].filter(
    (fact): fact is string => fact !== null && fact !== '',
  );
  return (
    <li
      data-testid="tools-server"
      className="flex flex-col gap-1 rounded-md border border-border p-2"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-mono text-xs font-medium">{server.name}</span>
        {seen ? (
          <Badge variant="outline">{seenText}</Badge>
        ) : (
          <Badge variant={stateVariant(server.state)} data-testid="tools-server-state">
            {server.state === 'other' && server.stateWord !== ''
              ? server.stateWord
              : mcpServerStateLabels[server.state]}
          </Badge>
        )}
      </div>
      {facts.length > 0 && (
        <p className="text-2xs text-muted-foreground" data-testid="tools-server-facts">
          {facts.join(' · ')}
        </p>
      )}
      {server.state === 'failed' && server.error !== null && (
        <p className="text-xs break-words text-destructive" data-testid="tools-server-error">
          {server.error}
        </p>
      )}
      {server.state === 'needsAuth' && <p className="text-xs">{signInText}</p>}
      {server.tools.length > 0 && (
        <ul aria-label={`Tools of ${server.name}`} className="flex flex-col gap-0.5 pl-2">
          {server.tools.map((tool) => (
            <li key={tool.name} className="text-xs">
              <span className="font-mono">{tool.name}</span>
              {tool.readOnly && (
                <span className="ml-1.5 text-2xs text-muted-foreground">read-only</span>
              )}
              {tool.destructive && (
                <span className="ml-1.5 text-2xs text-destructive">destructive</span>
              )}
              {tool.description !== '' && (
                <span className="block text-muted-foreground">{tool.description}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function NameList({
  label,
  entries,
}: {
  readonly label: string;
  readonly entries: readonly { readonly name: string; readonly detail?: string | null }[];
}) {
  return (
    <ul aria-label={label} className="flex flex-col gap-0.5">
      {entries.map((entry) => (
        <li key={entry.name} className="text-xs">
          <span className="font-mono">{entry.name}</span>
          {entry.detail ? <span className="text-muted-foreground"> · {entry.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function ToolsTab({ tools: tab }: { readonly tools: ViewerTools }) {
  const { threadId } = tab;
  const { connection } = useRuntime();
  const { when } = useDateFormat();
  const [filter, setFilter] = useState('');
  const [asking, setAsking] = useState(false);
  const threads = useTopic('threads');
  const instances = useTopic('providerInstances') ?? [];
  const row = useTopic('threadTools', threadId)?.[0];
  const thread = threads?.find((candidate) => candidate.id === threadId);
  const kind = instances.find((instance) => instance.id === thread?.providerInstanceId)?.kind;
  const items = useTopic('threadItems', kind === 'codex' ? threadId : undefined) ?? [];
  const filterId = useId();
  const { tools, seen } = shownTools(row, kind, items);
  const shown = tools ? filterSessionTools(tools, filter) : undefined;
  const live = row?.live === true;

  const refresh = async () => {
    setAsking(true);
    await refreshThreadTools(connection, threadId);
    setAsking(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="tools-tab">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground" data-testid="tools-reported">
            {row
              ? row.source === 'refresh'
                ? `Reported on Refresh at ${when(row.tools.reportedAt)}`
                : `Reported as the turn of ${when(row.tools.reportedAt)} started`
              : 'Nothing reported yet. The list is filled at the next turn.'}
            {row && !live && ' · The session is closed; the list is filled again at the next turn.'}
          </p>
          {live && (
            <Button size="xs" variant="outline" disabled={asking} onClick={() => void refresh()}>
              <RefreshCwIcon className={cn(asking && 'animate-spin')} />
              Refresh
            </Button>
          )}
        </div>
        {row && !row.tools.complete && kind !== 'codex' && (
          <p className="text-2xs text-muted-foreground" data-testid="tools-incomplete">
            Claude Code did not answer for the details; only names and states are shown.
          </p>
        )}
        {kind === 'codex' && (
          <p className="text-2xs text-muted-foreground" data-testid="tools-codex">
            {codexNoListText}
          </p>
        )}
        {tools && (
          <>
            <label htmlFor={filterId} className="sr-only">
              Filter session tools
            </label>
            <Input
              id={filterId}
              value={filter}
              placeholder="Filter"
              className="h-7 text-xs"
              onChange={(event) => setFilter(event.target.value)}
            />
          </>
        )}
      </div>
      {!shown ? (
        <EmptyState
          compact
          icon={WrenchIcon}
          title="No list yet"
          description="What the session can use is reported when a turn starts. wow starts no session to read it."
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pb-4">
          <Section label="MCP servers" count={shown.mcpServers.length}>
            <ul aria-label="MCP servers" className="flex flex-col gap-1.5">
              {shown.mcpServers.map((server) => (
                <ServerRow key={server.name} server={server} seen={seen.has(server.name)} />
              ))}
            </ul>
          </Section>
          {kind !== 'codex' && (
            <>
              <Section label="Built-in tools" count={shown.builtInTools.length}>
                <NameList
                  label="Built-in tools"
                  entries={shown.builtInTools.map((name) => ({ name }))}
                />
              </Section>
              <Section label="Skills" count={shown.skills.length}>
                <NameList
                  label="Skills"
                  entries={shown.skills.map((skill) => ({
                    name: skill.name,
                    detail: skill.description,
                  }))}
                />
              </Section>
              <Section label="Commands" count={shown.commands.length}>
                <NameList
                  label="Commands"
                  entries={shown.commands.map((command) => ({
                    name: `/${command.name}`,
                    detail: command.description,
                  }))}
                />
              </Section>
              <Section label="Subagents" count={shown.agents.length}>
                <NameList
                  label="Subagents"
                  entries={shown.agents.map((agent) => ({
                    name: agent.name,
                    detail: [agent.description, agent.model].filter(Boolean).join(' · '),
                  }))}
                />
              </Section>
              <Section label="Plugins" count={shown.plugins.length}>
                <NameList
                  label="Plugins"
                  entries={shown.plugins.map((plugin) => ({
                    name: plugin.name,
                    detail: [
                      plugin.version,
                      plugin.loaded ? null : 'did not load',
                      ...plugin.errors,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  }))}
                />
              </Section>
            </>
          )}
          {(kind === 'codex' || shown.instructionFiles.length > 0) && (
            <Section label="Instruction files" count={shown.instructionFiles.length}>
              <NameList
                label="Instruction files"
                entries={shown.instructionFiles.map((name) => ({ name }))}
              />
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
