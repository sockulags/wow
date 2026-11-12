import { SparklesIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ItemContext } from '../items';
import type { ToolPayload } from './facts';
import { genericParts, Status } from './generic';
import type { ToolParts } from './row';

// A call named in words by the view it is in, such as "Read your workflows" for one of wow's
// tools in the Assistant view (agent workbench spec 82). Open, it shows what went in and out.
export function wordsParts(
  payload: ToolPayload,
  context: ItemContext,
  words: string,
  extra?: ReactNode,
): ToolParts {
  return {
    line: (
      <>
        <SparklesIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span data-testid="tool-words" className="min-w-0 truncate font-medium">
          {words}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {extra}
          <Status payload={payload} context={context} />
        </span>
      </>
    ),
    body: genericParts(payload, context).body,
  };
}
