import { PlugIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { CodeBlock } from '@/components/code-block';
import { Button } from '@/components/ui/button';
import type { ItemContext } from '../items';
import { argumentList, type ToolPayload } from './facts';
import { ToolOutput } from './output';
import type { ToolParts } from './row';
import { ToolTime } from './time';

function McpBody({ payload, context }: { payload: ToolPayload; context: ItemContext }) {
  const [json, setJson] = useState(false);
  const args = argumentList(payload.input);
  return (
    <>
      <section aria-label="Arguments">
        {args.length === 0 ? (
          <p className="text-2xs text-muted-foreground">No arguments.</p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-2xs">
            {args.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{key}:</dt>
                <dd className="min-w-0 break-all whitespace-pre-wrap">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <Button size="xs" variant="ghost" className="mt-1" onClick={() => setJson(!json)}>
          {json ? 'Hide JSON' : 'Show JSON'}
        </Button>
        {json && (
          <CodeBlock
            code={JSON.stringify(payload.input, null, 2)}
            language="json"
            className="max-h-64 text-2xs"
            copy
          />
        )}
      </section>
      <ToolOutput output={payload.output} lines={context.outputLines} />
    </>
  );
}

// `server › tool` with its arguments as key: value; the JSON only on request (spec 29).
export function mcpParts(payload: ToolPayload, context: ItemContext, extra?: ReactNode): ToolParts {
  const args = argumentList(payload.input);
  return {
    line: (
      <>
        <PlugIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span data-testid="tool-mcp" className="shrink-0 font-mono font-medium">
          {payload.server ?? ''} › {payload.tool ?? payload.name}
        </span>
        {args.length > 0 && (
          <span
            data-testid="tool-arguments"
            className="min-w-0 truncate font-mono text-muted-foreground"
          >
            {args.map(([key, value]) => `${key}: ${value}`).join(' · ')}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {extra}
          <ToolTime payload={payload} context={context} />
        </span>
      </>
    ),
    body: () => <McpBody payload={payload} context={context} />,
  };
}
