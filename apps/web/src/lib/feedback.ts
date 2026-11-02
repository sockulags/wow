import type { ReactNode } from 'react';
import { toast } from 'sonner';

// Feedback for the user's own actions (design rules, "Errors"; owner decision F-9). Toasts go to
// the one <AppToaster> in the shell; how long they stay is the scheduler.toastSeconds setting.
// They pause on hover and focus, and Alt+T moves focus to them.

export interface NotifyOptions {
  // One sentence under the title.
  readonly description?: ReactNode | undefined;
  // One action, such as "Open" or "Retry".
  readonly action?: { readonly label: string; readonly onClick: () => void } | undefined;
  // Replaces an earlier toast with the same id instead of stacking.
  readonly id?: string | undefined;
}

const options = ({ description, action, id }: NotifyOptions = {}) => ({
  ...(description !== undefined ? { description } : {}),
  ...(action !== undefined ? { action } : {}),
  ...(id !== undefined ? { id } : {}),
});

export const notify = {
  // For actions that change something outside the current view ("Card created", "3 projects
  // imported"). Changes the user can already see need no toast.
  success: (message: string, opts?: NotifyOptions) => toast.success(message, options(opts)),
  // For errors that have no inline place next to what failed. Say what to do next.
  error: (message: string, opts?: NotifyOptions) => toast.error(message, options(opts)),
  info: (message: string, opts?: NotifyOptions) => toast(message, options(opts)),
  warning: (message: string, opts?: NotifyOptions) => toast.warning(message, options(opts)),
  dismiss: (id?: string | number) => toast.dismiss(id),
};

export interface UndoOptions {
  // What happened, in the past tense: "Card deleted", "Project removed".
  readonly message: string;
  readonly description?: ReactNode | undefined;
  // Puts the thing back (a create command with the old fields, for example). A failure is shown
  // as an error toast.
  readonly undo: () => Promise<unknown> | void;
  // Said after a successful undo; defaults to "Restored".
  readonly undoneMessage?: string | undefined;
}

// Delete at once, offer Undo (owner decision F-9). Call it after the delete succeeded:
//
//   await dispatch({ type: 'card.delete', cardId });
//   offerUndo({ message: 'Card deleted', undo: () => dispatch({ type: 'card.create', ...old }) });
export function offerUndo({ message, description, undo, undoneMessage = 'Restored' }: UndoOptions) {
  return toast(message, {
    ...(description !== undefined ? { description } : {}),
    action: {
      label: 'Undo',
      onClick: () => {
        void Promise.resolve()
          .then(undo)
          .then(
            () => toast.success(undoneMessage),
            (error: unknown) =>
              toast.error('Could not undo', {
                description: error instanceof Error ? error.message : String(error),
              }),
          );
      },
    },
  });
}
