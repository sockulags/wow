import type mermaid from 'mermaid';
import { createStore } from 'zustand';

// Draws a `mermaid` block (review loop spec 2). The library is large, so it loads on first use
// in its own chunk. Its strict security level turns off click handlers and HTML labels and
// sanitizes the SVG it returns.

type Mermaid = typeof mermaid;

let loading: Promise<Mermaid> | undefined;
let drawn = 0;

function loadMermaid(): Promise<Mermaid> {
  loading ??= import('mermaid').then(
    (module) => module.default,
    (error: unknown) => {
      // A failed download is tried again by the next diagram.
      loading = undefined;
      throw error;
    },
  );
  return loading;
}

export type Drawing = { readonly svg: string } | { readonly reason: string };

function oneLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split('\n').find((part) => part.trim() !== '') ?? '';
  return line.trim().replace(/:$/, '') || 'The diagram could not be drawn';
}

export async function drawDiagram(source: string, dark: boolean): Promise<Drawing> {
  const id = `wow-diagram-${(drawn += 1)}`;
  try {
    const library = await loadMermaid();
    library.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
    });
    await library.parse(source);
    const { svg } = await library.render(id, source);
    return { svg };
  } catch (error) {
    return { reason: oneLine(error) };
  } finally {
    // A failed render leaves its scratch element in the page.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

// Whether diagrams show their source, for all of them at once (the palette command). A diagram's
// own Source switch overrides it for that diagram.
export const diagramView = createStore<{ readonly source: boolean }>(() => ({ source: false }));

export const toggleDiagramSource = () =>
  diagramView.setState((state) => ({ source: !state.source }));
