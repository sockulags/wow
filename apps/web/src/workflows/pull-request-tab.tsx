import {
  changeRequestName,
  changeRequestRef,
  type ChangeRequest,
  type HostRead,
  type WorkflowRun,
} from '@wow/contracts';
import { GitPullRequestIcon } from 'lucide-react';
import { useTopic } from '@/chat/data';
import { EmptyState } from '@/components/states';
import {
  ChangeRequestState,
  ChecksBadge,
  HostLink,
  HostReadLine,
  useHostRefresh,
} from '@/plans/host-read';
import { failingChecks, runRead } from '@/plans/model';

// The run's pull request (review loop spec 28): the one whose head is the branch the run's
// folder is on, as the server last read it from the host. Read only: state, checks with the
// failing ones by name, and review comments, each linked to the host. wow never writes there.

// The pull request a run's read names, if the host showed one.
export function runPullRequest(
  read: HostRead | undefined,
  requests: readonly ChangeRequest[],
): ChangeRequest | undefined {
  const id = read?.changeRequestIds[0];
  return id === undefined ? undefined : requests.find((request) => request.id === id);
}

// Why there is nothing to show, in the order the user can do something about it.
export function emptyPullRequest(read: HostRead | undefined): string {
  if (!read) return 'The host has not been asked about this run yet.';
  const noun = read.host === 'gitlab' ? 'merge request' : 'pull request';
  if (read.fetchedAt === null)
    return `The host could not be read, so this run has no ${noun} to show.`;
  if (read.branch === null) {
    return `The run’s folder is on no branch, so there is no ${noun} to look for.`;
  }
  return `No ${noun} has the branch ${read.branch} as its head.`;
}

export function PullRequestTab({ run }: { readonly run: WorkflowRun }) {
  const reads = useTopic('hostReads');
  const requests = useTopic('changeRequests');
  const refresh = useHostRefresh({ runId: run.id });
  const read = runRead(reads ?? [], run.id);
  const request = runPullRequest(read, requests ?? []);
  const failing = request ? failingChecks(request) : [];
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto px-4 py-3">
      <HostReadLine read={read} refresh={refresh} openUrl={request?.url} />
      {!request ? (
        <EmptyState
          icon={GitPullRequestIcon}
          title="Nothing to show yet"
          description={emptyPullRequest(read)}
          className="h-auto flex-1"
        />
      ) : (
        <article aria-label={changeRequestName(request)} className="flex flex-col gap-4">
          <header className="flex flex-col gap-1.5">
            <h3 className="text-sm font-medium">
              <HostLink href={request.url}>
                {changeRequestRef(request)} {request.title}
              </HostLink>
            </h3>
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <ChangeRequestState request={request} />
              <ChecksBadge request={request} />
              <span className="font-mono">{request.headBranch}</span>
              <span className="font-mono">{request.headSha.slice(0, 7)}</span>
            </p>
          </header>

          <section aria-label="Failing checks" className="flex flex-col gap-1">
            <h4 className="text-xs font-medium">
              Failing checks<span className="ml-1 text-muted-foreground">{failing.length}</span>
            </h4>
            {failing.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {request.checkState === 'none' ? 'This commit has no checks.' : 'No check failed.'}
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5 text-xs">
                {failing.map((check, index) => (
                  <li key={`${check.name}:${index}`} data-testid="failing-check">
                    {check.url ? <HostLink href={check.url}>{check.name}</HostLink> : check.name}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Review comments" className="flex flex-col gap-1">
            <h4 className="text-xs font-medium">
              Review comments
              <span className="ml-1 text-muted-foreground">{request.comments.length}</span>
            </h4>
            {request.comments.length === 0 ? (
              <p className="text-xs text-muted-foreground">No review comments.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {request.comments.map((comment) => (
                  <li
                    key={comment.id}
                    data-testid="review-comment"
                    className="rounded-md border border-border px-3 py-2 text-xs"
                  >
                    <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {comment.author || 'Someone'}
                      </span>
                      {comment.path && <span className="font-mono">{comment.path}</span>}
                      <HostLink href={comment.url}>Open comment</HostLink>
                    </p>
                    {/* Someone else's words: plain text, never rendered or run. */}
                    <p className="mt-1 whitespace-pre-wrap break-words">{comment.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </article>
      )}
    </div>
  );
}
