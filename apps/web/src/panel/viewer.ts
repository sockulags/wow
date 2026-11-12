import { hostItemKey, type FileScope } from '@wow/contracts';
import type { SettingsStore } from '@wow/client-runtime';
import {
  DETAILS_TAB,
  type LayoutState,
  type LayoutStore,
  type PanelTab,
  type PanelTabs,
  type ViewerFile,
  type ViewerHostItem,
  type ViewerPage,
} from '@/app/runtime';
import { eventToBinding, normalizeBinding, type KeyLike } from '@/app/keybindings';
import { CONTEXT_PANEL_ID, isContextPanelShown, setContextPanelShown } from './panel-state';

// Files and pages open in tabs of the context panel (review loop spec 6, agent workbench spec 11
// to 14), beside the panel's own body. Tabs are UI state kept per route like the open dialogs:
// a thread or a run has its own, and they are there again when the view comes back. What a tab
// shows is read from the server each time it is shown.

interface ViewerContext {
  readonly settings: SettingsStore;
  readonly layout: LayoutStore;
}

const noTabs: PanelTabs = { tabs: [], selected: DETAILS_TAB, history: [] };

export const panelTabsOf = (state: Pick<LayoutState, 'panelTabs'>, route: string): PanelTabs =>
  state.panelTabs[route] ?? noTabs;

const scopeKey = (scope: FileScope): string =>
  'runId' in scope
    ? `run:${scope.runId}`
    : 'threadId' in scope
      ? `thread:${scope.threadId}`
      : `project:${scope.projectId}`;

export const fileTabId = (file: Pick<ViewerFile, 'scope' | 'path'>): string =>
  `file:${scopeKey(file.scope)}:${file.path}`;
export const pageTabId = (page: Pick<ViewerPage, 'runId' | 'ref'>): string =>
  `page:${page.runId}:${page.ref}`;
export const hostTabId = (host: Pick<ViewerHostItem, 'threadId' | 'item'>): string =>
  `host:${host.threadId}:${hostItemKey(host.item)}`;

// The short name a tab shows: the file's own name. Host items name themselves in tabs.tsx.
export const tabName = (tab: PanelTab): string =>
  tab.kind === 'file'
    ? (tab.file.path
        .split(/[\\/]/)
        .filter((part) => part !== '')
        .at(-1) ?? tab.file.path)
    : tab.kind === 'page'
      ? tab.page.ref
      : tab.host.item.id;

function updateTabs(layout: LayoutStore, route: string, change: (tabs: PanelTabs) => PanelTabs) {
  layout.setState((state) => {
    const before = panelTabsOf(state, route);
    const after = change(before);
    return after === before ? {} : { panelTabs: { ...state.panelTabs, [route]: after } };
  });
}

const choose = (tabs: PanelTabs, id: string): PanelTabs =>
  tabs.selected === id
    ? tabs
    : {
        ...tabs,
        selected: id,
        history: [...tabs.history.filter((entry) => entry !== id), tabs.selected],
      };

// Where the focus was when a tab was opened from the main view (spec 87): Escape there still
// closes the tab, as it does in the panel.
let opener: Element | undefined;
export const tabOpener = (): Element | undefined => (opener?.isConnected ? opener : undefined);

function rememberOpener(): void {
  const active = document.activeElement;
  const panel = document.getElementById(CONTEXT_PANEL_ID);
  if (active && active !== document.body && !panel?.contains(active)) opener = active;
}

// Opening an open item selects its tab (spec 11).
function openTab(context: ViewerContext, route: string, tab: PanelTab): void {
  rememberOpener();
  updateTabs(context.layout, route, (tabs) =>
    choose(
      tabs.tabs.some((entry) => entry.id === tab.id)
        ? tabs
        : { ...tabs, tabs: [...tabs.tabs, tab] },
      tab.id,
    ),
  );
  // The focus stays where it was (on the link, say), so reading goes on in the main view; Escape
  // there closes the tab again (spec 87).
  if (!isContextPanelShown(context)) setContextPanelShown(context, true);
}

// A file of a run (its artifacts) or of a thread or project. `runId` is a run's scope.
export type FileOpening = Pick<ViewerFile, 'path' | 'fullPath' | 'from'> &
  ({ readonly runId: string } | { readonly scope: FileScope });

export function openFile(context: ViewerContext, opening: FileOpening): void {
  const scope = 'scope' in opening ? opening.scope : { runId: opening.runId };
  const file: ViewerFile = {
    scope,
    path: opening.path,
    fullPath: opening.fullPath,
    from: opening.from,
    fullSize: false,
    read: undefined,
  };
  openTab(context, file.from, { kind: 'file', id: fileTabId(file), file });
}

// A linked Confluence page (review loop spec 35).
export function openPage(context: ViewerContext, page: ViewerPage): void {
  openTab(context, page.from, { kind: 'page', id: pageTabId(page), page });
}

// An item a chat links to (agent workbench spec 21), in a tab of the view it was opened from.
export function openHostItem(context: ViewerContext, host: ViewerHostItem): void {
  openTab(context, host.from, { kind: 'host', id: hostTabId(host), host });
}

export const selectedTab = (tabs: PanelTabs): PanelTab | undefined =>
  tabs.tabs.find((tab) => tab.id === tabs.selected);

export function shownPage(
  state: Pick<LayoutState, 'panelTabs'>,
  pathname: string,
): ViewerPage | undefined {
  const tab = selectedTab(panelTabsOf(state, pathname));
  return tab?.kind === 'page' ? tab.page : undefined;
}

// The file the panel shows for the view on screen, if a file tab is selected.
export function shownFile(
  state: Pick<LayoutState, 'panelTabs'>,
  pathname: string,
): ViewerFile | undefined {
  const tab = selectedTab(panelTabsOf(state, pathname));
  return tab?.kind === 'file' ? tab.file : undefined;
}

export function selectTab(layout: LayoutStore, route: string, id: string): void {
  updateTabs(layout, route, (tabs) =>
    id === DETAILS_TAB || tabs.tabs.some((tab) => tab.id === id) ? choose(tabs, id) : tabs,
  );
}

// Ctrl+Tab and Ctrl+Shift+Tab (spec 12): through Details and the tabs, round.
export function cycleTab(layout: LayoutStore, route: string, step: 1 | -1): void {
  updateTabs(layout, route, (tabs) => {
    const order = [DETAILS_TAB, ...tabs.tabs.map((tab) => tab.id)];
    if (order.length < 2) return tabs;
    const at = Math.max(0, order.indexOf(tabs.selected));
    return choose(tabs, order[(at + step + order.length) % order.length] ?? DETAILS_TAB);
  });
}

// Alt+Left (spec 12): the tab shown before, as long as it is still open.
export function backTab(layout: LayoutStore, route: string): void {
  updateTabs(layout, route, (tabs) => {
    const open = (id: string) => id === DETAILS_TAB || tabs.tabs.some((tab) => tab.id === id);
    const history = tabs.history.filter(open);
    const previous = history.at(-1);
    if (previous === undefined) return tabs;
    return { ...tabs, selected: previous, history: history.slice(0, -1) };
  });
}

// Closes a tab, the selected one by default; the tab shown before it takes its place. Details
// is not closed. The focus, if it was on something that goes away with the tab, moves to the
// panel instead of being lost.
export function closeTab(layout: LayoutStore, route: string, id?: string): void {
  const panel = document.getElementById(CONTEXT_PANEL_ID);
  const inside = panel?.contains(document.activeElement) === true;
  updateTabs(layout, route, (tabs) => {
    const closing = id ?? tabs.selected;
    if (closing === DETAILS_TAB || !tabs.tabs.some((tab) => tab.id === closing)) return tabs;
    const rest = tabs.tabs.filter((tab) => tab.id !== closing);
    const open = (entry: string) => entry === DETAILS_TAB || rest.some((tab) => tab.id === entry);
    const history = tabs.history.filter((entry) => entry !== closing && open(entry));
    if (tabs.selected !== closing) return { tabs: rest, selected: tabs.selected, history };
    return {
      tabs: rest,
      selected: history.at(-1) ?? DETAILS_TAB,
      history: history.slice(0, -1),
    };
  });
  if (inside) panel?.focus();
}

// Back to the panel's own body: the shown file or page goes away (Escape, "Back to
// conversation").
export const closeViewer = (layout: LayoutStore, route: string): void => closeTab(layout, route);

// What the server answered for an open file, so the palette's commands act on the same file
// the header's buttons do.
export function noteFileRead(
  layout: LayoutStore,
  file: ViewerFile,
  read: ViewerFile['read'],
): void {
  const id = fileTabId(file);
  updateTabs(layout, file.from, (tabs) => {
    const tab = tabs.tabs.find((entry) => entry.id === id);
    if (tab?.kind !== 'file') return tabs;
    const same =
      tab.file.read?.kind === read?.kind && tab.file.read?.absolutePath === read?.absolutePath;
    if (same) return tabs;
    return {
      ...tabs,
      tabs: tabs.tabs.map((entry) =>
        entry.id === id ? { ...tab, file: { ...tab.file, read } } : entry,
      ),
    };
  });
}

export function toggleFullSize(layout: LayoutStore, file: ViewerFile): void {
  const id = fileTabId(file);
  updateTabs(layout, file.from, (tabs) => ({
    ...tabs,
    tabs: tabs.tabs.map((entry) =>
      entry.id === id && entry.kind === 'file'
        ? { ...entry, file: { ...entry.file, fullSize: !entry.file.fullSize } }
        : entry,
    ),
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
  `<meta http-equiv="Content-Security-Policy" content="${policy}"><meta http-equiv="x-dns-prefetch-control" content="off"><base target="_blank">`;

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

// A page's rendered body as a page of its own for the no-scripts frame: the host answers a
// fragment. Pictures and anything else the page would fetch stay out (the frame's policy allows
// only data: addresses), since they need the user's Confluence session.
export function pageDocument(body: string): string {
  return frameDocument(
    `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:16px;font:14px/1.5 system-ui,sans-serif;color:#1f2328;background:#fff}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:4px 8px}pre{white-space:pre-wrap}</style></head><body>${body}</body></html>`,
  );
}

export type TabKey = 'close' | 'next' | 'previous' | 'back';

// Which panel tab key an event is (spec 12), from the keybinding settings' values.
export function tabKeyOf(
  event: KeyLike,
  bindings: Readonly<Record<TabKey, string>>,
): TabKey | undefined {
  const pressed = eventToBinding(event);
  if (!pressed) return undefined;
  return (Object.keys(bindings) as TabKey[]).find(
    (key) => bindings[key] !== '' && normalizeBinding(bindings[key]) === pressed,
  );
}

// The full path of a file named relative to `folder`, or the path itself when it is full.
export function fullPathOf(folder: string, named: string): string {
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(named)) return named;
  const windows = /^[A-Za-z]:\\/.test(folder) || folder.includes('\\');
  const separator = windows ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${separator}${named.split(/[\\/]/).join(separator)}`;
}
