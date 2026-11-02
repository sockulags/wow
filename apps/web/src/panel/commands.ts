import type { AppCommand, CommandGroup } from '@/app/commands';
import { hasSelection, type PanelSelection } from './model';
import { showInContextPanel } from './panel-state';

const groups: Readonly<Partial<Record<PanelSelection['view'], CommandGroup>>> = {
  calendar: 'Calendar',
  chat: 'Chat',
  run: 'Workflows',
  workflow: 'Workflows',
  backlog: 'Backlog',
};

const details: Readonly<Partial<Record<PanelSelection['view'], string>>> = {
  calendar: 'The selected card or meeting',
  chat: 'The open thread',
  run: "The run's active step",
  workflow: 'The open workflow',
  backlog: 'The open item',
};

// "Show in panel" for the open view's selection: opens the context panel and moves the focus
// into it. Listed only while the view has something selected.
export function panelCommands(selection: PanelSelection): AppCommand[] {
  const group = groups[selection.view];
  if (!group || !hasSelection(selection)) return [];
  return [
    {
      id: `panel.show.${selection.view}`,
      title: 'Show in panel',
      group,
      detail: details[selection.view] ?? '',
      keywords: ['context panel', 'details', 'right panel'],
      run: showInContextPanel,
    },
  ];
}
