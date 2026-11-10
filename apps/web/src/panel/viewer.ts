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
  context.layout.setState({ viewer: { ...file, fullSize: false } });
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

export function toggleFullSize(layout: LayoutStore): void {
  layout.setState(({ viewer }) => ({
    viewer: viewer ? { ...viewer, fullSize: !viewer.fullSize } : undefined,
  }));
}

// The path the server read (symbolic links resolved) when it is known, else the path as named.
export const copyFilePath = (file: ViewerFile, resolved?: string): void =>
  void navigator.clipboard?.writeText(resolved ?? file.fullPath).catch(() => {});

// The whole page an HTML file is shown as, inside a frame without an origin (spec 7). The policy
// comes first, so it holds for everything the file brings: nothing is fetched, forms go nowhere,
// and scripts run only when asked for. Links open nothing, because the frame may not open windows.
export function frameDocument(html: string, scripts: boolean): string {
  const policy = [
    "default-src 'none'",
    'img-src data:',
    'media-src data:',
    'font-src data:',
    "style-src 'unsafe-inline'",
    ...(scripts ? ["script-src 'unsafe-inline'"] : []),
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
  const head = `<meta http-equiv="Content-Security-Policy" content="${policy}"><base target="_blank">`;
  // A doctype has to stay first, or the page would be laid out in quirks mode.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? '';
  return `${doctype}${head}${html.slice(doctype.length)}`;
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
