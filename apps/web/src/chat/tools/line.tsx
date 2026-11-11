import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ItemContext } from '../items';
import { oneLine, type ToolPayload } from './facts';
import { ToolOutput } from './output';
import type { ToolParts } from './row';
import { ToolTime } from './time';

// The one line a read, search or web call is (spec 28), with its time; open, its output.
export function oneLineParts(
  payload: ToolPayload,
  context: ItemContext,
  Icon: LucideIcon,
  extra?: ReactNode,
): ToolParts {
  return {
    line: (
      <>
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span data-testid="tool-line" className="min-w-0 truncate">
          {oneLine(payload, context.cwd)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {extra}
          <ToolTime payload={payload} context={context} />
        </span>
      </>
    ),
    body: () => <ToolOutput output={payload.output} lines={context.outputLines} />,
  };
}
