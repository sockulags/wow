import { ProviderSlashCommand, type Skill } from '@wow/contracts';
import type { Connection } from '@wow/client-runtime';
import { useEffect, useState } from 'react';
import { createStore } from 'zustand';
import { useRuntime } from '@/app/runtime';
import type { AppCommand, CommandContext } from '@/app/commands';

// The "Commands" group of the composer's `/` list (agent workbench spec 58 to 60): wow's own
// commands, each the palette command of that name for the open thread, then the provider's.

export interface SlashCommandEntry {
  readonly name: string;
  readonly description: string;
  // The palette command it runs. Commands of other units are named here before they exist; an
  // entry is listed only while its palette command is there for the thread.
  readonly commandId: string;
}

export const slashCommandTable: readonly SlashCommandEntry[] = [
  { name: 'model', description: 'Choose the model', commandId: 'modelBar.chooseModel' },
  { name: 'effort', description: 'Choose the effort', commandId: 'modelBar.chooseEffort' },
  { name: 'mode', description: 'Choose the permission mode', commandId: 'modelBar.chooseMode' },
  { name: 'plan', description: 'Switch to plan mode', commandId: 'modelBar.mode.plan' },
  { name: 'compact', description: 'Compact the conversation', commandId: 'chat.compact' },
  {
    name: 'clear',
    description: 'Start a new thread with the same settings',
    commandId: 'chat.clear',
  },
  { name: 'fork', description: 'Fork the thread', commandId: 'chat.fork' },
  { name: 'rename', description: 'Rename the thread', commandId: 'chat.renameThread' },
  { name: 'done', description: 'Mark the thread done', commandId: 'chat.markDone' },
  { name: 'stop', description: 'Stop the turn', commandId: 'chat.stop' },
  { name: 'open', description: 'Open the folder in your editor', commandId: 'chat.openInEditor' },
];

// One row of the list: a wow command runs, a provider command goes into the text.
export type CommandPick =
  | { readonly kind: 'wow'; readonly entry: SlashCommandEntry; readonly command: AppCommand }
  | { readonly kind: 'provider'; readonly command: ProviderSlashCommand };

const rankOf = (name: string, needle: string): number =>
  name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : 2;

const byRank = <T>(items: readonly T[], name: (item: T) => string, query: string): T[] => {
  const needle = query.toLowerCase();
  return items
    .map((item, at) => ({ item, at, rank: rankOf(name(item).toLowerCase(), needle) }))
    .filter((entry) => entry.rank < 2)
    .toSorted((a, b) => a.rank - b.rank || a.at - b.at)
    .map((entry) => entry.item);
};

// wow's commands whose palette command exists now, in the table's order, best matches first.
export function wowCommandPicks(commands: readonly AppCommand[], query: string): CommandPick[] {
  const byId = new Map(commands.map((command) => [command.id, command]));
  const listed = slashCommandTable.flatMap((entry) => {
    const command = byId.get(entry.commandId);
    return command ? [{ entry, command }] : [];
  });
  return byRank(listed, ({ entry }) => entry.name, query).map(({ entry, command }) => ({
    kind: 'wow',
    entry,
    command,
  }));
}

// The provider's commands after wow's (spec 60). A name wow lists or a skill the list already
// shows is left out, so one name is one row.
export function providerCommandPicks(
  provider: readonly ProviderSlashCommand[],
  wow: readonly CommandPick[],
  skills: readonly Skill[],
  query: string,
): CommandPick[] {
  const taken = new Set([
    ...wow.flatMap((pick) => (pick.kind === 'wow' ? [pick.entry.name] : [])),
    ...slashCommandTable.map((entry) => entry.name),
    ...skills.map((skill) => skill.name),
  ]);
  return byRank(
    provider.filter((command) => !taken.has(command.name)),
    (command) => command.name,
    query,
  ).map((command) => ({ kind: 'provider', command }));
}

// What a provider command puts in the text box: sent as text, as typed (spec 60).
export const providerCommandText = (command: ProviderSlashCommand): string => `/${command.name} `;

// The palette's commands and their context, as the shell has them, so a `/` pick runs the same
// command the palette would.
interface PaletteCommandsState {
  readonly commands: readonly AppCommand[];
  readonly context: CommandContext | undefined;
}

export const paletteCommandsStore = createStore<PaletteCommandsState>(() => ({
  commands: [],
  context: undefined,
}));

export function publishPaletteCommands(
  commands: readonly AppCommand[],
  context: CommandContext,
): void {
  paletteCommandsStore.setState({ commands, context });
}

export function runPaletteCommand(command: AppCommand): void {
  const { context } = paletteCommandsStore.getState();
  if (context) command.run(context);
}

// The provider's commands for a folder, asked once per connection, instance and folder.
const commandRequests = new WeakMap<Connection, Map<string, Promise<ProviderSlashCommand[]>>>();

function requestCommands(
  connection: Connection,
  providerInstanceId: string,
  cwd: string,
  threadId: string | undefined,
): Promise<ProviderSlashCommand[]> {
  let perConnection = commandRequests.get(connection);
  if (!perConnection) {
    perConnection = new Map();
    commandRequests.set(connection, perConnection);
  }
  const key = `${providerInstanceId}\n${cwd}`;
  let request = perConnection.get(key);
  if (!request) {
    request = connection
      .request('provider.listCommands', {
        providerInstanceId,
        cwd,
        ...(threadId ? { threadId } : {}),
      })
      .then((result) => ProviderSlashCommand.array().parse(result));
    // A failed request is asked again next time; the list shows wow's commands meanwhile.
    request.catch(() => perConnection.delete(key));
    perConnection.set(key, request);
  }
  return request;
}

export interface CommandSource {
  readonly providerInstanceId: string;
  readonly cwd: string;
  readonly threadId?: string | undefined;
}

const none: readonly ProviderSlashCommand[] = [];

export function useProviderCommands(
  source: CommandSource | undefined,
  wanted: boolean,
): readonly ProviderSlashCommand[] {
  const { connection } = useRuntime();
  const [state, setState] = useState<{
    readonly key: string;
    readonly commands: readonly ProviderSlashCommand[];
  }>();
  const key = source ? `${source.providerInstanceId}\n${source.cwd}` : undefined;
  const providerInstanceId = source?.providerInstanceId;
  const cwd = source?.cwd;
  const threadId = source?.threadId;
  useEffect(() => {
    if (!connection || !wanted || providerInstanceId === undefined || cwd === undefined) {
      return undefined;
    }
    let current = true;
    requestCommands(connection, providerInstanceId, cwd, threadId).then(
      (commands) => current && setState({ key: `${providerInstanceId}\n${cwd}`, commands }),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [connection, wanted, providerInstanceId, cwd, threadId]);
  return state && state.key === key ? state.commands : none;
}
