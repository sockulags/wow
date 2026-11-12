import { settingsRegistry } from '@wow/contracts';
import { useContext } from 'react';
import { CopyButton, copyText } from '@/components/copy-button';
import { useRowActions } from '@/lib/row-actions';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { OutputKeyContext, useOpenState } from '../open-state';
import { lastLines } from './facts';

const defaultLines = settingsRegistry['chat.toolOutputLines'].default;

// A call's output in a terminal-style box: its last lines (`chat.toolOutputLines`), "Show all N
// lines" for the rest, and Copy, which always copies all of it (spec 27, 32).
export function ToolOutput({
  output,
  lines = defaultLines,
  label = 'Tool output',
}: {
  output: string;
  lines?: number | undefined;
  label?: string;
}) {
  // Find opens the earlier lines too (thread work spec 4), through the row's key.
  const [all, setAll] = useOpenState(useContext(OutputKeyContext));
  const { shown, total } = lastLines(output, lines);
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
          ...(total > lines
            ? [
                {
                  id: 'outputLines',
                  title: all ? `Show the last ${lines} lines` : `Show all ${total} lines`,
                  keywords: ['output', 'lines', 'more', 'tool'],
                  run: () => setAll(!all),
                },
              ]
            : []),
        ],
  );
  if (output === '') {
    return (
      <section aria-label={label}>
        <p className="text-2xs text-muted-foreground">No output.</p>
      </section>
    );
  }
  const cut = !all && total > lines;
  return (
    <section aria-label={label} className="group/output relative" {...actions}>
      <pre
        data-testid="tool-output-text"
        className={cn(
          'overflow-x-auto rounded-md border border-border bg-muted/60 p-2 pr-9 font-mono text-2xs whitespace-pre-wrap',
          all && 'max-h-[60vh] overflow-y-auto',
        )}
      >
        {cut ? shown : output.replace(/\n$/, '')}
      </pre>
      <CopyButton
        text={output}
        label="Copy output"
        className="absolute top-1 right-1 bg-background/80"
      />
      {total > lines && (
        <Button size="xs" variant="ghost" className="mt-1" onClick={() => setAll(!all)}>
          {all ? `Show the last ${lines} lines` : `Show all ${total} lines`}
        </Button>
      )}
    </section>
  );
}
