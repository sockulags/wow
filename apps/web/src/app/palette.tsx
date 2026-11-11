import { settingValue, type SettingsState } from '@wow/client-runtime';
import { useRouterState } from '@tanstack/react-router';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { KeyHint } from '@/components/hint';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import type { AppCommand, CommandContext, CommandGroup as Group } from './commands';
import { eventToBinding, hasCommandModifier, normalizeBinding } from './keybindings';
import { paletteScore, startList, displayTitle } from './palette-model';
import { useLayout, useRuntime, useSetting } from './runtime';
import { takePanelFocusRequest } from '@/panel/panel-state';
import { usePaletteThreadSearch } from '@/chat/thread-search';
import { sections } from './sections';

const groupOrder: readonly Group[] = [
  'Calendar',
  'Chat',
  'Threads',
  'Cards',
  'Workflows',
  'Plans',
  'Backlog',
  'Assistant',
  'Navigation',
  'Settings',
  'Actions',
];

export function CommandPalette({
  commands,
  context,
}: {
  commands: readonly AppCommand[];
  context: CommandContext;
}) {
  const { layout, settings } = useRuntime();
  const open = useLayout((state) => state.paletteOpen);
  const values = useStore(settings, (state: SettingsState) => state.values);
  const recentCount = useSetting('appearance.paletteRecent');
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [search, setSearch] = useState('');
  usePaletteThreadSearch(open ? search : '');
  const setOpen = (paletteOpen: boolean) => {
    layout.setState({ paletteOpen });
    if (!paletteOpen) setSearch('');
  };
  const view = sections.find((section) => pathname.startsWith(section.path));
  const shown = commands.filter((command) => command.id !== 'palette.open');
  const byId = new Map(shown.map((command) => [command.id, command]));

  // Before the user types: what needs them, what they touched last, and this view's actions.
  // Typing searches everything, titles ranked above keywords (audit C-13).
  const groups: ReadonlyArray<readonly [string, readonly AppCommand[]]> =
    search.trim() === ''
      ? startList(shown, view?.title, recentCount)
      : groupOrder.map(
          (group) => [group, shown.filter((command) => command.group === group)] as const,
        );

  // cmdk claims Ctrl+J/K/N/P for moving through the list and stops the event there, so the app's
  // shortcuts with a modifier would not work while the palette has focus, including while it fades
  // out after Escape (Ctrl+K pressed then was lost). They run here instead, like everywhere else.
  const onKeyDown = (event: KeyboardEvent) => {
    const pressed = eventToBinding(event);
    if (!pressed || !hasCommandModifier(pressed)) return;
    const command = shown
      .concat(commands.filter((candidate) => candidate.id === 'palette.open'))
      .find((candidate) => {
        const binding = candidate.keybinding ? settingValue(values, candidate.keybinding) : '';
        return (
          typeof binding === 'string' && binding !== '' && normalizeBinding(binding) === pressed
        );
      });
    if (!command) return;
    event.preventDefault();
    if (event.repeat && !command.repeatable) return;
    if (command.id !== 'palette.open') setOpen(false);
    command.run(context);
  };

  const item = (command: AppCommand) => {
    const binding = command.keybinding ? settingValue(values, command.keybinding) : undefined;
    return (
      <CommandItem
        // cmdk scores an item only when it mounts or the text changes, so one the server found
        // after the text was typed mounts again to be scored.
        key={command.foundBy === undefined ? command.id : `${command.id}\n${command.foundBy}`}
        value={command.id}
        keywords={[command.value ?? command.title]}
        onSelect={() => {
          setOpen(false);
          command.run(context);
        }}
      >
        <span className="min-w-0 flex-1 truncate">{displayTitle(command)}</span>
        {command.detail && (
          <span className="shrink-0 text-xs text-muted-foreground">{command.detail}</span>
        )}
        {typeof binding === 'string' && <KeyHint binding={binding} className="ml-1" />}
      </CommandItem>
    );
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search threads, views, settings and actions"
      showCloseButton={false}
      // A command that moved the focus on purpose ("Show in panel") keeps it there.
      onCloseAutoFocus={(event) => {
        if (takePanelFocusRequest(layout, true)) event.preventDefault();
      }}
    >
      <CommandFilter byId={byId} onKeyDown={onKeyDown}>
        <CommandInput
          placeholder="Type a command or search…"
          value={search}
          onValueChange={setSearch}
        />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          {groups.map(([heading, members]) =>
            members.length === 0 ? null : (
              <CommandGroup key={heading} heading={heading}>
                {members.map(item)}
              </CommandGroup>
            ),
          )}
        </CommandList>
      </CommandFilter>
    </CommandDialog>
  );
}

// CommandDialog owns its Command root and takes no filter, so the list sits in a nested Command
// whose filter knows each command.
function CommandFilter({
  byId,
  onKeyDown,
  children,
}: {
  byId: ReadonlyMap<string, AppCommand>;
  onKeyDown: (event: KeyboardEvent) => void;
  children: ReactNode;
}) {
  return (
    <Command
      loop
      onKeyDown={onKeyDown}
      filter={(value, query) => {
        const command = byId.get(value);
        return command ? paletteScore(command, query) : 0;
      }}
      className="[&_[cmdk-item]]:py-2"
    >
      {children}
    </Command>
  );
}
