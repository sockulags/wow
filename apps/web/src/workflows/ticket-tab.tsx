import { hostReadId, ticketSourceLabels, type TicketRead, type WorkflowRun } from '@wow/contracts';
import { TicketIcon } from 'lucide-react';
import { useTopic } from '@/chat/data';
import { Badge } from '@/components/ui/badge';
import { Markdown } from '@/components/markdown';
import { EmptyState } from '@/components/states';
import { HostLink, HostReadLine, useHostRefresh } from '@/plans/host-read';

// The run's Jira ticket (review loop spec 33) as the server last read it: the issue its backlog
// item was published as, else the one whose key is in its pull request title or branch name.
// Read only: key, summary, status, assignee, type and description, with a link to Jira.

export const runTicketRead = (
  reads: readonly TicketRead[],
  runId: string,
): TicketRead | undefined => reads.find((read) => read.id === hostReadId('run', runId));

// Why there is no ticket to show, in the order the user can do something about it.
export function emptyTicket(read: TicketRead | undefined): string {
  if (!read) return 'Jira has not been asked about this run yet.';
  if (read.key === null && read.error === null) {
    return 'No Jira ticket was found for this run: its backlog item was not published to Jira, and neither its pull request title nor its branch name has a key of the project’s Jira project.';
  }
  if (read.key === null) return 'Jira is not read for this run until the error above is fixed.';
  return `Jira could not be read, so ${read.key} has nothing to show yet.`;
}

export function TicketTab({ run }: { readonly run: WorkflowRun }) {
  const reads = useTopic('ticketReads');
  const refresh = useHostRefresh({ runId: run.id });
  const read = runTicketRead(reads ?? [], run.id);
  const ticket = read?.ticket ?? undefined;
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto px-4 py-3">
      <HostReadLine read={read} refresh={refresh} openUrl={ticket?.url ?? undefined} />
      {!ticket ? (
        <EmptyState
          icon={TicketIcon}
          title="Nothing to show yet"
          description={emptyTicket(read)}
          className="h-auto flex-1"
        />
      ) : (
        <article aria-label={`Ticket ${ticket.key}`} className="flex flex-col gap-4">
          <header className="flex flex-col gap-1.5">
            <h3 className="text-sm font-medium">
              {ticket.url ? (
                <HostLink href={ticket.url}>
                  <span className="font-mono">{ticket.key}</span> {ticket.summary}
                </HostLink>
              ) : (
                <>
                  <span className="font-mono">{ticket.key}</span> {ticket.summary}
                </>
              )}
            </h3>
            <dl className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <dt className="sr-only">Type</dt>
                <dd>
                  <Badge variant="outline" data-testid="ticket-type">
                    {ticket.type || 'No type'}
                  </Badge>
                </dd>
              </div>
              <div className="flex items-center gap-1">
                <dt className="sr-only">Status</dt>
                <dd>
                  <Badge variant="info" data-testid="ticket-status">
                    {ticket.status || 'No status'}
                  </Badge>
                </dd>
              </div>
              <div className="flex items-center gap-1">
                <dt>Assignee</dt>
                <dd data-testid="ticket-assignee" className="text-foreground">
                  {ticket.assignee ?? 'Unassigned'}
                </dd>
              </div>
              {read?.source && (
                <div className="flex items-center gap-1">
                  <dt>Found in</dt>
                  <dd data-testid="ticket-source">{ticketSourceLabels[read.source]}</dd>
                </div>
              )}
            </dl>
          </header>
          <section aria-label="Description" className="flex flex-col gap-1">
            <h4 className="text-xs font-medium">Description</h4>
            {ticket.description === '' ? (
              <p className="text-xs text-muted-foreground">This ticket has no description.</p>
            ) : (
              // Someone else's words, converted from Jira's markup by the server: rendered by
              // the one markdown renderer, which never runs HTML.
              <div data-testid="ticket-description" className="text-sm">
                <Markdown text={ticket.description} />
              </div>
            )}
          </section>
        </article>
      )}
    </div>
  );
}
