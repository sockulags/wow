import { useEffect, useState, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { Button } from '@/components/ui/button';
import { CodeBlock } from './code-block';
import { diagramView, drawDiagram, type Drawing } from './mermaid';

// A `mermaid` fence drawn in place, with a switch to its source. Until it is drawn, and when it
// cannot be drawn, the source shows as code; a failure adds one line saying why.
//
//   <MermaidDiagram source={'flowchart LR\n  a --> b'} />

function watchTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
const isDark = () => document.documentElement.classList.contains('dark');

export function MermaidDiagram({ source }: { readonly source: string }) {
  const dark = useSyncExternalStore(watchTheme, isDark);
  const everySource = useStore(diagramView, (state) => state.source);
  // This diagram's own choice holds until the palette command switches all of them again.
  const [own, setOwn] = useState<{ readonly under: boolean; readonly source: boolean }>();
  const [drawing, setDrawing] = useState<{ readonly for: string; readonly result: Drawing }>();
  const key = `${dark ? 'dark' : 'light'}\n${source}`;
  useEffect(() => {
    let live = true;
    void drawDiagram(source, dark).then((result) => live && setDrawing({ for: key, result }));
    return () => {
      live = false;
    };
  }, [source, dark, key]);

  const result = drawing?.for === key ? drawing.result : undefined;
  const code = <CodeBlock code={source} language="mermaid" className="text-xs" />;
  if (result === undefined) return <div aria-busy>{code}</div>;
  if ('reason' in result) {
    return (
      <div className="flex flex-col gap-1">
        {code}
        <p role="note" className="text-xs text-muted-foreground">
          Diagram not drawn: {result.reason}
        </p>
      </div>
    );
  }
  const showSource = own?.under === everySource ? own.source : everySource;
  return (
    <figure className="flex flex-col gap-1 rounded-md border border-border p-2">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-pressed={showSource}
          onClick={() => setOwn({ under: everySource, source: !showSource })}
        >
          Source
        </Button>
      </div>
      {showSource ? (
        code
      ) : (
        <div
          role="img"
          aria-label="Diagram"
          className="wow-diagram overflow-x-auto"
          // oxlint-disable-next-line react/no-danger -- drawDiagram scrubs the SVG (scrubSvg).
          dangerouslySetInnerHTML={{ __html: result.svg }}
        />
      )}
    </figure>
  );
}
