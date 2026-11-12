import type { ReactNode } from 'react';
import type { ItemContext } from '../items';
import { commandParts } from './command';
import type { ToolPayload } from './facts';
import { genericParts } from './generic';
import { mcpParts } from './mcp';
import { readParts } from './read';
import { ToolRowFrame, type ToolParts } from './row';
import { searchParts } from './search';
import { webParts } from './web';

// The row of one tool call by its kind. Edits are drawn as a plain row until their diff row
// exists; a call without a kind (stored before) is drawn as it was.
export function toolParts(
  payload: ToolPayload,
  context: ItemContext,
  extra?: ReactNode,
): ToolParts {
  switch (payload.kind) {
    case 'command':
      return commandParts(payload, context, extra);
    case 'read':
      return readParts(payload, context, extra);
    case 'search':
      return searchParts(payload, context, extra);
    case 'web':
      return webParts(payload, context, extra);
    case 'mcp':
      return mcpParts(payload, context, extra);
    default:
      return genericParts(payload, context, extra);
  }
}

export function ToolCall({ payload, context }: { payload: ToolPayload; context: ItemContext }) {
  return (
    <ToolRowFrame
      parts={toolParts(payload, context)}
      kind={payload.kind}
      output={payload.output}
      failed={payload.kind !== undefined && payload.status === 'error'}
    />
  );
}
