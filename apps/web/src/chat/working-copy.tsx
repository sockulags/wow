import {
  branchName,
  UnpushedWork,
  WorkingCopyPlan,
  type Thread,
  type WorkingCopy,
} from '@wow/contracts';
import { RpcClientError, type Connection } from '@wow/client-runtime';
import { GitBranchIcon, SquarePenIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createStore, useStore } from 'zustand';
import { useRuntime } from '@/app/runtime';
import type { AppCommand } from '@/app/commands';
import { WithTooltip } from '@/components/hint';
import { PathText } from '@/components/path-text';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { copyText } from '@/components/copy-button';
import { FactList, PanelSection } from '@/panel/details';
import { openInEditor } from '@/panel/editor';
import { errorMessage } from './data';

// A chat thread's own working copy (thread work spec 10 to 17): the draft's switch and line, the
// header chip, the Details section and "Remove working copy". What the copy is comes from the
// thread row alone; which removal question is open is view state, like an open dialog, so the
// button, the palette command and the dialog act on the same question.

const count = (amount: number, one: string, many: string) =>
  `${amount} ${amount === 1 ? one : many}`;

const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '');

// "2 uncommitted files, 1 ignored file, 1 commit on no branch", or undefined when nothing would
// be lost: commits made on no branch go with the folder, the thread's branch keeps the others.
export function filesHeld(holds: UnpushedWork): string | undefined {
  const parts = [
    holds.uncommittedFiles > 0 &&
      count(holds.uncommittedFiles, 'uncommitted file', 'uncommitted files'),
    (holds.ignoredFiles ?? 0) > 0 &&
      count(holds.ignoredFiles ?? 0, 'ignored file', 'ignored files'),
    (holds.commitsOnNoBranch ?? 0) > 0 &&
      `${count(holds.commitsOnNoBranch ?? 0, 'commit', 'commits')} on no branch`,
  ].filter((part): part is string => typeof part === 'string');
  return parts.length === 0 ? undefined : parts.join(', ');
}

// "2 uncommitted files, 1 ignored file · 3 commits on wow/ring-twice-3fa2c1" (spec 14).
export function holdsSummary(holds: UnpushedWork, branch: string | null): string {
  const files = filesHeld(holds);
  const onBranches = holds.unpushedCommits - (holds.commitsOnNoBranch ?? 0);
  const commits =
    onBranches > 0
      ? `${count(onBranches, 'commit', 'commits')} on ${branch ?? holds.branch ?? 'no branch'}`
      : undefined;
  return [files, commits].filter((part) => part !== undefined).join(' · ') || 'Nothing to lose';
}

// Where the copy stands, in words for the chip and Details.
export function copyStateText(copy: WorkingCopy): string {
  switch (copy.state) {
    case 'pending':
      return 'Own working copy, made with the first message';
    case 'ready':
      return 'Own working copy';
    case 'failed':
      return 'No working copy could be made';
    case 'removed':
      return 'Working copy removed; made again on its branch with the next message';
    case 'kept':
      return copy.unpushed
        ? `Kept: ${holdsSummary(copy.unpushed, copy.branch ?? null)}`
        : 'Working copy kept';
  }
}

const onDisk = (copy: WorkingCopy) => copy.state === 'ready' || copy.state === 'kept';

// The header chip: the branch and "own working copy", or what a kept copy holds.
export function WorkingCopyChip({ thread }: { readonly thread: Thread }) {
  const copy = thread.workingCopy;
  if (!copy) return null;
  const branch = copy.branch ?? thread.branch ?? '';
  const words =
    copy.state === 'kept' && copy.unpushed
      ? holdsSummary(copy.unpushed, branch)
      : copy.state === 'removed'
        ? 'working copy removed'
        : copy.state === 'failed'
          ? 'no working copy'
          : 'own working copy';
  return (
    <WithTooltip label={<span className="font-mono">{copy.path}</span>}>
      <Badge
        variant="outline"
        tabIndex={0}
        data-testid="working-copy-chip"
        data-state={copy.state}
        className="min-w-0 max-w-96 text-muted-foreground"
      >
        <GitBranchIcon aria-hidden />
        <span className="truncate font-mono">{branch}</span>
        <span aria-hidden>·</span>
        <span className="truncate">{words}</span>
      </Badge>
    </WithTooltip>
  );
}

// The question "Remove working copy" asks, read from the server when it opens.
export interface RemoveQuestion {
  readonly threadId: string;
  // What the copy holds, as last read; undefined while it is read.
  readonly holds: UnpushedWork | undefined;
  // The server found more than the dialog showed and the dialog asks again.
  readonly changed: boolean;
  readonly busy: boolean;
  readonly error: string | undefined;
}

export const threadCopyStore = createStore<{ readonly removing: RemoveQuestion | undefined }>(
  () => ({ removing: undefined }),
);

const patchQuestion = (threadId: string, changes: Partial<RemoveQuestion>) =>
  threadCopyStore.setState((state) =>
    state.removing?.threadId === threadId ? { removing: { ...state.removing, ...changes } } : state,
  );

// A copy on disk is the user's to remove while no turn of the thread runs.
export const canRemoveThreadCopy = (thread: Thread): boolean =>
  thread.workingCopy !== null &&
  thread.workingCopy !== undefined &&
  onDisk(thread.workingCopy) &&
  thread.state !== 'working';

// Opens the question and reads what would be lost at this moment (spec 15).
export async function askRemoveThreadCopy(
  connection: Connection | undefined,
  threadId: string,
): Promise<void> {
  threadCopyStore.setState({
    removing: { threadId, holds: undefined, changed: false, busy: true, error: undefined },
  });
  if (!connection) {
    patchQuestion(threadId, { busy: false, error: 'The wow server is not connected.' });
    return;
  }
  try {
    const holds = UnpushedWork.parse(
      await connection.request('threads.workingCopyStatus', { threadId }),
    );
    patchQuestion(threadId, { holds, busy: false });
  } catch (failure) {
    patchQuestion(threadId, { busy: false, error: errorMessage(failure) });
  }
}

export const closeRemoveThreadCopy = (): void =>
  threadCopyStore.setState((state) => (state.removing?.busy ? state : { removing: undefined }));

// Removes after the user's yes. When the copy holds more than was shown, the server refuses
// with the new counts and the dialog asks again with them.
export async function confirmRemoveThreadCopy(connection: Connection | undefined): Promise<void> {
  const question = threadCopyStore.getState().removing;
  if (!question?.holds || question.busy || !connection) return;
  const { threadId, holds } = question;
  patchQuestion(threadId, { busy: true, error: undefined });
  try {
    await connection.request('threads.removeWorkingCopy', { threadId, expect: holds });
    threadCopyStore.setState((state) =>
      state.removing?.threadId === threadId ? { removing: undefined } : state,
    );
  } catch (failure) {
    const now =
      failure instanceof RpcClientError && failure.code === 'conflict'
        ? UnpushedWork.safeParse(failure.data).data
        : undefined;
    if (now) patchQuestion(threadId, { busy: false, holds: now, changed: true });
    else patchQuestion(threadId, { busy: false, error: errorMessage(failure) });
  }
}

export function RemoveThreadCopyDialog({ thread }: { readonly thread: Thread }) {
  const { connection } = useRuntime();
  const question = useStore(threadCopyStore, (state) =>
    state.removing?.threadId === thread.id ? state.removing : undefined,
  );
  const copy = thread.workingCopy;
  if (!copy) return null;
  const holds = question?.holds;
  const lost = holds ? filesHeld(holds) : undefined;
  const branch = copy.branch ?? thread.branch;
  // The folder may have been switched to another branch; commits there stay there.
  const kept =
    holds?.branch && holds.branch !== branch ? (
      'Commits on branches stay.'
    ) : (
      <>
        Commits stay on <span className="font-mono">{branch}</span>.
      </>
    );
  return (
    <AlertDialog
      open={question !== undefined}
      onOpenChange={(next) => !next && closeRemoveThreadCopy()}
    >
      <AlertDialogContent data-testid="remove-working-copy">
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this working copy?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              <span className="font-mono text-xs break-all">{copy.path}</span>
              {holds === undefined ? (
                <span>{question?.error ? '' : 'Reading what is in it…'}</span>
              ) : lost ? (
                <span data-testid="working-copy-loses">
                  {question?.changed ? 'It holds more now: ' : 'It holds '}
                  {lost}. They are lost with the folder. {kept}
                </span>
              ) : (
                <span data-testid="working-copy-loses">Nothing in it would be lost. {kept}</span>
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
          <AlertDialogCancel disabled={question?.busy}>Cancel</AlertDialogCancel>
          <Button
            variant={lost ? 'destructive' : 'default'}
            disabled={holds === undefined || question?.busy}
            onClick={() => void confirmRemoveThreadCopy(connection)}
          >
            {lost ? 'Remove and lose them' : 'Remove'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Details: the branch, the folder with Copy path and Open in editor, where it started and why
// when that is not what the setting asked for, what it holds, and Remove (spec 13 to 15).
export function WorkingCopyDetails({ thread }: { readonly thread: Thread }) {
  const { connection } = useRuntime();
  const copy = thread.workingCopy;
  if (!copy) return null;
  const branch = copy.branch ?? thread.branch;
  const started =
    copy.startSha === null
      ? undefined
      : copy.defaultBranch
        ? `${copy.defaultBranch} (${shortSha(copy.startSha)})`
        : shortSha(copy.startSha);
  return (
    <PanelSection label="Working copy">
      <div
        data-testid="working-copy-details"
        data-state={copy.state}
        className="flex flex-col gap-1.5"
      >
        <FactList
          facts={[
            branch !== null &&
              branch !== undefined && {
                label: 'Branch',
                value: <span className="font-mono text-xs">{branch}</span>,
              },
            {
              label: 'Folder',
              value: (
                <span className="flex min-w-0 items-center gap-1">
                  <PathText path={copy.path} copy className="min-w-0" />
                  {onDisk(copy) && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Open in editor"
                      className="text-muted-foreground"
                      onClick={() =>
                        void openInEditor(connection, { scope: { threadId: thread.id }, path: '.' })
                      }
                    >
                      <SquarePenIcon />
                    </Button>
                  )}
                </span>
              ),
            },
            started !== undefined && { label: 'Started from', value: started },
            {
              label: 'State',
              value: <span data-testid="working-copy-state">{copyStateText(copy)}</span>,
            },
          ]}
        />
        {copy.note && (
          <p data-testid="working-copy-note" className="text-xs text-muted-foreground">
            {copy.note}
          </p>
        )}
        {copy.error && (
          <p role="alert" className="text-xs text-destructive">
            {copy.error}
          </p>
        )}
        {canRemoveThreadCopy(thread) && (
          <div>
            <Button
              size="xs"
              variant="outline"
              disabled={!connection}
              onClick={() => void askRemoveThreadCopy(connection, thread.id)}
            >
              <Trash2Icon />
              Remove working copy
            </Button>
          </div>
        )}
      </div>
    </PanelSection>
  );
}

// The draft's plan for the chosen project (spec 10), asked again when the project changes.
export function useWorkingCopyPlan(projectId: string | undefined): WorkingCopyPlan | undefined {
  const { connection } = useRuntime();
  const [answer, setAnswer] = useState<{ readonly for: string; readonly plan: WorkingCopyPlan }>();
  useEffect(() => {
    if (!connection || projectId === undefined) return undefined;
    let current = true;
    connection.request('threads.workingCopyPlan', { projectId }).then(
      (result) => {
        const plan = WorkingCopyPlan.safeParse(result).data;
        if (current && plan) setAnswer({ for: projectId, plan });
      },
      (failure: unknown) =>
        current &&
        setAnswer({
          for: projectId,
          plan: { status: 'unavailable', reason: errorMessage(failure) },
        }),
    );
    return () => {
      current = false;
    };
  }, [connection, projectId]);
  return answer && answer.for === projectId ? answer.plan : undefined;
}

// "New branch wow/ring-twice-3fa2c1 from main (4e1d2a0). Uncommitted changes in the project
// folder stay there."
export function draftCopyLine(
  plan: Extract<WorkingCopyPlan, { status: 'ok' }>,
  title: string,
  threadId: string,
): string {
  const branch = branchName(plan.template, title, threadId);
  const from = plan.from ? `${plan.from} (${shortSha(plan.sha)})` : shortSha(plan.sha);
  const fetched = plan.start === 'defaultBranch' && plan.fetch ? ', fetched first' : '';
  return `New branch ${branch} from ${from}${fetched}. Uncommitted changes in the project folder stay there.`;
}

// Whether the draft's switch is on: the user's pick, else the project's setting.
export const draftCopyOn = (
  plan: WorkingCopyPlan | undefined,
  picked: boolean | undefined,
): boolean => plan?.status === 'ok' && (picked ?? plan.on);

// The new thread's switch and the line under it. Shown only for a project in Git.
export function DraftWorkingCopy({
  plan,
  on,
  title,
  threadId,
  onChange,
}: {
  readonly plan: WorkingCopyPlan | undefined;
  readonly on: boolean;
  readonly title: string;
  readonly threadId: string;
  readonly onChange: (on: boolean) => void;
}) {
  if (plan?.status !== 'ok') return null;
  return (
    <div data-testid="draft-working-copy" className="flex flex-col gap-1">
      <div className="flex h-7 items-center gap-2">
        <Switch id="draft-own-copy" checked={on} onCheckedChange={onChange} />
        <Label htmlFor="draft-own-copy" className="text-xs font-normal">
          Own working copy
        </Label>
      </div>
      {on && (
        <p data-testid="draft-working-copy-line" className="text-xs text-muted-foreground">
          {draftCopyLine(plan, title, threadId)}
        </p>
      )}
    </div>
  );
}

// The draft publishes whether its project offers the switch, for the palette.
export const draftCopyStore = createStore<{ readonly offered: boolean; readonly on: boolean }>(
  () => ({ offered: false, on: false }),
);

export function workingCopyCommands({
  openThread,
  onNewThread,
  draft,
}: {
  readonly openThread: Thread | undefined;
  readonly onNewThread: boolean;
  readonly draft: { readonly offered: boolean; readonly on: boolean };
}): AppCommand[] {
  const commands: AppCommand[] = [];
  if (onNewThread && draft.offered) {
    commands.push({
      id: 'chat.draft.ownWorkingCopy',
      title: draft.on ? 'New thread: work in the project folder' : 'New thread: own working copy',
      group: 'Chat',
      keywords: ['working copy', 'worktree', 'branch', 'git', 'own'],
      run: ({ draft: store }) => store.setState({ ownWorkingCopy: !draft.on }),
    });
  }
  const copy = openThread?.workingCopy;
  if (openThread && copy) {
    const thread = openThread;
    commands.push({
      id: 'chat.copyWorkingCopyPath',
      title: "Copy the working copy's path",
      group: 'Chat',
      keywords: ['working copy', 'worktree', 'path', 'folder', 'copy'],
      detail: copy.path,
      run: () => void copyText(copy.path),
    });
    if (canRemoveThreadCopy(thread)) {
      commands.push({
        id: 'chat.removeWorkingCopy',
        title: 'Remove working copy',
        group: 'Chat',
        keywords: ['working copy', 'worktree', 'remove', 'delete', 'clean'],
        run: ({ connection }) => void askRemoveThreadCopy(connection, thread.id),
      });
    }
  }
  return commands;
}
