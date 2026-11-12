import { TerminalIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ItemContext } from '../items';
import { otherFolder, type ToolPayload } from './facts';
import { ToolOutput } from './output';
import type { ToolParts } from './row';
import { ToolTime } from './time';

// `$ pnpm test` in mono, the folder when it is not the thread's, and "exit 1 · 4.2 s"; open,
// the output's last lines in a terminal-style box (spec 27).
export function commandParts(
  payload: ToolPayload,
  context: ItemContext,
  extra?: ReactNode,
): ToolParts {
  const folder = otherFolder(payload, context.cwd);
  return {
    line: (
      <>
        <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <code data-testid="tool-command" className="min-w-0 truncate font-mono">
          $ {payload.command ?? payload.name}
        </code>
        {folder !== undefined && (
          <span
            data-testid="tool-folder"
            className="min-w-0 shrink truncate font-mono text-2xs text-muted-foreground"
          >
            in {folder}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {extra}
          <ToolTime payload={payload} context={context} command />
        </span>
      </>
    ),
    body: () => <ToolOutput output={payload.output} lines={context.outputLines} />,
  };
}
