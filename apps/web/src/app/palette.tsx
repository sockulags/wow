import { settingValue, type SettingsState } from '@wow/client-runtime';
import { useRouterState } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
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
import { paletteScore, startList, displayTitle } from './palette-model';
import { useLayout, useRuntime, useSetting } from './runtime';
import { sections } from './sections';

const groupOrder: readonly Group[] = [
  'Calendar',
  'Chat',
  'Threads',
  'Cards',
  'Workflows',
  'Backlog',
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

  const item = (command: AppCommand) => {
    const binding = command.keybinding ? settingValue(values, command.keybinding) : undefined;
    return (
      <CommandItem
        key={command.id}
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
    >
      <CommandFilter byId={byId}>
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
  children,
}: {
  byId: ReadonlyMap<string, AppCommand>;
  children: ReactNode;
}) {
  return (
    <Command
      loop
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
