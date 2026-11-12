import { PanelRightOpenIcon } from 'lucide-react';
import { useMemo, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { draftText, onDraftChange } from './drafts';
import { HostChip, hostItemKeyOf, recogniseHostLink, type HostLinks } from './host-links';

// A link to one of the user's hosts pasted into the composer shows its chip above the text with
// "Open in panel" (agent workbench spec 25). It reads the draft the composer keeps (drafts.ts),
// so the composer itself knows nothing of it; nothing is read from the host until the tab opens.
export function PastedLinks({
  draftKey,
  links,
}: {
  readonly draftKey: string;
  readonly links: HostLinks;
}) {
  const text = useSyncExternalStore(
    (notify) =>
      onDraftChange((key) => {
        if (key === draftKey) notify();
      }),
    () => draftText(draftKey),
  );
  const items = useMemo(() => {
    const found = new Map<string, NonNullable<ReturnType<typeof recogniseHostLink>>>();
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)) {
      const item = recogniseHostLink(match[0].replace(/[.,;:!?]+$/, ''), links.rules);
      if (item) found.set(hostItemKeyOf(item), item);
    }
    return [...found.values()];
  }, [text, links.rules]);
  if (items.length === 0) return null;
  return (
    <ul aria-label="Links in the message" className="flex flex-wrap gap-2">
      {items.map((item) => (
        <li
          key={hostItemKeyOf(item)}
          data-testid="pasted-link"
          className="flex items-center gap-1 rounded-md border border-border px-1.5 py-1"
        >
          <HostChip item={item} links={links} className="border-0 bg-transparent" />
          <Button size="xs" variant="ghost" onClick={() => links.open(item)}>
            <PanelRightOpenIcon />
            Open in panel
          </Button>
        </li>
      ))}
    </ul>
  );
}
