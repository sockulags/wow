import { contextPanelWidthBounds, type Turn } from '@wow/contracts';
import { useRouterState, type useRouter } from '@tanstack/react-router';
import { validateCalendarSearch } from '@/calendar/search';

// What the context panel shows (owner decision F-1), read from the route: the selection is the
// URL (a thread or backlog item path, or the calendar's `item` search param), so a
// reload or a link shows the same panel and nothing is derived from the clock.
export type PanelSelection =
  | { readonly view: 'calendar'; readonly itemId: string | undefined }
  | { readonly view: 'chat'; readonly threadId: string | undefined }
  | { readonly view: 'backlog'; readonly itemId: string | undefined }
  | { readonly view: 'other' };

export function panelSelection(pathname: string, search: Record<string, unknown>): PanelSelection {
  if (pathname === '/calendar') {
    return { view: 'calendar', itemId: validateCalendarSearch(search).item };
  }
  const thread = /^\/chat(?:\/([^/]+))?\/?$/.exec(pathname);
  if (thread) {
    const id = thread[1];
    return { view: 'chat', threadId: id === undefined || id === 'new' ? undefined : id };
  }
  const item = /^\/backlog(?:\/([^/]+))?\/?$/.exec(pathname);
  if (item) {
    const id = item[1];
    return { view: 'backlog', itemId: id === undefined || id === 'new' ? undefined : id };
  }
  return { view: 'other' };
}

// What a view's panel tabs are kept under (agent workbench spec 11): its path, and in the
// calendar the selected card too, whose step thread the panel shows, so each card has its own.
export function panelRoute(pathname: string, search: Record<string, unknown>): string {
  const selection = panelSelection(pathname, search);
  return selection.view === 'calendar' && selection.itemId !== undefined
    ? `${pathname}?item=${encodeURIComponent(selection.itemId)}`
    : pathname;
}

// The route of the view on screen, read when something opens; '' where there is no router (a
// conversation drawn in a test or preview).
export const routerPanelRoute = (router: ReturnType<typeof useRouter> | undefined): string =>
  router ? panelRoute(router.state.location.pathname, router.state.location.search) : '';

export const usePanelRoute = (): string =>
  useRouterState({
    select: (state) => panelRoute(state.location.pathname, state.location.search),
  });

// Whether the selection names something; the empty state shows otherwise.
export const hasSelection = (selection: PanelSelection): boolean => {
  switch (selection.view) {
    case 'calendar':
    case 'backlog':
      return selection.itemId !== undefined;
    case 'chat':
      return selection.threadId !== undefined;
    default:
      return false;
  }
};

export interface ThreadUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly costUsd: number | undefined;
  readonly turns: number;
}

// Tokens and cost over every turn that reported them.
export function threadUsage(turns: readonly Turn[]): ThreadUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let costUsd: number | undefined;
  for (const turn of turns) {
    if (!turn.usage) continue;
    inputTokens += turn.usage.inputTokens;
    outputTokens += turn.usage.outputTokens;
    cachedInputTokens += turn.usage.cachedInputTokens;
    if (turn.usage.costUsd !== undefined) costUsd = (costUsd ?? 0) + turn.usage.costUsd;
  }
  return { inputTokens, outputTokens, cachedInputTokens, costUsd, turns: turns.length };
}

export const clampPanelWidth = (width: number): number =>
  Math.round(Math.min(contextPanelWidthBounds.max, Math.max(contextPanelWidthBounds.min, width)));

// The widest a panel laid over the view may be: the window less the thread list's 3rem rail, which
// is what the list is below the narrow breakpoint. It never goes under the panel's minimum.
export const overlayCap = (windowWidth: number, remPx: number): number =>
  Math.max(contextPanelWidthBounds.min, Math.floor(windowWidth - 3 * remPx));

// The width the panel takes: the drag preview while the edge moves, else the stored width, and
// over the view no more than the cap, so what is stored and reported is what is shown.
export const effectivePanelWidth = (
  stored: number,
  preview: number | undefined,
  cap?: number,
): number => {
  const width = clampPanelWidth(preview ?? stored);
  return cap === undefined ? width : Math.min(width, cap);
};
