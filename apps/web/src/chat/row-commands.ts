import type { AppCommand } from '@/app/commands';
import type { RowAction } from '@/lib/row-actions';

// Palette commands for the row or message that last had the focus in the conversation: Copy
// message, Copy message text, Copy code, Copy output and "Show all N lines" (agent workbench spec
// 27, 32), the same actions as the row's own buttons.
export const rowActionCommands = (actions: readonly RowAction[]): AppCommand[] =>
  actions.map((action) => ({
    id: `chat.${action.id}`,
    title: action.title,
    group: 'Chat',
    keywords: [...(action.keywords ?? [])],
    detail: 'Focused row',
    run: () => void action.run(),
  }));
