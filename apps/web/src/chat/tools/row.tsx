import { ChevronRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ToolKind } from '@wow/contracts';
import { copyText } from '@/components/copy-button';
import { useRowActions } from '@/lib/row-actions';
import { cn } from '@/lib/utils';
import { useSetting } from '@/app/runtime';
import { ToolImages } from '../image-chip';
import { openKey, OutputKeyContext, useOpenState } from '../open-state';

// What a tool row is drawn from: its one line, and what it shows when opened. The body is only
// rendered while the row is open, so long outputs cost nothing when collapsed.
export interface ToolParts {
  readonly line: ReactNode;
  readonly body: () => ReactNode;
}

export function ToolRowFrame({
  parts,
  kind,
  failed,
  output = '',
  itemId,
  pictures,
}: {
  parts: ToolParts;
  kind: ToolKind | undefined;
  failed: boolean;
  // The pictures of the result (chat overview spec 33), shown under the line also while closed.
  pictures?:
    | {
        readonly threadId: string;
        readonly images: readonly { readonly id: string }[];
        readonly omitted: { readonly count: number; readonly reason: string } | undefined;
      }
    | undefined;
  // What the call printed, which the row copies from the palette while it has the focus.
  output?: string;
  // The call's item, whose open state the conversation keeps (a click and find set it).
  itemId?: string | undefined;
}) {
  const [open, setOpen] = useOpenState(itemId === undefined ? undefined : openKey('row', itemId));
  const actions = useRowActions(
    output === ''
      ? []
      : [
          {
            id: 'copyOutput',
            title: 'Copy output',
            keywords: ['copy', 'tool', 'clipboard'],
            run: () => copyText(output),
          },
        ],
  );
  return (
    <details
      {...actions}
      data-tool-kind={kind ?? 'old'}
      className={cn(
        'group rounded-md border text-xs',
        failed ? 'border-state-failed/40' : 'border-border',
      )}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 select-none">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
        {parts.line}
      </summary>
      {pictures && !open && (
        <div className="px-2 pb-1.5">
          <ClosedPictures pictures={pictures} onMore={() => setOpen(true)} />
        </div>
      )}
      {open && (
        <OutputKeyContext value={itemId === undefined ? undefined : openKey('output', itemId)}>
          <div className="flex flex-col gap-2 border-t border-border p-2">
            {pictures && (
              <ToolImages
                threadId={pictures.threadId}
                images={pictures.images}
                omitted={pictures.omitted}
                shown={pictures.images.length}
              />
            )}
            {parts.body()}
          </div>
        </OutputKeyContext>
      )}
    </details>
  );
}

// The first `chat.toolImagesShown` pictures under a closed row; "+N more" opens it.
function ClosedPictures({
  pictures,
  onMore,
}: {
  pictures: {
    readonly threadId: string;
    readonly images: readonly { readonly id: string }[];
    readonly omitted: { readonly count: number; readonly reason: string } | undefined;
  };
  onMore: () => void;
}) {
  const shown = useSetting('chat.toolImagesShown');
  return (
    <ToolImages
      threadId={pictures.threadId}
      images={pictures.images}
      omitted={pictures.omitted}
      shown={shown}
      onMore={onMore}
    />
  );
}
