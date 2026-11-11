import { ChevronRightIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ToolKind } from '@wow/contracts';
import { cn } from '@/lib/utils';

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
}: {
  parts: ToolParts;
  kind: ToolKind | undefined;
  failed: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      data-tool-kind={kind ?? 'old'}
      className={cn(
        'group rounded-md border text-xs',
        failed ? 'border-state-failed/40' : 'border-border',
      )}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 select-none">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
        {parts.line}
      </summary>
      {open && <div className="flex flex-col gap-2 border-t border-border p-2">{parts.body()}</div>}
    </details>
  );
}
