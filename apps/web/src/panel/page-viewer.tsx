import { pageSourceLabels } from '@wow/contracts';
import { ArrowLeftIcon, ExternalLinkIcon, FileXIcon, ImageOffIcon } from 'lucide-react';
import { useRuntime, type ViewerPage } from '@/app/runtime';
import { useTopic } from '@/chat/data';
import { safeHref } from '@/components/markdown';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useDateFormat } from '@/lib/format';
import { pageTitle, runPageRead } from '@/workflows/pages-tab';
import { closeViewer, pageDocument } from './viewer';

// A linked Confluence page in the context panel (review loop spec 35): its body as Confluence
// rendered it, in a frame without an origin where nothing runs and nothing is fetched, with
// "Open on host". The body is the server's last read; nothing is asked of the host here.
export function PageViewer({ page }: { readonly page: ViewerPage }) {
  const { layout } = useRuntime();
  const { when } = useDateFormat();
  const reads = useTopic('pageReads');
  const link = runPageRead(reads ?? [], page.runId)?.pages.find((entry) => entry.ref === page.ref);
  const shown = link?.page ?? undefined;
  const open = safeHref(shown?.url ?? link?.link);
  return (
    <section
      aria-label="Page viewer"
      data-testid="page-viewer"
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        closeViewer(layout, page.from);
      }}
    >
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-2 py-2">
        <div className="flex items-center gap-1">
          <Button size="xs" variant="ghost" onClick={() => closeViewer(layout, page.from)}>
            <ArrowLeftIcon />
            Back to conversation
          </Button>
          <span className="flex-1" />
          {open && (
            <Button asChild size="xs" variant="ghost">
              <a href={open} target="_blank" rel="noreferrer">
                <ExternalLinkIcon />
                Open on host
              </a>
            </Button>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-0.5 px-2">
          <h3 data-testid="page-viewer-title" className="truncate text-sm font-medium">
            {link ? pageTitle(link) : 'Page'}
          </h3>
          {link && (
            <p className="flex flex-wrap gap-x-3 text-2xs text-muted-foreground">
              {shown?.space && <span>Space {shown.space}</span>}
              {shown?.version && <span>Version {shown.version}</span>}
              <span>Linked from {pageSourceLabels[link.source]}</span>
              {link.fetchedAt && <span>Last fetched {when(link.fetchedAt)}</span>}
            </p>
          )}
          {link?.error && (
            <p role="alert" className="text-2xs text-destructive">
              {link.error.message}
            </p>
          )}
        </div>
      </div>
      {!shown ? (
        <EmptyState
          compact
          icon={FileXIcon}
          title="Nothing to show"
          description="wow has not read this page yet, or it is no longer linked from this run."
        />
      ) : (
        <>
          <p
            data-testid="page-pictures-note"
            className="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-1.5 text-2xs text-muted-foreground"
          >
            <ImageOffIcon aria-hidden className="size-3.5 shrink-0" />
            Pictures and attachments need your Confluence sign-in, so they do not load here. Open
            the page on the host to see them.
          </p>
          {/* The sandbox gives the page no origin and runs nothing in it; its policy lets it
              fetch nothing. */}
          <iframe
            title={shown.title || 'Confluence page'}
            data-testid="page-frame"
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={pageDocument(shown.body)}
            className="min-h-0 w-full flex-1 bg-white [color-scheme:light]"
          />
        </>
      )}
    </section>
  );
}
