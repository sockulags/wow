import type { FileScope } from '@wow/contracts';
import type { Connection } from '@wow/client-runtime';
import { SquarePenIcon } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { useRuntime, useSetting } from '@/app/runtime';
import { eventToBinding, normalizeBinding } from '@/app/keybindings';
import { errorMessage } from '@/chat/data';
import { IconButton } from '@/components/hint';
import { notify } from '@/lib/feedback';

// "Open in editor" (agent workbench spec 81): the server opens a file of a run, thread or project
// at its line with the command the `viewer.editorCommand` setting names. The app only asks; what
// may be opened and how the editor starts are the server's.

export interface EditorTarget {
  readonly scope: FileScope;
  readonly path: string;
  readonly line?: number | undefined;
}

export async function openInEditor(
  connection: Connection | undefined,
  { scope, path, line }: EditorTarget,
): Promise<void> {
  if (!connection) {
    notify.error('Not opened in your editor', { description: 'The wow server is not connected.' });
    return;
  }
  try {
    await connection.request('files.openInEditor', {
      ...scope,
      path,
      ...(line !== undefined ? { line } : {}),
    });
  } catch (failure) {
    notify.error('Not opened in your editor', {
      id: 'open-in-editor',
      description: errorMessage(failure),
    });
  }
}

// Whether a key event is the given binding; empty bindings never match.
export function isBinding(event: KeyboardEvent, binding: string): boolean {
  if (binding === '') return false;
  return eventToBinding(event.nativeEvent) === normalizeBinding(binding);
}

// The open function and the keybinding's handler for one element: Shift+Enter (by default) on it
// opens its file.
export function useOpenInEditor(): {
  readonly open: (target: EditorTarget) => void;
  readonly onKey: (event: KeyboardEvent, target: EditorTarget | undefined) => boolean;
} {
  const { connection } = useRuntime();
  const binding = useSetting('keybindings.openInEditor');
  const open = (target: EditorTarget) => void openInEditor(connection, target);
  return {
    open,
    onKey: (event, target) => {
      if (target === undefined || event.defaultPrevented || !isBinding(event, binding)) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      open(target);
      return true;
    },
  };
}

export function OpenInEditorButton({
  target,
  name,
}: {
  readonly target: EditorTarget;
  // What is opened, for the button's label.
  readonly name?: string | undefined;
}) {
  const { open } = useOpenInEditor();
  return (
    <IconButton
      label={name ? `Open in editor: ${name}` : 'Open in editor'}
      shortcut="keybindings.openInEditor"
      size="icon-xs"
      className="text-muted-foreground"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        open(target);
      }}
    >
      <SquarePenIcon />
    </IconButton>
  );
}
