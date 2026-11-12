import {
  hostReadId,
  pageSourceLabels,
  type Page,
  type PageLink,
  type PageRead,
  type WorkflowRun,
} from '@wow/contracts';
import { Link, useRouterState } from '@tanstack/react-router';
import { ExternalLinkIcon, ImageOffIcon, LibraryIcon, PanelRightOpenIcon } from 'lucide-react';
import { useRuntime } from '@/app/runtime';
import { useTopic } from '@/chat/data';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useDateFormat } from '@/lib/format';
import { openPage, pageDocument } from '@/panel/viewer';
import { HostLink, HostReadLine, useHostRefresh } from '@/plans/host-read';
import { settingGroup, settingLabel } from '@/plans/model';

// The Confluence pages the run's ticket description, pull request body or intent link to (review
// loop spec 35), as the server last read them. Opening one shows its body in the side panel.
// Pages nothing links to are never read, so there is no search here.

export const runPageRead = (reads: readonly PageRead[], runId: string): PageRead | undefined =>
  reads.find((read) => read.id === hostReadId('run', runId));

// Why there is no page to list, in the order the user can do something about it.
export function emptyPages(read: PageRead | undefined): string {
  if (!read) return 'Confluence has not been asked about this run yet.';
  if (read.error === null) {
    return 'No Confluence page is linked from this run’s ticket description, pull request body or intent, so none was read.';
  }
  return 'Confluence is not read for this run until the error above is fixed.';
}

export const pageTitle = (link: PageLink): string =>
  link.page?.title ||
  (link.ref.startsWith('title:') ? link.ref.slice(link.ref.indexOf('/') + 1) : link.link);

function PageRow({ runId, link }: { readonly runId: string; readonly link: PageLink }) {
  const runtime = useRuntime();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { when } = useDateFormat();
  const title = pageTitle(link);
  const page = link.page;
  return (
    <li
      data-testid={`page-${link.ref}`}
      className="flex flex-col gap-1 border-b border-border pb-3 text-xs"
    >
      <div className="flex min-w-0 items-center gap-2">
        {page ? (
          <Button
            variant="link"
            size="xs"
            className="h-auto min-w-0 justify-start px-0 text-sm font-medium"
            onClick={() => openPage(runtime, { runId, ref: link.ref, from: pathname })}
          >
            <PanelRightOpenIcon />
            <span className="truncate">{title}</span>
          </Button>
        ) : (
          <span className="min-w-0 truncate text-sm font-medium">{title}</span>
        )}
        <span className="flex-1" />
        <HostLink href={page?.url ?? link.link}>
          <ExternalLinkIcon className="size-3.5" />
          Open on host
        </HostLink>
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
        {page?.space && <span>Space {page.space}</span>}
        <span>Linked from {pageSourceLabels[link.source]}</span>
        <span data-testid="page-fetched">
          {link.fetchedAt ? `Last fetched ${when(link.fetchedAt)}` : 'Not fetched yet'}
        </span>
      </p>
      {link.error && (
        <p role="alert" data-testid="page-error" className="text-destructive">
          {link.error.message}
          {link.error.setting && (
            <>
              {' '}
              <Link
                to="/settings/$group"
                params={{ group: settingGroup(link.error.setting) }}
                className="underline underline-offset-2"
              >
                Open {settingLabel(link.error.setting)} in Settings
              </Link>
            </>
          )}
        </p>
      )}
    </li>
  );
}

export function PagesTab({ run }: { readonly run: WorkflowRun }) {
  const reads = useTopic('pageReads');
  const refresh = useHostRefresh({ runId: run.id });
  const read = runPageRead(reads ?? [], run.id);
  const links = read?.pages ?? [];
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto px-4 py-3">
      <HostReadLine read={read} refresh={refresh} />
      {links.length === 0 ? (
        <EmptyState
          icon={LibraryIcon}
          title="Nothing to show yet"
          description={emptyPages(read)}
          className="h-auto flex-1"
        />
      ) : (
        <ul aria-label="Linked pages" className="flex flex-col gap-3">
          {links.map((link) => (
            <PageRow key={link.ref} runId={run.id} link={link} />
          ))}
        </ul>
      )}
    </div>
  );
}

// A Confluence page's body as Confluence rendered it, in a frame without an origin where nothing
// runs and nothing is fetched. Shared by the run's page viewer and a chat link's tab (agent
// workbench spec 21).
export function PageBody({ page }: { readonly page: Page }) {
  return (
    <>
      <p
        data-testid="page-pictures-note"
        className="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-1.5 text-2xs text-muted-foreground"
      >
        <ImageOffIcon aria-hidden className="size-3.5 shrink-0" />
        Pictures and attachments need your Confluence sign-in, so they do not load here. Open the
        page on the host to see them.
      </p>
      {/* The sandbox gives the page no origin and runs nothing in it; its policy lets it
          fetch nothing. */}
      <iframe
        title={page.title || 'Confluence page'}
        data-testid="page-frame"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={pageDocument(page.body)}
        className="min-h-0 w-full flex-1 bg-white [color-scheme:light]"
      />
    </>
  );
}
