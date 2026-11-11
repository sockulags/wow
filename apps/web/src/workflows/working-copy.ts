import { isLiveRunState, type UnpushedWork, type WorkflowRun } from '@wow/contracts';
import { createStore } from 'zustand';
import { errorMessage } from '@/chat/data';

// A run's own working copy in the run view (review loop spec 36 to 38). Which run's "Remove
// working copy" question is open is view state like an open dialog: it lives here so the
// button, the palette command and the dialog act on the same question. What the working copy is
// comes from the run row alone.
export interface RemoveQuestion {
  readonly runId: string;
  readonly busy: boolean;
  readonly error: string | undefined;
}

export const workingCopyStore = createStore<{ readonly removing: RemoveQuestion | undefined }>(
  () => ({ removing: undefined }),
);

// Only a kept working copy of a run that has ended is the user's to remove; a live run still
// works in its copy, and the server removes a copy nothing would be lost with by itself.
export const canRemoveWorkingCopy = (run: WorkflowRun): boolean =>
  run.workingCopy?.state === 'kept' && !isLiveRunState(run.state);

export const askRemoveWorkingCopy = (runId: string): void =>
  workingCopyStore.setState({ removing: { runId, busy: false, error: undefined } });

// Closing the dialog. Once confirmed the removal goes on, and its outcome stays to be read.
export const cancelRemoveWorkingCopy = (): void =>
  workingCopyStore.setState((state) =>
    state.removing?.busy || state.removing?.error !== undefined ? state : { removing: undefined },
  );

// Whether the question is on screen: asked, and not answered yet.
export const askingToRemove = (question: RemoveQuestion | undefined): boolean =>
  question !== undefined && !question.busy && question.error === undefined;

// Removes it after the user confirmed. The question closes when the server has done it and
// stays open with the reason when it could not.
export async function confirmRemoveWorkingCopy(
  remove: (runId: string) => Promise<unknown>,
): Promise<void> {
  const question = workingCopyStore.getState().removing;
  if (!question || question.busy) return;
  const { runId } = question;
  const patch = (changes: Partial<RemoveQuestion>) =>
    workingCopyStore.setState((state) =>
      state.removing?.runId === runId ? { removing: { ...state.removing, ...changes } } : state,
    );
  patch({ busy: true, error: undefined });
  try {
    await remove(runId);
    workingCopyStore.setState((state) =>
      state.removing?.runId === runId ? { removing: undefined } : state,
    );
  } catch (failure) {
    patch({ busy: false, error: errorMessage(failure) });
  }
}

const count = (amount: number, one: string, many: string) =>
  `${amount} ${amount === 1 ? one : many}`;

// "2 files not committed, 1 commit not pushed (on agent/u2-bell)".
export function unpushedSummary(unpushed: UnpushedWork): string {
  const parts = [
    ...(unpushed.uncommittedFiles > 0
      ? [`${count(unpushed.uncommittedFiles, 'file', 'files')} not committed`]
      : []),
    ...(unpushed.unpushedCommits > 0
      ? [`${count(unpushed.unpushedCommits, 'commit', 'commits')} not pushed`]
      : []),
  ];
  const where = unpushed.branch === null ? 'on no branch' : `on ${unpushed.branch}`;
  return `${parts.join(', ')} (${where})`;
}

// One sentence on where the run's working copy stands, for the run view and the palette.
export function workingCopyStatus(run: Pick<WorkflowRun, 'workingCopy'>): string | undefined {
  const copy = run.workingCopy;
  if (!copy) return undefined;
  switch (copy.state) {
    case 'pending':
      return 'Making the working copy…';
    case 'ready':
      return 'Works in its own working copy';
    case 'failed':
      return 'No working copy was made';
    case 'removed':
      return 'Working copy removed';
    case 'kept':
      return copy.unpushed
        ? `Working copy kept: ${unpushedSummary(copy.unpushed)}`
        : 'Working copy kept';
  }
}
