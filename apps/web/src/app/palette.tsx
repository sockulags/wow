import { settingValue, type SettingsState } from '@wow/client-runtime';
import { useStore } from 'zustand';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import type { AppCommand, CommandContext, CommandGroup as Group } from './commands';
import { formatBinding } from './keybindings';
import { useLayout, useRuntime } from './runtime';

const groupOrder: readonly Group[] = [
  'Chat',
  'Threads',
  'Workflows',
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
  const setOpen = (paletteOpen: boolean) => layout.setState({ paletteOpen });

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search threads, views, settings and actions"
      showCloseButton={false}
    >
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        {groupOrder.map((group) => {
          const members = commands.filter(
            (command) => command.group === group && command.id !== 'palette.open',
          );
          if (members.length === 0) return null;
          return (
            <CommandGroup key={group} heading={group}>
              {members.map((command) => {
                const binding = command.keybinding
                  ? settingValue(values, command.keybinding)
                  : undefined;
                return (
                  <CommandItem
                    key={command.id}
                    value={command.value ?? command.title}
                    keywords={[...(command.keywords ?? [])]}
                    onSelect={() => {
                      setOpen(false);
                      command.run(context);
                    }}
                  >
                    {command.title}
                    {typeof binding === 'string' && binding !== '' && (
                      <CommandShortcut>{formatBinding(binding)}</CommandShortcut>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}
