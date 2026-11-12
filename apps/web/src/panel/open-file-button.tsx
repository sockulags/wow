import { FileSymlinkIcon } from 'lucide-react';
import type { MouseEvent } from 'react';
import { editorKeyOf, useFileLinks } from '@/components/file-links';
import { Button } from '@/components/ui/button';
import { WithTooltip } from '@/components/hint';

// Open on a tool row that reads, edits or writes a file (agent workbench spec 17): the file in a
// panel tab of the view on screen. Nothing shows where the view opens no files (the Assistant).
export function OpenFileButton({ path }: { readonly path: string }) {
  const links = useFileLinks();
  if (!links) return null;
  // The row is a <summary>: the click opens the file without opening or closing the row.
  const open = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    links.open(path);
  };
  return (
    <WithTooltip label={`Open ${path} in the side panel`}>
      <Button
        size="xs"
        variant="ghost"
        aria-label={`Open ${path}`}
        onClick={open}
        onKeyDown={(event) => editorKeyOf(links, event, path)}
      >
        <FileSymlinkIcon />
        Open
      </Button>
    </WithTooltip>
  );
}

// A file mentioned in a sent message (spec 56): a chip that opens it.
export function FileChip({ path }: { readonly path: string }) {
  const links = useFileLinks();
  const name =
    path
      .split(/[\\/]/)
      .filter((part) => part !== '')
      .at(-1) ?? path;
  const className =
    'inline-flex max-w-64 items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-2xs';
  if (!links) {
    return (
      <span className={className} title={path}>
        @{name}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={`Open ${path} in the side panel`}
      data-testid="sent-file-chip"
      className={`${className} outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring`}
      onClick={() => links.open(path)}
      onKeyDown={(event) => editorKeyOf(links, event, path)}
    >
      <span className="truncate">@{name}</span>
    </button>
  );
}
