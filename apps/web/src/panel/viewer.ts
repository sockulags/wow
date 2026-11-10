import type { SettingsStore } from '@wow/client-runtime';
import type { LayoutStore, ViewerFile } from '@/app/runtime';
import { CONTEXT_PANEL_ID, showInContextPanel } from './panel-state';

// The file viewer is a state of the context panel (review loop spec 6, Interface): opening a file
// puts it where the conversation was, and "Back to conversation" brings that back. It is UI state
// like the open dialogs; the file itself is read from the server each time it is opened.

interface ViewerContext {
  readonly settings: SettingsStore;
  readonly layout: LayoutStore;
}

export function openFile(
  context: ViewerContext,
  file: Pick<ViewerFile, 'runId' | 'path' | 'fullPath' | 'from'>,
): void {
  context.layout.setState({ viewer: { ...file, fullSize: false, read: undefined } });
  showInContextPanel(context);
}

// The viewer's file while the view it was opened on is still the one on screen.
export const shownFile = (
  viewer: ViewerFile | undefined,
  pathname: string,
): ViewerFile | undefined => (viewer?.from === pathname ? viewer : undefined);

// Back to the conversation. The button that had the focus goes away with the viewer, so the
// focus moves to the panel instead of being lost.
export function closeViewer(layout: LayoutStore): void {
  const panel = document.getElementById(CONTEXT_PANEL_ID);
  const inside = panel?.contains(document.activeElement) === true;
  layout.setState({ viewer: undefined });
  if (inside) panel?.focus();
}

// What the server answered for the open file, so the palette's commands act on the same file
// the header's buttons do. Another file may have been opened since the read was asked.
export function noteFileRead(
  layout: LayoutStore,
  file: Pick<ViewerFile, 'runId' | 'path'>,
  read: ViewerFile['read'],
): void {
  layout.setState(({ viewer }) => {
    if (!viewer || viewer.runId !== file.runId || viewer.path !== file.path) return {};
    const same =
      viewer.read?.kind === read?.kind && viewer.read?.absolutePath === read?.absolutePath;
    return same ? {} : { viewer: { ...viewer, read } };
  });
}

export function toggleFullSize(layout: LayoutStore): void {
  layout.setState(({ viewer }) => ({
    viewer: viewer ? { ...viewer, fullSize: !viewer.fullSize } : undefined,
  }));
}

// The path the server read (symbolic links resolved) once it has answered, else the path as named.
export const copyFilePath = (file: ViewerFile): void =>
  void navigator.clipboard?.writeText(file.read?.absolutePath ?? file.fullPath).catch(() => {});

// Nothing is fetched and forms go nowhere. Without `scriptSources` nothing runs either.
const framePolicy = (scriptSources?: string): string =>
  [
    "default-src 'none'",
    'img-src data:',
    'media-src data:',
    'font-src data:',
    "style-src 'unsafe-inline'",
    ...(scriptSources === undefined ? [] : [`script-src ${scriptSources}`]),
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');

const frameHead = (policy: string): string =>
  `<meta http-equiv="Content-Security-Policy" content="${policy}"><base target="_blank">`;

// The whole page an HTML file is shown as while its scripts stay off, inside a frame without an
// origin (spec 7). The policy comes first, so it holds for everything the file brings. Links open
// nothing, because the frame may not open windows.
export function frameDocument(html: string): string {
  // A doctype has to stay first, or the page would be laid out in quirks mode.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? '';
  return `${doctype}${frameHead(framePolicy())}${html.slice(doctype.length)}`;
}

// The content policy does not govern WebRTC, and a connection could carry what the page holds
// to any address. So every script starts by taking WebRTC out of the window it runs in.
const scriptGuard =
  'for(const name of Object.getOwnPropertyNames(globalThis))if(/^(webkit|moz)?RTC/.test(name))delete globalThis[name];\n';

async function scriptSource(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

// The page of an HTML file whose scripts may run (`viewer.htmlScripts`). Allowing every inline
// script would also allow a nested frame or a `javascript:` address to start a script in a new
// window object, where the guard has not run. So the policy names each script by its hash, guard
// included: whatever window a script of the file runs in, it has closed WebRTC there first, and
// nothing else runs at all: no script in an attribute such as `onclick`, none made by another
// script. The file is parsed here without being run; if the frame reads the result differently,
// the script it finds has no hash and stays off. A `script` element of another type is data
// (JSON, say) and is left as it is.
const runs = (script: Element): boolean =>
  /^(|module|(text|application)\/(java|ecma)script)$/i.test(
    (script.getAttribute('type') ?? '').trim(),
  );

export async function scriptedFrameDocument(html: string): Promise<string> {
  if (globalThis.crypto?.subtle === undefined) return frameDocument(html);
  const page = new DOMParser().parseFromString(html, 'text/html');
  const sources: string[] = [];
  for (const script of page.querySelectorAll('script:not([src])')) {
    if (!runs(script)) continue;
    script.textContent = scriptGuard + (script.textContent ?? '');
    sources.push(await scriptSource(script.textContent));
  }
  const head = page.createElement('template');
  head.innerHTML = frameHead(framePolicy(sources.length > 0 ? sources.join(' ') : "'none'"));
  page.head.prepend(head.content);
  return `${page.doctype ? '<!doctype html>' : ''}${page.documentElement.outerHTML}`;
}

// The language to color a text file as: its extension, which the highlighter knows or ignores.
export function fileLanguage(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : undefined;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
