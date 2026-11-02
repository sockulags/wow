import type { SettingKey } from '@wow/contracts';
import { settingValue, type Connection, type SettingsStore } from '@wow/client-runtime';
import type { useNavigate } from '@tanstack/react-router';
import type { DraftStore } from '@/chat/draft';
import type { LayoutStore } from './runtime';
import { sections, settingGroupTitles, settingsByGroup } from './sections';

// Everything the user can do from the keyboard. Feature units add their own commands here (threads,
// cards, backlog items, workflows) so the palette searches them together.

export type CommandGroup =
  | 'Calendar'
  | 'Cards'
  | 'Threads'
  | 'Chat'
  | 'Workflows'
  | 'Backlog'
  | 'Navigation'
  | 'Settings'
  | 'Actions';

export interface CommandContext {
  readonly navigate: ReturnType<typeof useNavigate>;
  readonly settings: SettingsStore;
  readonly layout: LayoutStore;
  readonly draft: DraftStore;
  readonly connection: Connection | undefined;
}

export interface AppCommand {
  readonly id: string;
  readonly title: string;
  // What the palette matches and tells items apart by, when titles can repeat (thread titles).
  readonly value?: string;
  readonly group: CommandGroup;
  readonly keywords?: readonly string[];
  readonly keybinding?: SettingKey;
  run(context: CommandContext): void;
}

const toggle =
  (key: 'sidebarOpen' | 'rightPanelOpen') =>
  ({ layout }: CommandContext) =>
    layout.setState((state) => ({ [key]: !state[key] }));

export function buildCommands(): readonly AppCommand[] {
  const navigation: AppCommand[] = sections.map((section) => ({
    id: `go.${section.id}`,
    title: `Go to ${section.title}`,
    group: 'Navigation',
    keywords: [section.title],
    keybinding: section.keybinding,
    run: ({ navigate }) => void navigate({ to: section.path }),
  }));

  const settingsPages: AppCommand[] = [...settingsByGroup().keys()].map((group) => ({
    id: `settings.${group}`,
    title: `Settings: ${settingGroupTitles[group]}`,
    group: 'Settings',
    keywords: ['settings', 'preferences', group],
    run: ({ navigate }) => void navigate({ to: '/settings/$group', params: { group } }),
  }));

  const actions: AppCommand[] = [
    {
      id: 'palette.open',
      title: 'Open command palette',
      group: 'Actions',
      keybinding: 'keybindings.palette',
      run: ({ layout }) => layout.setState({ paletteOpen: true }),
    },
    {
      id: 'layout.toggleSidebar',
      title: 'Toggle sidebar',
      group: 'Actions',
      keybinding: 'keybindings.toggleSidebar',
      run: toggle('sidebarOpen'),
    },
    {
      id: 'layout.toggleRightPanel',
      title: 'Toggle right panel',
      group: 'Actions',
      keybinding: 'keybindings.toggleRightPanel',
      run: toggle('rightPanelOpen'),
    },
    {
      id: 'appearance.toggleTheme',
      title: 'Toggle theme',
      group: 'Actions',
      keywords: ['dark', 'light', 'appearance'],
      keybinding: 'keybindings.toggleTheme',
      run: ({ settings }) => {
        const current = settingValue(settings.getState().values, 'appearance.theme');
        void settings.write('appearance.theme', current === 'dark' ? 'light' : 'dark');
      },
    },
  ];

  return [...navigation, ...settingsPages, ...actions];
}
