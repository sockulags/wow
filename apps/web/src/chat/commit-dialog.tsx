import {
  CommitPlan,
  CommitRefusal,
  CommitResult,
  ProposeResult,
  type CommittedItemPayload,
} from '@wow/contracts';
import { RpcClientError, type Connection } from '@wow/client-runtime';
import { GitCommitHorizontalIcon, SparklesIcon } from 'lucide-react';
import { useId, type KeyboardEvent } from 'react';
import { createStore, useStore } from 'zustand';
import { useRuntime, useSetting } from '@/app/runtime';
import { FormField } from '@/components/form-field';
import { ShortcutHint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { isBinding } from '@/panel/editor';
import { fileStatusLabels, fileStatusLetters } from '@/workflows/changes';
import { errorMessage } from './data';
import { threadChangesStore } from './thread-changes';

// Commit from a chat thread's Changes (thread work spec 27 to 30): the files the folder has
// changed with the thread's own ticked, the branch, the hooks that will run, a message that
// "Propose" can fill, and Commit. Nothing is committed until Commit; the hooks run then.

export interface CommitQuestion {
  readonly threadId: string;
  // As last read; undefined while it is read.
  readonly plan: CommitPlan | undefined;
  readonly ticked: readonly string[];
  readonly message: string;
  readonly newBranch: string;
  readonly busy: boolean;
  // The proposal being written, by its request id.
  readonly proposing: string | undefined;
  readonly error: string | undefined;
  readonly refusal: CommitRefusal | undefined;
}

export const commitStore = createStore<{ readonly question: CommitQuestion | undefined }>(() => ({
  question: undefined,
}));

const patch = (threadId: string, changes: Partial<CommitQuestion>) =>
  commitStore.setState((state) =>
    state.question?.threadId === threadId ? { question: { ...state.question, ...changes } } : state,
  );

const newRequestId = () => `proposal-${crypto.randomUUID()}`;

// Opens the dialog and reads the plan at this moment (spec 27).
export async function askCommit(connection: Connection | undefined, threadId: string) {
  const before = commitStore.getState().question;
  commitStore.setState({
    question: {
      threadId,
      plan: undefined,
      ticked: [],
      message: before?.threadId === threadId ? before.message : '',
      newBranch: '',
      busy: true,
      proposing: undefined,
      error: undefined,
      refusal: undefined,
    },
  });
  if (!connection) {
    patch(threadId, { busy: false, error: 'The wow server is not connected.' });
    return;
  }
  try {
    const plan = CommitPlan.parse(await connection.request('threads.commitPlan', { threadId }));
    patch(threadId, {
      plan,
      busy: false,
      ticked: plan.files.filter((file) => file.inThread).map((file) => file.path),
    });
  } catch (failure) {
    patch(threadId, { busy: false, error: errorMessage(failure) });
  }
}

export function closeCommit(connection: Connection | undefined): void {
  const question = commitStore.getState().question;
  if (!question || question.busy) return;
  if (question.proposing) void cancelCommitProposal(connection);
  commitStore.setState({ question: undefined });
}

export function toggleCommitFile(path: string, on: boolean): void {
  const question = commitStore.getState().question;
  if (!question) return;
  const ticked = new Set(question.ticked);
  if (on) ticked.add(path);
  else ticked.delete(path);
  patch(question.threadId, { ticked: [...ticked] });
}

// "Propose" (spec 28): the thread's model writes a message for the ticked files, outside the
// conversation. The answer fills the field, which stays editable.
export async function proposeCommitMessage(connection: Connection | undefined): Promise<void> {
  const question = commitStore.getState().question;
  if (!question || !connection || question.proposing || question.ticked.length === 0) return;
  const requestId = newRequestId();
  const { threadId } = question;
  patch(threadId, { proposing: requestId, error: undefined });
  try {
    const answer = ProposeResult.parse(
      await connection.request('threads.propose', {
        threadId,
        requestId,
        purpose: 'commitMessage',
        files: [...question.ticked],
      }),
    );
    if (commitStore.getState().question?.proposing !== requestId) return;
    patch(threadId, {
      proposing: undefined,
      message: 'text' in answer ? answer.text : answer.title,
    });
  } catch (failure) {
    if (commitStore.getState().question?.proposing !== requestId) return;
    patch(threadId, { proposing: undefined, error: errorMessage(failure) });
  }
}

export async function cancelCommitProposal(connection: Connection | undefined): Promise<void> {
  const question = commitStore.getState().question;
  const requestId = question?.proposing;
  if (!question || requestId === undefined) return;
  patch(question.threadId, { proposing: undefined });
  await connection?.request('threads.cancelProposal', { requestId }).catch(() => undefined);
}

// Commit (spec 29): a refusal shows git's and the hooks' output and leaves the dialog open.
export async function confirmCommit(connection: Connection | undefined): Promise<void> {
  const question = commitStore.getState().question;
  if (!question?.plan || !connection || question.busy || question.proposing) return;
  const { threadId } = question;
  patch(threadId, { busy: true, error: undefined, refusal: undefined });
  try {
    CommitResult.parse(
      await connection.request('threads.commit', {
        threadId,
        files: [...question.ticked],
        message: question.message,
        ...(question.plan.branch === null && question.newBranch.trim() !== ''
          ? { newBranch: question.newBranch.trim() }
          : {}),
      }),
    );
    commitStore.setState((state) =>
      state.question?.threadId === threadId ? { question: undefined } : state,
    );
    threadChangesStore.setState((state) => ({ refresh: state.refresh + 1 }));
  } catch (failure) {
    const refusal =
      failure instanceof RpcClientError ? CommitRefusal.safeParse(failure.data).data : undefined;
    patch(threadId, {
      busy: false,
      ...(refusal ? { refusal } : { error: errorMessage(failure) }),
    });
  }
}

// Why Commit cannot go now, in words; undefined when it can.
export function commitBlocked(question: CommitQuestion): string | undefined {
  const { plan } = question;
  if (!plan) return 'Reading the folder…';
  if (plan.status !== 'ok') return plan.message ?? 'The folder cannot commit now.';
  if (question.ticked.length === 0) return 'Tick at least one file.';
  if (question.message.trim() === '') return 'Write a message.';
  if (plan.branch === null && question.newBranch.trim() === '') {
    return 'The folder is on no branch: name a new one.';
  }
  return undefined;
}

const lineCounts = (file: { readonly added: number | null; readonly removed: number | null }) =>
  file.added === null && file.removed === null ? '' : `+${file.added ?? 0} −${file.removed ?? 0}`;

export function CommitDialog({ threadId }: { readonly threadId: string }) {
  const { connection } = useRuntime();
  const confirmBinding = useSetting('keybindings.commitConfirm');
  const question = useStore(commitStore, (state) =>
    state.question?.threadId === threadId ? state.question : undefined,
  );
  const messageId = useId();
  const branchId = useId();
  const plan = question?.plan;
  const blocked = question ? commitBlocked(question) : undefined;
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isBinding(event, confirmBinding)) return;
    event.preventDefault();
    event.stopPropagation();
    void confirmCommit(connection);
  };
  return (
    <Dialog open={question !== undefined} onOpenChange={(next) => !next && closeCommit(connection)}>
      <DialogContent data-testid="commit-dialog" className="sm:max-w-xl" onKeyDown={onKeyDown}>
        <DialogHeader>
          <DialogTitle>Commit</DialogTitle>
          <DialogDescription data-testid="commit-branch">
            {!plan
              ? 'Reading the folder…'
              : plan.branch === null
                ? 'The folder is on no branch. The commit goes on a new branch made here.'
                : `On ${plan.branch}${plan.head ? ` at ${plan.head}` : ''}`}
          </DialogDescription>
        </DialogHeader>
        {plan && question && (
          <div className="flex min-h-0 flex-col gap-3">
            {plan.status !== 'ok' && (
              <p role="status" data-testid="commit-refused" className="text-xs text-destructive">
                {plan.message}
              </p>
            )}
            <p data-testid="commit-hooks" className="text-xs text-muted-foreground">
              {plan.hooks.length === 0
                ? 'No commit hooks'
                : `Runs the repository's commit hooks: ${plan.hooks.join(', ')}`}
            </p>
            {plan.files.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing in the folder to commit.</p>
            ) : (
              <ul
                aria-label="Files to commit"
                className="flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded-md border border-border p-1"
              >
                {plan.files.map((file) => {
                  const ticked = question.ticked.includes(file.path);
                  return (
                    <li key={file.path} className="flex items-center gap-2 px-1 text-xs">
                      <Checkbox
                        aria-label={file.path}
                        checked={ticked}
                        onCheckedChange={(checked) => toggleCommitFile(file.path, checked === true)}
                      />
                      <span
                        aria-label={fileStatusLabels[file.status]}
                        className="w-3 shrink-0 font-mono text-muted-foreground"
                      >
                        {fileStatusLetters[file.status]}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                      {!file.inThread && (
                        <span className="shrink-0 text-2xs text-muted-foreground">
                          not from this thread
                        </span>
                      )}
                      {file.staged && (
                        <span className="shrink-0 text-2xs text-muted-foreground">staged</span>
                      )}
                      <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                        {lineCounts(file)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {plan.omitted > 0 && (
              <p className="text-2xs text-muted-foreground">
                {plan.omitted} more files are not listed.
              </p>
            )}
            {plan.branch === null && (
              <FormField id={branchId} label="New branch">
                <Input
                  className="font-mono"
                  value={question.newBranch}
                  onChange={(event) => patch(threadId, { newBranch: event.target.value })}
                />
              </FormField>
            )}
            <FormField
              id={messageId}
              label="Message"
              labelAction={
                question.proposing ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label="Cancel the proposal"
                    onClick={() => void cancelCommitProposal(connection)}
                  >
                    Cancel
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={question.ticked.length === 0}
                    onClick={() => void proposeCommitMessage(connection)}
                  >
                    <SparklesIcon />
                    Propose
                  </Button>
                )
              }
            >
              <Textarea
                autoFocus
                rows={4}
                readOnly={question.proposing !== undefined}
                value={question.proposing ? 'Writing a message…' : question.message}
                onChange={(event) => patch(threadId, { message: event.target.value })}
              />
            </FormField>
            {question.refusal && (
              <div role="alert" data-testid="commit-refusal" className="flex flex-col gap-1">
                <p className="text-xs text-destructive">{question.refusal.reason}</p>
                {question.refusal.output.trim() !== '' && (
                  <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-2xs whitespace-pre-wrap">
                    {question.refusal.output}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
        {question?.error && (
          <p role="alert" className="text-xs text-destructive">
            {question.error}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={question?.busy}
            onClick={() => closeCommit(connection)}
          >
            Cancel
          </Button>
          <Button
            disabled={blocked !== undefined || question?.busy || question?.proposing !== undefined}
            title={blocked}
            onClick={() => void confirmCommit(connection)}
          >
            <GitCommitHorizontalIcon />
            {question?.busy && plan ? 'Committing…' : 'Commit'}
            <ShortcutHint shortcut="keybindings.commitConfirm" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// "Committed 3 files · 4e1d2a0 Ring the bell twice" (spec 29).
export function committedLineText(payload: CommittedItemPayload): string {
  const count = payload.files.length;
  return `Committed ${count} ${count === 1 ? 'file' : 'files'} · ${payload.sha.slice(0, 7)} ${payload.subject}`;
}

export function CommittedLine({ payload }: { readonly payload: CommittedItemPayload }) {
  return (
    <div
      data-testid="committed-line"
      className="flex items-center gap-2 text-2xs text-muted-foreground"
    >
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="flex min-w-0 items-center gap-1.5">
        <GitCommitHorizontalIcon aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{committedLineText(payload)}</span>
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}
