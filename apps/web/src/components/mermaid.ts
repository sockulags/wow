import type mermaid from 'mermaid';
import { createStore } from 'zustand';
import { safeHref } from './markdown';

// Draws a `mermaid` block (review loop spec 2). The library is large, so it loads on first use
// in its own chunk. Its strict security level turns off click handlers and scripts, but it still
// lets a diagram name pictures, styles and links. A message must not make the app fetch
// anything. The page's content security policy (index.html) is what makes that impossible: the
// library draws in the live document, so a style it applies while drawing would otherwise fetch
// before anything here sees the result. On top of that, labels are drawn as text, a diagram
// cannot set its own CSS or fonts, a diagram that names something to load (an image shape, or a
// style with `url(`) is refused before drawing, and `scrubSvg` cleans what comes back.

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

// What the library protects from a diagram's own directives by default, and what lets a diagram
// bring CSS or turn HTML labels back on.
const secure = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  'themeCSS',
  'themeVariables',
  'fontFamily',
  'altFontFamily',
  'htmlLabels',
];

const fetching = new Set([
  'img',
  'image',
  'feimage',
  'script',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'link',
]);
const linkAttributes = ['href', 'xlink:href', 'src'];
// CSS that loads something. A `url(#id)` points inside the drawing (markers, gradients).
const loadingCss = /@import|image-set\(|url\((?!\s*['"]?\s*#)/i;
// CSS escapes can spell `url` without the letters, and the library's own styles have none.
const unescaped = (css: string) => css.replaceAll('\\', '');

function scrubStyle(css: string): string {
  return unescaped(css)
    .replace(/@import[^;]*;?/gi, '')
    .replace(/(?:[\w-]*image-set|url)\((?!\s*['"]?\s*#)[^)]*\)/gi, 'none');
}

// Removes everything from a drawn diagram that would be fetched when it is shown, and makes its
// links follow the link rule of the markdown renderer: http, https and mailto open outside the
// app, anything else is not a link. Returns undefined when the text holds no drawing. `shown`
// rewrites each piece of drawn text (see `drawDiagram`); what it returns is put back as text.
export function scrubSvg(svg: string, shown?: (text: string) => string): string | undefined {
  // The same parser the page uses to show it, in a document that loads nothing.
  const drawing = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg');
  if (!drawing) return undefined;
  for (const element of [drawing, ...drawing.querySelectorAll('*')]) {
    const tag = element.localName.toLowerCase();
    if (fetching.has(tag)) {
      element.remove();
      continue;
    }
    if (tag === 'style') {
      element.textContent = scrubStyle(element.textContent ?? '');
      continue;
    }
    for (const { name, value } of Array.from(element.attributes)) {
      if (name.toLowerCase().startsWith('on') || loadingCss.test(unescaped(value))) {
        element.removeAttribute(name);
      }
    }
    const target = linkAttributes
      .map((name) => element.getAttribute(name))
      .find((value) => value !== null);
    if (target === undefined || target === null || target.trim().startsWith('#')) continue;
    for (const name of linkAttributes) element.removeAttribute(name);
    const safe = tag === 'a' ? safeHref(target) : undefined;
    if (safe !== undefined) {
      element.setAttribute('href', safe);
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noreferrer');
    }
  }
  if (shown) {
    const texts = drawing.ownerDocument.createTreeWalker(drawing, NodeFilter.SHOW_TEXT);
    while (texts.nextNode()) {
      const text = texts.currentNode;
      if (text.parentElement?.localName.toLowerCase() === 'style') continue;
      const next = shown(text.nodeValue ?? '');
      if (next !== text.nodeValue) text.nodeValue = next;
    }
  }
  return drawing.outerHTML;
}

const hasImage = (vertex: unknown): boolean =>
  typeof vertex === 'object' && vertex !== null && 'img' in vertex && Boolean(vertex.img);

// A flowchart's image shape, read from the parsed diagram and not from its text, because the
// shape data is YAML and can spell the same key and address in many ways.
function hasImageShape(db: object): boolean {
  if (!('getVertices' in db) || typeof db.getVertices !== 'function') return false;
  const vertices: unknown = db.getVertices();
  return vertices instanceof Map && [...vertices.values()].some(hasImage);
}

// `shown` lets a caller that writes the source itself use stand-ins for characters the diagram
// language cannot carry in a label, and put the real ones back in the drawn text.
export async function drawDiagram(
  source: string,
  dark: boolean,
  shown?: (text: string) => string,
): Promise<Drawing> {
  const id = `wow-diagram-${(drawn += 1)}`;
  try {
    const library = await loadMermaid();
    library.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      secure,
    });
    // Any diagram type can carry CSS in a `classDef` or `style` line, so the text is checked
    // and not each type's parsed form. A label that spells `url(` is refused with it.
    if (loadingCss.test(unescaped(source)))
      return { reason: 'Styles that load something are not drawn' };
    const diagram = await library.mermaidAPI.getDiagramFromText(source);
    if (hasImageShape(diagram.db)) return { reason: 'Image shapes are not drawn' };
    const { svg } = await library.render(id, source);
    const scrubbed = scrubSvg(svg, shown);
    return scrubbed === undefined ? { reason: oneLine('') } : { svg: scrubbed };
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
