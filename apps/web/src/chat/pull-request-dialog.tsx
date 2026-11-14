import {
  OpenPullRequestResult,
  ProposeResult,
  PullRequestPlan,
  PullRequestRefusal,
  changeRequestWords,
  rpcMethods,
  type ChangeRequestOpenedItemPayload,
  type CodeHostKind,
} from '@wow/contracts';
import { RpcClientError, type Connection } from '@wow/client-runtime';
import { useRouter } from '@tanstack/react-router';
import { GitPullRequestIcon, SparklesIcon, UploadIcon } from 'lucide-react';
import { useId, type KeyboardEvent } from 'react';
import { createStore, useStore } from 'zustand';
import { useRuntime, useSetting } from '@/app/runtime';
import { ChoiceSelect } from '@/components/choice-select';
import { FormField } from '@/components/form-field';
import { ShortcutHint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { notify } from '@/lib/feedback';
import { routerPanelRoute } from '@/panel/model';
import { isBinding } from '@/panel/editor';
import { openHostItem } from '@/panel/viewer';
import { errorMessage } from './data';
import { HostChip, useHostLinks } from './host-links';

// Open a pull or merge request for a chat thread's branch (thread work spec 31 to 35): where it
// goes and what it holds, a title and body "Propose" can fill, Draft, and Open, which pushes the
// branch with Git's own credentials and opens the request with the host token. When one is open
// for the branch already, the dialog offers it in the panel and a push of the new commits.

export interface PullRequestQuestion {
  readonly threadId: string;
  readonly plan: PullRequestPlan | undefined;
  readonly target: string | undefined;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  // The user changed the title or body, so a new plan does not replace them.
  readonly edited: boolean;
  readonly busy: boolean;
  readonly proposing: string | undefined;
  readonly error: string | undefined;
  readonly refusal: PullRequestRefusal | undefined;
}

export const pullRequestStore = createStore<{ readonly question: PullRequestQuestion | undefined }>(
  () => ({ question: undefined }),
);

const patch = (threadId: string, changes: Partial<PullRequestQuestion>) =>
  pullRequestStore.setState((state) =>
    state.question?.threadId === threadId ? { question: { ...state.question, ...changes } } : state,
  );

// "pull request" or "merge request", by the host the plan names (GitHub when none).
export const requestNoun = (host: CodeHostKind | null | undefined): string =>
  changeRequestWords[host ?? 'github'].noun;

async function readPlan(connection: Connection, threadId: string, target: string | undefined) {
  return PullRequestPlan.parse(
    await connection.request(
      'threads.pullRequestPlan',
      target === undefined ? { threadId } : { threadId, target },
    ),
  );
}

// Opens the dialog and reads where the request would go (spec 31, 33). Nothing is pushed.
export async function askPullRequest(
  connection: Connection | undefined,
  threadId: string,
  target?: string,
): Promise<void> {
  const before = pullRequestStore.getState().question;
  const keep = before?.threadId === threadId && before.edited ? before : undefined;
  pullRequestStore.setState({
    question: {
      threadId,
      plan: before?.threadId === threadId ? before.plan : undefined,
      target,
      title: keep?.title ?? '',
      body: keep?.body ?? '',
      draft: before?.threadId === threadId ? before.draft : false,
      edited: keep !== undefined,
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
    const plan = await readPlan(connection, threadId, target);
    const current = pullRequestStore.getState().question;
    if (current?.threadId !== threadId) return;
    patch(threadId, {
      plan,
      busy: false,
      target: plan.target ?? undefined,
      ...(current.edited ? {} : { title: plan.title, body: plan.body }),
      ...(before?.threadId === threadId && before.plan ? {} : { draft: plan.draft }),
    });
  } catch (failure) {
    patch(threadId, { busy: false, error: errorMessage(failure) });
  }
}

export function closePullRequest(connection: Connection | undefined): void {
  const question = pullRequestStore.getState().question;
  if (!question || question.busy) return;
  if (question.proposing) void cancelPullRequestProposal(connection);
  pullRequestStore.setState({ question: undefined });
}

export async function proposePullRequest(connection: Connection | undefined): Promise<void> {
  const question = pullRequestStore.getState().question;
  if (!question || !connection || question.proposing) return;
  const requestId = `proposal-${crypto.randomUUID()}`;
  const { threadId } = question;
  patch(threadId, { proposing: requestId, error: undefined });
  try {
    const answer = ProposeResult.parse(
      await connection.request('threads.propose', {
        threadId,
        requestId,
        purpose: 'pullRequest',
        ...(question.target ? { target: question.target } : {}),
      }),
    );
    if (pullRequestStore.getState().question?.proposing !== requestId) return;
    patch(threadId, {
      proposing: undefined,
      edited: true,
      ...('text' in answer ? { title: answer.text } : { title: answer.title, body: answer.body }),
    });
  } catch (failure) {
    if (pullRequestStore.getState().question?.proposing !== requestId) return;
    patch(threadId, { proposing: undefined, error: errorMessage(failure) });
  }
}

export async function cancelPullRequestProposal(connection: Connection | undefined) {
  const question = pullRequestStore.getState().question;
  const requestId = question?.proposing;
  if (!question || requestId === undefined) return;
  patch(question.threadId, { proposing: undefined });
  await connection?.request('threads.cancelProposal', { requestId }).catch(() => undefined);
}

const refusalOf = (failure: unknown) =>
  failure instanceof RpcClientError ? PullRequestRefusal.safeParse(failure.data).data : undefined;

// Open (spec 32, 34): a refusal of the host after the push says the branch is pushed, and Open
// can be pressed again.
export async function confirmPullRequest(connection: Connection | undefined): Promise<void> {
  const question = pullRequestStore.getState().question;
  const { plan } = question ?? {};
  if (!question || !plan || !connection || question.busy || question.proposing) return;
  if (plan.status !== 'ok' || !question.target) return;
  const { threadId } = question;
  patch(threadId, { busy: true, error: undefined, refusal: undefined });
  try {
    const opened = OpenPullRequestResult.parse(
      await connection.request('threads.openPullRequest', {
        threadId,
        target: question.target,
        title: question.title,
        body: question.body,
        draft: question.draft,
      }),
    );
    pullRequestStore.setState((state) =>
      state.question?.threadId === threadId ? { question: undefined } : state,
    );
    const { noun, mark } = changeRequestWords[plan.host ?? 'github'];
    notify.success(`Opened ${noun} ${mark}${opened.number}`);
  } catch (failure) {
    const refusal = refusalOf(failure);
    patch(threadId, { busy: false, ...(refusal ? { refusal } : { error: errorMessage(failure) }) });
  }
}

// "Push the new commits" to the request open for the branch (spec 33).
export async function pushToOpenRequest(
  connection: Connection | undefined,
  threadId: string,
): Promise<void> {
  if (!connection) return;
  patch(threadId, { busy: true, error: undefined, refusal: undefined });
  try {
    const pushed = rpcMethods['threads.pushBranch'].result.parse(
      await connection.request('threads.pushBranch', { threadId }),
    );
    notify.success('Pushed the new commits', {
      description: `${pushed.branch} on ${pushed.remote}`,
    });
    const question = pullRequestStore.getState().question;
    if (question?.threadId === threadId)
      await askPullRequest(connection, threadId, question.target);
  } catch (failure) {
    const refusal = refusalOf(failure);
    if (!pullRequestStore.getState().question) {
      notify.error('The commits were not pushed', {
        description: refusal?.reason ?? errorMessage(failure),
      });
      return;
    }
    patch(threadId, { busy: false, ...(refusal ? { refusal } : { error: errorMessage(failure) }) });
  }
}

// "Pushes wow/ring-twice-3fa2c1 to origin and opens a pull request on github.com in acme/tea".
export function pullRequestStatement(plan: PullRequestPlan, draft: boolean): string {
  const noun = `${draft ? 'draft ' : ''}${requestNoun(plan.host)}`;
  return `Pushes ${plan.branch ?? 'the branch'} to ${plan.remote ?? 'its remote'} and opens a ${noun} on ${plan.hostName || 'the host'} in ${plan.repository}`;
}

export function PullRequestDialog({ threadId }: { readonly threadId: string }) {
  const { connection, settings, layout } = useRuntime();
  // Read when clicked: the dialog is also drawn without a router (tests).
  const router: ReturnType<typeof useRouter> | undefined = useRouter({ warn: false });
  const confirmBinding = useSetting('keybindings.commitConfirm');
  const question = useStore(pullRequestStore, (state) =>
    state.question?.threadId === threadId ? state.question : undefined,
  );
  const targetId = useId();
  const titleId = useId();
  const bodyId = useId();
  const draftId = useId();
  const plan = question?.plan;
  const noun = requestNoun(plan?.host);
  const ready = plan?.status === 'ok' && (question?.title.trim() ?? '') !== '';
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isBinding(event, confirmBinding)) return;
    event.preventDefault();
    event.stopPropagation();
    void confirmPullRequest(connection);
  };
  const existing = plan?.existing;
  return (
    <Dialog
      open={question !== undefined}
      onOpenChange={(next) => !next && closePullRequest(connection)}
    >
      <DialogContent
        data-testid="pull-request-dialog"
        className="sm:max-w-xl"
        onKeyDown={onKeyDown}
      >
        <DialogHeader>
          <DialogTitle>Open {noun}</DialogTitle>
          <DialogDescription data-testid="pull-request-statement">
            {!plan
              ? 'Reading the branch…'
              : plan.status === 'ok'
                ? pullRequestStatement(plan, question?.draft ?? false)
                : `${plan.branch ?? 'No branch'}${plan.remote ? ` · ${plan.remote}` : ''}`}
          </DialogDescription>
        </DialogHeader>
        {plan && question && (
          <div className="flex min-h-0 flex-col gap-3">
            {plan.status !== 'ok' && (
              <p
                role="status"
                data-testid="pull-request-refused"
                data-status={plan.status}
                className={plan.status === 'existing' ? 'text-xs' : 'text-xs text-destructive'}
              >
                {plan.message}
              </p>
            )}
            {existing && (
              <div
                className="flex flex-wrap items-center gap-2"
                data-testid="pull-request-existing"
              >
                <span className="min-w-0 truncate text-xs">
                  {changeRequestWords[plan.host ?? 'github'].mark}
                  {existing.number} · {existing.title}
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    openHostItem(
                      { settings, layout },
                      { threadId, item: existing.ref, from: routerPanelRoute(router) },
                    );
                    closePullRequest(connection);
                  }}
                >
                  Open in panel
                </Button>
                {existing.unpushed > 0 && (
                  <Button
                    size="xs"
                    disabled={question.busy}
                    onClick={() => void pushToOpenRequest(connection, threadId)}
                  >
                    <UploadIcon />
                    Push the new commits ({existing.unpushed})
                  </Button>
                )}
              </div>
            )}
            {plan.branches.length > 0 && plan.status !== 'existing' && (
              <FormField id={targetId} label="Into">
                <ChoiceSelect
                  value={question.target ?? ''}
                  choices={plan.branches.map((branch) => ({ value: branch, label: branch }))}
                  onValueChange={(target) => void askPullRequest(connection, threadId, target)}
                />
              </FormField>
            )}
            {plan.commits.length > 0 && plan.status !== 'existing' && (
              <section className="flex flex-col gap-1">
                <h3 className="text-xs font-medium">
                  {plan.commits.length === 1 ? '1 commit' : `${plan.commits.length} commits`}
                </h3>
                <ul
                  aria-label="Commits"
                  className="flex max-h-32 flex-col gap-0.5 overflow-y-auto font-mono text-xs"
                >
                  {plan.commits.map((commit) => (
                    <li key={commit.sha} className="flex min-w-0 gap-2">
                      <span className="shrink-0 text-muted-foreground">
                        {commit.sha.slice(0, 7)}
                      </span>
                      <span className="min-w-0 truncate">{commit.subject}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {plan.status !== 'existing' && (
              <>
                <FormField
                  id={titleId}
                  label="Title"
                  labelAction={
                    question.proposing ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-label="Cancel the proposal"
                        onClick={() => void cancelPullRequestProposal(connection)}
                      >
                        Cancel
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={plan.commits.length === 0}
                        onClick={() => void proposePullRequest(connection)}
                      >
                        <SparklesIcon />
                        Propose
                      </Button>
                    )
                  }
                >
                  <Input
                    autoFocus
                    readOnly={question.proposing !== undefined}
                    value={question.proposing ? 'Writing a title…' : question.title}
                    onChange={(event) =>
                      patch(threadId, { title: event.target.value, edited: true })
                    }
                  />
                </FormField>
                <FormField id={bodyId} label="Description">
                  <Textarea
                    rows={5}
                    readOnly={question.proposing !== undefined}
                    value={question.proposing ? 'Writing a description…' : question.body}
                    onChange={(event) =>
                      patch(threadId, { body: event.target.value, edited: true })
                    }
                  />
                </FormField>
                <span className="flex items-center gap-2">
                  <Switch
                    id={draftId}
                    checked={question.draft}
                    onCheckedChange={(draft) => patch(threadId, { draft })}
                  />
                  <Label htmlFor={draftId} className="text-xs font-normal">
                    Draft
                  </Label>
                </span>
              </>
            )}
            {question.refusal && (
              <div role="alert" data-testid="pull-request-refusal" className="flex flex-col gap-1">
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
            disabled={question?.busy && plan !== undefined}
            onClick={() => closePullRequest(connection)}
          >
            Cancel
          </Button>
          {plan?.status !== 'existing' && (
            <Button
              disabled={!ready || question?.busy || question?.proposing !== undefined}
              onClick={() => void confirmPullRequest(connection)}
            >
              <GitPullRequestIcon />
              {question?.busy && plan ? 'Opening…' : `Open ${noun}`}
              <ShortcutHint shortcut="keybindings.commitConfirm" />
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// "Opened pull request #14 · Ring the bell twice" with the host chip (spec 32).
export function changeRequestLineText(payload: ChangeRequestOpenedItemPayload): string {
  const host = payload.ref.host === 'gitlab' ? 'gitlab' : 'github';
  const { noun, mark } = changeRequestWords[host];
  return `Opened ${noun} ${mark}${payload.number} · ${payload.title}`;
}

export function ChangeRequestOpenedLine({
  payload,
}: {
  readonly payload: ChangeRequestOpenedItemPayload;
}) {
  const links = useHostLinks();
  return (
    <div
      data-testid="change-request-line"
      className="flex items-center gap-2 text-2xs text-muted-foreground"
    >
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="flex min-w-0 items-center gap-1.5">
        <GitPullRequestIcon aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{changeRequestLineText(payload)}</span>
        {links && <HostChip item={payload.ref} links={links} />}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

// The Changes button and palette title by the thread's host.
export const openRequestLabel = (host: CodeHostKind | null | undefined): string =>
  `Open ${requestNoun(host)}…`;
