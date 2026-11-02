import type { BacklogItem } from '@wow/contracts';
import type { AppCommand } from '@/app/commands';
import { backlogStateLabels } from './model';

export interface BacklogCommandData {
  readonly items: readonly BacklogItem[];
  // The item open in the backlog view, if any.
  readonly openItem: BacklogItem | undefined;
}

// Palette commands for the backlog (spec 22): new item, every item, and for the open item Plan
// on calendar, Publish to Jira and Publish to GitHub.
export function backlogCommands({ items, openItem }: BacklogCommandData): AppCommand[] {
  const commands: AppCommand[] = [
    {
      id: 'backlog.new',
      title: 'New backlog item',
      group: 'Backlog',
      keywords: ['backlog', 'idea', 'create', 'add'],
      run: ({ navigate }) => void navigate({ to: '/backlog/new' }),
    },
  ];
  if (openItem) {
    const itemId = openItem.id;
    const open = (dialog: 'plan' | 'jira' | 'github') => ({
      run: ({ navigate }: Parameters<AppCommand['run']>[0]) =>
        void navigate({ to: '/backlog/$itemId', params: { itemId }, search: { dialog } }),
    });
    commands.push(
      {
        id: 'backlog.plan',
        title: 'Plan on calendar',
        group: 'Backlog',
        keywords: ['backlog', 'schedule', 'card', 'workflow'],
        ...open('plan'),
      },
      {
        id: 'backlog.publishJira',
        title: 'Publish to Jira',
        group: 'Backlog',
        keywords: ['backlog', 'issue', 'tracker', 'jira'],
        ...open('jira'),
      },
      {
        id: 'backlog.publishGitHub',
        title: 'Publish to GitHub',
        group: 'Backlog',
        keywords: ['backlog', 'issue', 'tracker', 'github'],
        ...open('github'),
      },
    );
  }
  for (const item of items) {
    commands.push({
      id: `backlogItem.${item.id}`,
      title: `Backlog: ${item.title}`,
      value: `Backlog ${item.title} ${item.tags.join(' ')} ${item.id}`,
      group: 'Backlog',
      keywords: ['backlog', backlogStateLabels[item.state].toLowerCase(), ...item.tags],
      run: ({ navigate }) => void navigate({ to: '/backlog/$itemId', params: { itemId: item.id } }),
    });
  }
  return commands;
}
