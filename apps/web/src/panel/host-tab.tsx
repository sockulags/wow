import { HostLookupResult, type Issue } from '@wow/contracts';
import { ArrowLeftIcon, CircleDotIcon, LinkIcon } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLayout, useRuntime, type ViewerHostItem } from '@/app/runtime';
import { errorMessage, useTopic } from '@/chat/data';
import {
  hostItemIcon,
  hostItemLabel,
  hostItemState,
  readOf,
  recogniseHostRef,
  useHostLinkRules,
} from '@/chat/host-links';
import { Markdown } from '@/components/markdown';
import { EmptyState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
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
import { HostLink, HostReadLine } from '@/plans/host-read';
import { ChangeRequestBody } from '@/workflows/pull-request-tab';
import { PageBody } from '@/workflows/pages-tab';
import { TicketBody } from '@/workflows/ticket-tab';
import { closeViewer, openHostItem } from './viewer';

// An item a chat links to, in a panel tab (agent workbench spec 21 to 23): the body the run's
// tabs show for its kind, "Last fetched", Refresh now and Open on host. Opening the tab asks the
// server for the item once (`hosts.lookup` with `open`): the host is asked only when the thread
// has never read it, otherwise the stored read shows with its time (spec 22). Refresh now asks
// the host again. What is shown comes from the thread's stored reads, never from this window.

type Mode = 'open' | 'refresh';

function useHostItemRead(host: ViewerHostItem) {
  const { connection } = useRuntime();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [unreadable, setUnreadable] = useState(false);
  const { threadId, item } = host;
  const ask = useCallback(
    async (read: Mode) => {
      if (!connection) return;
      setBusy(true);
      setError(undefined);
      try {
        const answer = HostLookupResult.parse(
          await connection.request('hosts.lookup', { threadId, ref: item.url, read }),
        );
        setUnreadable(answer.item === null);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [connection, threadId, item.url],
  );
  useEffect(() => {
    void ask('open');
  }, [ask]);
  return { busy, error, unreadable, refresh: () => ask('refresh') };
}

export function IssueBody({ issue }: { readonly issue: Issue }) {
  return (
    <article aria-label={`Issue #${issue.number}`} className="flex flex-col gap-4">
      <header className="flex flex-col gap-1.5">
        <h3 className="text-sm font-medium">
          <HostLink href={issue.url}>
            #{issue.number} {issue.title}
          </HostLink>
        </h3>
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Badge data-testid="issue-state" variant={issue.state === 'open' ? 'info' : 'outline'}>
            {issue.state === 'open' ? 'Open' : 'Closed'}
          </Badge>
          {issue.labels.map((label) => (
            <Badge key={label} variant="outline">
              {label}
            </Badge>
          ))}
          {issue.author && <span>by {issue.author}</span>}
        </p>
      </header>
      <section aria-label="Description" className="flex flex-col gap-1">
        <h4 className="text-xs font-medium">Description</h4>
        {issue.body === '' ? (
          <p className="text-xs text-muted-foreground">This issue has no description.</p>
        ) : (
          // Someone else's words: the one markdown renderer, which never runs HTML.
          <div data-testid="issue-description" className="text-sm">
            <Markdown text={issue.body} />
          </div>
        )}
      </section>
      <section aria-label="Comments" className="flex flex-col gap-1">
        <h4 className="text-xs font-medium">
          Comments<span className="ml-1 text-muted-foreground">{issue.comments.length}</span>
        </h4>
        {issue.comments.length === 0 ? (
          <p className="text-xs text-muted-foreground">No comments.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {issue.comments.map((comment) => (
              <li
                key={comment.id}
                data-testid="issue-comment"
                className="rounded-md border border-border px-3 py-2 text-xs"
              >
                <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                  <span className="font-medium text-foreground">{comment.author || 'Someone'}</span>
                  <HostLink href={comment.url}>Open comment</HostLink>
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words">{comment.body}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

export function HostTab({ host }: { readonly host: ViewerHostItem }) {
  const { layout } = useRuntime();
  const reads = useTopic('hostItemReads', host.threadId);
  const read = readOf(reads ?? [], host.threadId, host.item);
  const asked = useHostItemRead(host);
  const data = read?.data ?? null;
  const Icon = hostItemIcon(host.item, data);
  const state = hostItemState(data);
  const openUrl =
    data?.kind === 'changeRequest'
      ? data.changeRequest.url
      : data?.kind === 'issue'
        ? data.issue.url
        : data?.kind === 'ticket'
          ? (data.ticket.url ?? host.item.url)
          : data?.kind === 'page'
            ? (data.page.url ?? host.item.url)
            : host.item.url;
  return (
    <section
      aria-label="Linked item"
      data-testid="host-tab"
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        closeViewer(layout, host.from);
      }}
    >
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-4 py-2">
        <div className="flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            className="-ml-2"
            onClick={() => closeViewer(layout, host.from)}
          >
            <ArrowLeftIcon />
            Back to details
          </Button>
        </div>
        <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <Icon aria-hidden className="size-4 shrink-0" />
          <span data-testid="host-tab-title" className="truncate">
            {[hostItemLabel(host.item, data), state].filter(Boolean).join(' · ')}
          </span>
        </h3>
        <HostReadLine
          read={read ? { ...read, host: read.item.host } : undefined}
          refresh={{ busy: asked.busy, error: asked.error, refresh: asked.refresh }}
          openUrl={openUrl}
        />
        {asked.unreadable && (
          <p role="alert" className="text-xs text-destructive">
            wow has no token for this link’s host any more, so it is not read. Store one in Settings
            → Trackers.
          </p>
        )}
      </div>
      {data === null ? (
        <EmptyState
          compact
          icon={CircleDotIcon}
          title={asked.busy ? 'Reading…' : 'Nothing to show yet'}
          description={
            asked.busy
              ? 'Asking the host once.'
              : 'The host has not answered for this item yet; Refresh now asks again.'
          }
        />
      ) : data.kind === 'page' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <PageBody page={data.page} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {data.kind === 'changeRequest' ? (
            <ChangeRequestBody request={data.changeRequest} />
          ) : data.kind === 'issue' ? (
            <IssueBody issue={data.issue} />
          ) : (
            <TicketBody ticket={data.ticket} source={null} />
          )}
        </div>
      )}
    </section>
  );
}

// "Open issue, PR or ticket…" (spec 25): a web address or a key, opened in a panel tab under the
// same rules as a chip. Anything else is not read and says why.
export function OpenHostItemDialog() {
  const { settings, layout } = useRuntime();
  const dialog = useLayout((state) => state.openHostDialog);
  const rules = useHostLinkRules(dialog?.threadId);
  const [text, setText] = useState('');
  const [tried, setTried] = useState(false);
  const item = text.trim() === '' ? undefined : recogniseHostRef(text, rules);
  const close = () => {
    layout.setState({ openHostDialog: undefined });
    setText('');
    setTried(false);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (!dialog || !item) return;
    close();
    openHostItem({ settings, layout }, { threadId: dialog.threadId, item, from: dialog.from });
  };
  return (
    <Dialog
      open={dialog !== undefined}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <DialogHeader>
            <DialogTitle>Open issue, PR or ticket</DialogTitle>
            <DialogDescription>
              Paste a web address, or type a key such as DEMO-42, #14 or !7. It opens in the side
              panel.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Address or key"
            autoFocus
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setTried(false);
            }}
          />
          <p data-testid="host-dialog-note" className="min-h-4 text-xs text-muted-foreground">
            {item ? (
              <span className="inline-flex items-center gap-1">
                <LinkIcon className="size-3.5" />
                {hostItemLabel(item)}
              </span>
            ) : tried || text.trim() !== '' ? (
              'wow reads only links to the hosts in Settings → Trackers that have a token, and keys of this thread’s project.'
            ) : null}
          </p>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!item}>
              Open in panel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
