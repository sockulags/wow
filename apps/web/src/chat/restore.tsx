import {
  RestorePreview,
  type FilesRestoredItemPayload,
  confirmedOf,
  type RestoreConfirmed,
} from '@wow/contracts';
import { RpcClientError, dispatch, type Connection } from '@wow/client-runtime';
import { HistoryIcon, Undo2Icon } from 'lucide-react';
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
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { errorMessage } from './data';
import { threadChangesStore } from './thread-changes';

// Restore files when going back (thread work spec 20 to 24): the confirm that lists what a
// restore does, read from the server when it opens, the line a restore leaves in the
// conversation, and Edit's choice of what goes back.

export type RestoreTarget =
  // "Restore files to here" on a message: back to the start of its turn.
  | { readonly kind: 'restore'; readonly turnId: string }
  // Undo on a restore line: back to the files just before it.
  | { readonly kind: 'undo'; readonly itemId: string }
  // Edit's "Conversation and files": the new message goes once the user says yes.
  | {
      readonly kind: 'edit';
      readonly turnId: string;
      send(confirmed: RestoreConfirmed): Promise<unknown>;
      cancelled(): void;
    };

export interface RestoreQuestion {
  readonly threadId: string;
  readonly target: RestoreTarget;
  // What the restore would do, as last read; undefined while it is read.
  readonly preview: RestorePreview | undefined;
  // The server found other files than the confirm showed and the confirm asks again.
  readonly changed: boolean;
  readonly busy: boolean;
  readonly error: string | undefined;
}

export const restoreStore = createStore<{ readonly question: RestoreQuestion | undefined }>(() => ({
  question: undefined,
}));

const patch = (changes: Partial<RestoreQuestion>) =>
  restoreStore.setState((state) =>
    state.question ? { question: { ...state.question, ...changes } } : state,
  );

const previewParams = (threadId: string, target: RestoreTarget) =>
  target.kind === 'undo'
    ? { threadId, undoItemId: target.itemId }
    : { threadId, turnId: target.turnId };

// Opens the confirm and reads what the restore would do at this moment (spec 22, 23).
export async function askRestore(
  connection: Connection | undefined,
  threadId: string,
  target: RestoreTarget,
): Promise<void> {
  const before = restoreStore.getState().question;
  if (before?.target.kind === 'edit' && before.target !== target) before.target.cancelled();
  restoreStore.setState({
    question: {
      threadId,
      target,
      preview: undefined,
      changed: false,
      busy: true,
      error: undefined,
    },
  });
  if (!connection) {
    patch({ busy: false, error: 'The wow server is not connected.' });
    return;
  }
  try {
    const preview = RestorePreview.parse(
      await connection.request('threads.restorePreview', previewParams(threadId, target)),
    );
    if (restoreStore.getState().question?.target === target) patch({ preview, busy: false });
  } catch (failure) {
    if (restoreStore.getState().question?.target === target) {
      patch({ busy: false, error: errorMessage(failure) });
    }
  }
}

export function closeRestore(): void {
  const { question } = restoreStore.getState();
  if (!question || question.busy) return;
  if (question.target.kind === 'edit') question.target.cancelled();
  restoreStore.setState({ question: undefined });
}

// Restores after the user's yes. When the folder holds other files than were shown, the server
// refuses with what it finds now and the confirm asks again with that.
export async function confirmRestore(connection: Connection | undefined): Promise<void> {
  const question = restoreStore.getState().question;
  if (!question?.preview || question.preview.status !== 'ok' || question.busy || !connection) {
    return;
  }
  const { threadId, target, preview } = question;
  const confirmed = confirmedOf(preview);
  patch({ busy: true, error: undefined });
  try {
    if (target.kind === 'edit') await target.send(confirmed);
    else if (target.kind === 'restore') {
      await dispatch(connection, {
        type: 'thread.restoreFiles',
        threadId,
        turnId: target.turnId,
        confirmed,
      });
    } else {
      await dispatch(connection, {
        type: 'thread.undoRestore',
        threadId,
        itemId: target.itemId,
        confirmed,
      });
    }
    restoreStore.setState((state) =>
      state.question?.target === target ? { question: undefined } : state,
    );
    // The Changes view and chip read the folder again (spec 25).
    threadChangesStore.setState((state) => ({ refresh: state.refresh + 1 }));
  } catch (failure) {
    const now =
      failure instanceof RpcClientError && failure.code === 'conflict'
        ? RestorePreview.safeParse(failure.data).data
        : undefined;
    if (now) patch({ busy: false, preview: now, changed: true });
    else patch({ busy: false, error: errorMessage(failure) });
  }
}

function PathList({
  label,
  paths,
  testId,
}: {
  label: string;
  paths: readonly { readonly path: string; readonly note?: string }[];
  testId: string;
}) {
  if (paths.length === 0) return null;
  return (
    <section data-testid={testId} className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-foreground">{label}</h3>
      <ul aria-label={label} className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
        {paths.map(({ path, note }) => (
          <li key={path} className="flex min-w-0 items-baseline gap-2 font-mono text-xs">
            <span className="min-w-0 truncate">{path}</span>
            {note && <span className="shrink-0 font-sans text-muted-foreground">{note}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} bytes`;

// The confirm (spec 22, 23): files changed outside the thread first, the files that cannot come
// back, then what is written back and what is deleted. Enter confirms, Escape cancels.
export function RestoreDialog({ threadId }: { readonly threadId: string }) {
  const { connection } = useRuntime();
  const question = useStore(restoreStore, (state) =>
    state.question?.threadId === threadId ? state.question : undefined,
  );
  const preview = question?.preview;
  const ok = preview?.status === 'ok';
  const outside = new Set(preview?.outside ?? []);
  const nothing =
    ok &&
    preview.write.length === 0 &&
    preview.remove.length === 0 &&
    preview.notRestorable.length === 0;
  const title =
    question?.target.kind === 'undo'
      ? 'Undo the restore?'
      : question?.target.kind === 'edit'
        ? 'Put the files back and send?'
        : 'Restore files to here?';
  const action =
    outside.size > 0
      ? 'Restore anyway'
      : question?.target.kind === 'edit'
        ? 'Restore and send'
        : question?.target.kind === 'undo'
          ? 'Undo'
          : 'Restore';
  return (
    <AlertDialog open={question !== undefined} onOpenChange={(next) => !next && closeRestore()}>
      <AlertDialogContent data-testid="restore-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-3">
              {preview === undefined ? (
                <span>{question?.error ? '' : 'Reading the files…'}</span>
              ) : !ok ? (
                <span data-testid="restore-refused" data-status={preview.status}>
                  {preview.message}
                </span>
              ) : (
                <>
                  <span>
                    {question?.changed ? 'The files changed since. ' : ''}
                    {nothing
                      ? 'The files are already as they were then.'
                      : "The thread's folder goes back to how it was. The conversation, commits and ignored files stay as they are."}
                  </span>
                  <PathList
                    testId="restore-outside"
                    label="Changed outside this thread since its last turn"
                    paths={preview.outside.map((path) => ({ path }))}
                  />
                  <PathList
                    testId="restore-not-restorable"
                    label="Too large to put back; they stay as they are"
                    paths={preview.notRestorable.map(({ path, size }) => ({
                      path,
                      note: formatSize(size),
                    }))}
                  />
                  <PathList
                    testId="restore-write"
                    label="Written back"
                    paths={preview.write.map((path) => ({ path }))}
                  />
                  <PathList
                    testId="restore-remove"
                    label="Deleted"
                    paths={preview.remove.map((path) => ({ path }))}
                  />
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
              variant={outside.size > 0 ? 'destructive' : 'default'}
              disabled={question?.busy}
              onClick={() => void confirmRestore(connection)}
            >
              {action}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// "Files restored to before "Make the bell ring twice" · 4 written, 1 deleted" (spec 24).
export function restoreLineText(payload: FilesRestoredItemPayload, messageText: string): string {
  const shown = messageText.trim().split('\n')[0] ?? '';
  const quoted = shown.length > 60 ? `${shown.slice(0, 59)}…` : shown;
  const head =
    payload.undoOf !== undefined
      ? 'Restore undone'
      : quoted === ''
        ? 'Files restored to before a message'
        : `Files restored to before “${quoted}”`;
  return [
    head,
    `${payload.written.length} written`,
    `${payload.removed.length} deleted`,
    ...(payload.failed.length > 0 ? [`${payload.failed.length} could not be changed`] : []),
  ].join(' · ');
}

export function FilesRestoredLine({
  payload,
  messageText,
  onUndo,
}: {
  readonly payload: FilesRestoredItemPayload;
  readonly messageText: string;
  readonly onUndo?: (() => void) | undefined;
}) {
  return (
    <div
      data-testid="files-restored"
      className="flex flex-col gap-1 text-2xs text-muted-foreground"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="h-px flex-1 bg-border" />
        <span className="flex min-w-0 items-center gap-1.5">
          <HistoryIcon aria-hidden className="size-3 shrink-0" />
          {restoreLineText(payload, messageText)}
        </span>
        {onUndo && (
          <Button size="xs" variant="ghost" onClick={onUndo}>
            <Undo2Icon />
            Undo
          </Button>
        )}
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>
      {payload.failed.length > 0 && (
        <ul aria-label="Not changed" className="mx-auto flex flex-col gap-0.5">
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

// Edit's choice (spec 21): "Conversation only" as before, or "Conversation and files", which
// puts the files back to the start of the replaced turn before the new message goes.
export function EditFilesChoice({
  withFiles,
  onChange,
}: {
  readonly withFiles: boolean;
  onChange(withFiles: boolean): void;
}) {
  return (
    <RadioGroup
      data-testid="edit-files-choice"
      aria-label="What goes back"
      value={withFiles ? 'files' : 'conversation'}
      onValueChange={(value) => onChange(value === 'files')}
      className="flex flex-wrap gap-3"
    >
      <div className="flex items-center gap-1.5">
        <RadioGroupItem value="conversation" id="edit-conversation-only" />
        <Label htmlFor="edit-conversation-only" className="text-xs font-normal">
          Conversation only
        </Label>
      </div>
      <div className="flex items-center gap-1.5">
        <RadioGroupItem value="files" id="edit-conversation-files" />
        <Label htmlFor="edit-conversation-files" className="text-xs font-normal">
          Conversation and files
        </Label>
      </div>
    </RadioGroup>
  );
}
