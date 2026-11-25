import type { Ticket } from '@wow/contracts';
import { Badge } from '@/components/ui/badge';
import { Markdown } from '@/components/markdown';
import { HostLink } from '@/hosts/host-read';

// A Jira ticket as last read: key, summary, type, status, assignee and description, in a chat
// link's tab (agent workbench spec 21).
export function TicketBody({ ticket }: { readonly ticket: Ticket }) {
  return (
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
  );
}
