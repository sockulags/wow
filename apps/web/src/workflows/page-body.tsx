import type { Page } from '@wow/contracts';
import { ImageOffIcon } from 'lucide-react';
import { pageDocument } from '@/panel/viewer';

// A Confluence page's body as Confluence rendered it, in a frame without an origin where nothing
// runs and nothing is fetched, in a chat link's tab (agent workbench spec 21).
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
