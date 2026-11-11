import { WrenchIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { CodeBlock } from '@/components/code-block';
import type { ItemContext } from '../items';
import { cn } from '@/lib/utils';
import { formatDuration, toolDuration, type ToolPayload } from './facts';
import type { ToolParts } from './row';
import { runningLabel, useNow } from './time';

function inputSummary(input: unknown): string {
  if (typeof input === 'string') return input;
  if (typeof input !== 'object' || input === null) return '';
  const first = Object.values(input).find((value) => typeof value === 'string');
  return typeof first === 'string' ? first : '';
}

const oldStatus = {
  running: { label: 'running', className: 'text-state-working' },
  ok: { label: 'done', className: 'text-muted-foreground' },
  error: { label: 'error', className: 'text-state-failed' },
} as const;

// The status words this row always had, and since the server stores times, its time.
function Status({ payload, context }: { payload: ToolPayload; context: ItemContext }) {
  const running = runningLabel(payload, context);
  const now = useNow(running === 'running' && payload.startedAt !== undefined);
  const duration = running === 'not finished' ? undefined : toolDuration(payload, now);
  const status =
    running === 'waiting for approval'
      ? { label: running, className: 'text-state-needs-you' }
      : running === 'not finished'
        ? { label: running, className: 'text-muted-foreground' }
        : oldStatus[payload.status];
  return (
    <span
      data-testid="tool-time"
      data-started-at={payload.startedAt}
      className={cn('tabular-nums', status.className)}
    >
      {status.label}
      {duration !== undefined && ` · ${formatDuration(duration)}`}
    </span>
  );
}

// The row of a tool wow has no row of its own for, and of every call stored before tool kinds:
// its name, the first text of its input and its status; open, its input and output (spec 48).
export function genericParts(
  payload: ToolPayload,
  context: ItemContext,
  extra?: ReactNode,
): ToolParts {
  const summary = inputSummary(payload.input);
  return {
    line: (
      <>
        <WrenchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono font-medium">{payload.name}</span>
        {summary !== '' && (
          <span className="min-w-0 truncate font-mono text-muted-foreground">{summary}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {extra}
          <Status payload={payload} context={context} />
        </span>
      </>
    ),
    body: () => (
      <>
        <section aria-label="Tool input">
          <h4 className="mb-1 text-2xs text-muted-foreground">Input</h4>
          <CodeBlock
            code={JSON.stringify(payload.input, null, 2)}
            language="json"
            className="max-h-64 text-2xs"
          />
        </section>
        <section aria-label="Tool output">
          <h4 className="mb-1 text-2xs text-muted-foreground">Output</h4>
          {payload.output === '' ? (
            <p className="text-2xs text-muted-foreground">No output.</p>
          ) : (
            <CodeBlock code={payload.output} className="max-h-96 text-2xs" copy />
          )}
        </section>
      </>
    ),
  };
}
