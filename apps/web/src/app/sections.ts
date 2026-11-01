import { SettingGroup, settingsRegistry, type SettingDefinition } from '@wow/contracts';
import {
  CalendarDaysIcon,
  ListTodoIcon,
  MessagesSquareIcon,
  SettingsIcon,
  WorkflowIcon,
  type LucideIcon,
} from 'lucide-react';

export interface Section {
  readonly id: 'calendar' | 'chat' | 'workflows' | 'backlog' | 'settings';
  readonly title: string;
  readonly path: '/calendar' | '/chat' | '/workflows' | '/backlog' | '/settings';
  readonly icon: LucideIcon;
  readonly keybinding:
    | 'keybindings.goCalendar'
    | 'keybindings.goChat'
    | 'keybindings.goWorkflows'
    | 'keybindings.goBacklog'
    | 'keybindings.goSettings';
}

// Sidebar order.
export const sections: readonly Section[] = [
  {
    id: 'calendar',
    title: 'Calendar',
    path: '/calendar',
    icon: CalendarDaysIcon,
    keybinding: 'keybindings.goCalendar',
  },
  {
    id: 'chat',
    title: 'Chat',
    path: '/chat',
    icon: MessagesSquareIcon,
    keybinding: 'keybindings.goChat',
  },
  {
    id: 'workflows',
    title: 'Workflows',
    path: '/workflows',
    icon: WorkflowIcon,
    keybinding: 'keybindings.goWorkflows',
  },
  {
    id: 'backlog',
    title: 'Backlog',
    path: '/backlog',
    icon: ListTodoIcon,
    keybinding: 'keybindings.goBacklog',
  },
  {
    id: 'settings',
    title: 'Settings',
    path: '/settings',
    icon: SettingsIcon,
    keybinding: 'keybindings.goSettings',
  },
];

export const settingGroupTitles: Readonly<Record<SettingGroup, string>> = {
  providers: 'Providers',
  calendar: 'Calendar',
  outlook: 'Outlook',
  scheduler: 'Scheduler',
  workflows: 'Workflows',
  skills: 'Skills',
  trackers: 'Trackers',
  appearance: 'Appearance',
  keybindings: 'Keybindings',
  desktop: 'Desktop',
  advanced: 'Advanced',
};

export type SettingEntry = readonly [key: string, definition: SettingDefinition];

export function settingsByGroup(
  definitions: Readonly<Record<string, SettingDefinition>> = settingsRegistry,
): ReadonlyMap<SettingGroup, readonly SettingEntry[]> {
  const groups = new Map<SettingGroup, SettingEntry[]>();
  // Registry order inside a group, enum order between groups.
  for (const group of SettingGroup.options) {
    const entries = Object.entries(definitions).filter(([, d]) => d.group === group);
    if (entries.length > 0) groups.set(group, entries);
  }
  return groups;
}

export const isSettingGroup = (value: string): value is SettingGroup =>
  SettingGroup.safeParse(value).success;
