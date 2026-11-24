import { changeRequestName, changeRequestRef, type ChangeRequest } from '@wow/contracts';
import { ChangeRequestState, ChecksBadge, HostLink } from '@/hosts/host-read';
import { failingChecks } from '@/hosts/labels';

// A pull or merge request as the host last answered it: state, checks with the failing ones by
// name, and review comments, each linked to the host, in a chat link's tab (agent workbench
// spec 21). Read only: wow never writes there.
export function ChangeRequestBody({
  request,
}: {
  readonly request: Omit<ChangeRequest, 'id' | 'projectId'>;
}) {
  const failing = failingChecks(request);
  return (
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
                  <span className="font-medium text-foreground">{comment.author || 'Someone'}</span>
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
  );
}
