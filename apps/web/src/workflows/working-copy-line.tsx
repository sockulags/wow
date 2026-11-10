import type { WorkflowRun } from '@wow/contracts';
import { Trash2Icon } from 'lucide-react';
import { useStore } from 'zustand';
import { useRuntime } from '@/app/runtime';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PathText } from '@/components/path-text';
import { Button } from '@/components/ui/button';
import {
  askRemoveWorkingCopy,
  askingToRemove,
  cancelRemoveWorkingCopy,
  canRemoveWorkingCopy,
  confirmRemoveWorkingCopy,
  workingCopyStatus,
  workingCopyStore,
} from './working-copy';

// Where the run's own working copy stands, in the run view's header: its folder while it is
// there, the note when it did not start at the fetched tip, and for a kept one what it holds
// with "Remove working copy", which asks first (review loop spec 37).
export function WorkingCopyLine({ run }: { readonly run: WorkflowRun }) {
  const { connection } = useRuntime();
  const question = useStore(workingCopyStore, (state) =>
    state.removing?.runId === run.id ? state.removing : undefined,
  );
  const copy = run.workingCopy;
  const status = workingCopyStatus(run);
  if (!copy || status === undefined) return null;
  const onDisk = copy.state === 'ready' || copy.state === 'kept';
  const removable = canRemoveWorkingCopy(run);
  const problem = question?.error ?? (copy.state === 'kept' ? copy.error : null);
  return (
    <div
      role="group"
      aria-label="Working copy"
      data-testid="working-copy"
      data-state={copy.state}
      className="flex flex-col gap-1 text-xs text-muted-foreground"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span data-testid="working-copy-status" className={removable ? 'text-foreground' : ''}>
          {status}
        </span>
        {onDisk && <PathText path={copy.path} copy className="min-w-0" />}
        {removable && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!connection || question?.busy}
            onClick={() => askRemoveWorkingCopy(run.id)}
          >
            <Trash2Icon />
            Remove working copy
          </Button>
        )}
      </div>
      {copy.note && onDisk && <p data-testid="working-copy-note">{copy.note}</p>}
      {copy.state === 'kept' && copy.unpushed?.newestSubject && (
        <p>Newest commit not pushed: {copy.unpushed.newestSubject}</p>
      )}
      {problem && (
        <p role="alert" className="text-destructive">
          {problem}
        </p>
      )}
      <ConfirmDialog
        open={askingToRemove(question) && removable}
        title="Remove this working copy?"
        description={
          <>
            <span className="font-mono break-all">{copy.path}</span> is deleted with everything in
            it that is not committed or not pushed. This cannot be undone.
          </>
        }
        confirmLabel="Remove"
        onCancel={cancelRemoveWorkingCopy}
        onConfirm={() => {
          if (!connection) return;
          void confirmRemoveWorkingCopy((runId) =>
            connection.request('workflowRuns.removeWorkingCopy', { runId }),
          );
        }}
      />
    </div>
  );
}
