import {
  ApplyPreview,
  applyConfirmedOf,
  applyLeftWords,
  type ApplyFile,
  type ChangesAppliedItemPayload,
} from '@wow/contracts';
import { RpcClientError, dispatch, type Connection } from '@wow/client-runtime';
import { FolderInputIcon, Undo2Icon } from 'lucide-react';
import { createStore, useStore } from 'zustand';
import { useRuntime } from '@/app/runtime';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { notify } from '@/lib/feedback';
import { errorMessage } from './data';
import { appliedLineText } from './git-lines';
import { threadChangesStore } from './thread-changes';

// Apply to project folder (parallel threads spec 1 to 9): the confirm that lists what Apply
// writes into the project folder, read from the server when it opens, and the line Apply leaves
// in the conversation with its Undo.

export interface ApplyQuestion {
  readonly threadId: string;
  // What Apply would do, as last read; undefined while it is read.
  readonly preview: ApplyPreview | undefined;
  // The server found other changes than the confirm showed, and it asks again with those.
  readonly changed: boolean;
  readonly busy: boolean;
  readonly error: string | undefined;
}

export const applyStore = createStore<{ readonly question: ApplyQuestion | undefined }>(() => ({
  question: undefined,
}));

const patch = (changes: Partial<ApplyQuestion>) =>
  applyStore.setState((state) =>
    state.question ? { question: { ...state.question, ...changes } } : state,
  );

// Opens the confirm and reads what Apply would do at this moment (spec 4, 5).
export async function askApply(connection: Connection | undefined, threadId: string) {
  applyStore.setState({
    question: { threadId, preview: undefined, changed: false, busy: true, error: undefined },
  });
  if (!connection) {
    patch({ busy: false, error: 'The wow server is not connected.' });
    return;
  }
  try {
    const preview = ApplyPreview.parse(
      await connection.request('threads.applyPreview', { threadId }),
    );
    if (applyStore.getState().question?.threadId === threadId) patch({ preview, busy: false });
  } catch (failure) {
    if (applyStore.getState().question?.threadId === threadId) {
      patch({ busy: false, error: errorMessage(failure) });
    }
  }
}

export function closeApply(): void {
  const { question } = applyStore.getState();
  if (!question || question.busy) return;
  applyStore.setState({ question: undefined });
}

// Applies after the user's yes; when the folders hold other changes than were shown, the server
// refuses with what it finds now and the confirm asks again with that (spec 6).
export async function confirmApply(connection: Connection | undefined): Promise<void> {
  const question = applyStore.getState().question;
  if (!question?.preview || question.preview.status !== 'ok' || question.busy || !connection) {
    return;
  }
  const { threadId, preview } = question;
  patch({ busy: true, error: undefined });
  try {
    await dispatch(connection, {
      type: 'thread.applyToProject',
      threadId,
      confirmed: applyConfirmedOf(preview),
    });
    applyStore.setState((state) =>
      state.question?.threadId === threadId ? { question: undefined } : state,
    );
    threadChangesStore.setState((state) => ({ refresh: state.refresh + 1 }));
  } catch (failure) {
    const now =
      failure instanceof RpcClientError && failure.code === 'conflict'
        ? ApplyPreview.safeParse(failure.data).data
        : undefined;
    if (now) patch({ busy: false, preview: now, changed: true });
    else patch({ busy: false, error: errorMessage(failure) });
  }
}

// Undo on the newest apply line (spec 9). The server says per file what went back.
export async function undoApply(
  connection: Connection | undefined,
  threadId: string,
  itemId: string,
): Promise<void> {
  if (!connection) return;
  try {
    await dispatch(connection, { type: 'thread.undoApply', threadId, itemId });
  } catch (failure) {
    notify.error(errorMessage(failure));
  }
}

const sections: readonly {
  readonly label: string;
  readonly testId: string;
  readonly pick: (file: ApplyFile) => boolean;
}[] = [
  {
    label: 'Left for you; the project folder keeps its own',
    testId: 'apply-left',
    pick: (file) => file.outcome === 'left',
  },
  { label: 'Merged with your changes', testId: 'apply-merge', pick: (f) => f.outcome === 'merge' },
  { label: 'Written', testId: 'apply-write', pick: (file) => file.outcome === 'write' },
  { label: 'Deleted', testId: 'apply-delete', pick: (file) => file.outcome === 'delete' },
];

// The confirm (spec 4): the files left for the user first, then what is merged, written and
// deleted. Enter confirms, Escape cancels.
export function ApplyDialog({ threadId }: { readonly threadId: string }) {
  const { connection } = useRuntime();
  const question = useStore(applyStore, (state) =>
    state.question?.threadId === threadId ? state.question : undefined,
  );
  const preview = question?.preview;
  const ok = preview?.status === 'ok';
  return (
    <AlertDialog open={question !== undefined} onOpenChange={(next) => !next && closeApply()}>
      <AlertDialogContent data-testid="apply-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>Apply to the project folder?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-3">
              {preview === undefined ? (
                <span>{question?.error ? '' : 'Reading the changes…'}</span>
              ) : preview.status !== 'ok' ? (
                <span data-testid="apply-refused" data-status={preview.status}>
                  {preview.message}
                </span>
              ) : (
                <>
                  <span>
                    {question?.changed ? 'The files changed since. ' : ''}
                    The thread's changes since <span className="font-mono">{preview.base}</span> are
                    written into{' '}
                    <span className="font-mono break-all">{preview.projectFolder}</span> as
                    uncommitted changes. Nothing is committed, staged or overwritten that you
                    changed yourself.
                  </span>
                  {sections.map((section) => {
                    const files = preview.files.filter(section.pick);
                    if (files.length === 0) return null;
                    return (
                      <section key={section.testId} data-testid={section.testId}>
                        <h3 className="text-xs font-medium text-foreground">{section.label}</h3>
                        <ul
                          aria-label={section.label}
                          className="flex max-h-40 flex-col gap-0.5 overflow-y-auto"
                        >
                          {files.map((file) => (
                            <li
                              key={file.path}
                              className="flex min-w-0 items-baseline gap-2 font-mono text-xs"
                            >
                              <span className="min-w-0 truncate">{file.path}</span>
                              {file.reason && (
                                <span className="shrink-0 font-sans text-muted-foreground">
                                  {applyLeftWords[file.reason]}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </section>
                    );
                  })}
                </>
              )}
              {question?.error && (
                <span role="alert" className="text-destructive">
                  {question.error}
                </span>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={question?.busy}>{ok ? 'Cancel' : 'Close'}</AlertDialogCancel>
          {ok && (
            <Button
              autoFocus
              disabled={question?.busy}
              onClick={() => void confirmApply(connection)}
            >
              Apply
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ChangesAppliedLine({
  payload,
  onUndo,
}: {
  readonly payload: ChangesAppliedItemPayload;
  readonly onUndo?: (() => void) | undefined;
}) {
  return (
    <div
      data-testid="changes-applied"
      className="flex flex-col gap-1 text-2xs text-muted-foreground"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="h-px flex-1 bg-border" />
        <span className="flex min-w-0 items-center gap-1.5">
          <FolderInputIcon aria-hidden className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{appliedLineText(payload)}</span>
        </span>
        {onUndo && (
          <Button size="xs" variant="ghost" onClick={onUndo}>
            <Undo2Icon />
            Undo
          </Button>
        )}
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>
      {(payload.left.length > 0 || payload.failed.length > 0) && (
        <ul aria-label="Not written" className="mx-auto flex flex-col gap-0.5">
          {payload.left.map((file) => (
            <li key={file.path}>
              <span className="font-mono">{file.path}</span>: {file.reason}
            </li>
          ))}
          {payload.failed.map((failure) => (
            <li key={failure.path} className="text-state-failed">
              <span className="font-mono">{failure.path}</span>: {failure.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
