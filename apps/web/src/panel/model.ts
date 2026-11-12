import {
  contextPanelWidthBounds,
  type CalendarItem,
  type Trigger,
  type Turn,
  type WorkflowRun,
} from '@wow/contracts';
import { useRouterState, type useRouter } from '@tanstack/react-router';
import { validateCalendarSearch } from '@/calendar/search';
import { reviewedStepIndex } from '@/workflows/model';

// What the context panel shows (owner decision F-1), read from the route: the selection is the
// URL (a thread, run, workflow or backlog item path, or the calendar's `item` search param), so a
// reload or a link shows the same panel and nothing is derived from the clock.
export type PanelSelection =
  | { readonly view: 'calendar'; readonly itemId: string | undefined }
  | { readonly view: 'chat'; readonly threadId: string | undefined }
  | { readonly view: 'run'; readonly runId: string }
  | { readonly view: 'workflow'; readonly workflowId: string }
  | { readonly view: 'workflows' }
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
  const run = /^\/workflows\/runs\/([^/]+)$/.exec(pathname)?.[1];
  if (run) return { view: 'run', runId: run };
  const workflow = /^\/workflows\/([^/]+)$/.exec(pathname)?.[1];
  if (workflow && !['new', 'runs', 'triggers'].includes(workflow)) {
    return { view: 'workflow', workflowId: workflow };
  }
  if (pathname.startsWith('/workflows')) return { view: 'workflows' };
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
    case 'run':
    case 'workflow':
      return true;
    default:
      return false;
  }
};

export interface ActiveStep {
  readonly index: number;
  readonly threadId: string | undefined;
}

// The step of a run whose thread the panel shows: at a gate the step to review (the one that just
// ended, or the one before a step that has not started), otherwise the current step, falling back
// to the last step that has a thread.
export function activeStep(run: WorkflowRun): ActiveStep | undefined {
  const reviewed = reviewedStepIndex(run);
  const step = reviewed === undefined ? undefined : run.steps[reviewed];
  if (reviewed !== undefined && step) return { index: reviewed, threadId: step.threadId };
  const current = run.steps[run.currentStep];
  if (current?.threadId !== undefined)
    return { index: run.currentStep, threadId: current.threadId };
  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const threadId = run.steps[index]?.threadId;
    if (threadId !== undefined) return { index, threadId };
  }
  return current ? { index: run.currentStep, threadId: undefined } : undefined;
}

// A card's run: the one the card row names, else its trigger's.
export function cardRun(
  card: CalendarItem,
  triggers: readonly Trigger[],
  runs: readonly WorkflowRun[],
): WorkflowRun | undefined {
  const runId =
    card.runId ?? triggers.find((trigger) => trigger.calendarItemId === card.id)?.runId ?? null;
  return runId === null ? undefined : runs.find((run) => run.id === runId);
}

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

// The run view's gate bar keeps this much room beside a panel laid over the view: its widest
// button and its padding (agent workbench spec 78).
export const gateRoom = '16rem';

// What a panel laid over the view leaves of the window. The panel is measured against the whole
// window, the run view against what is left of the sidebar (below the narrow breakpoint at most
// its 3rem rail) and the workflows list (16rem), so over a run view the panel leaves those and
// the gate's room.
export const overlayRoom = (view: PanelSelection['view']): string =>
  view === 'run' ? `3rem + 16rem + ${gateRoom}` : '3rem';

// The width the panel takes: the drag preview while the edge moves, else the stored width.
export const effectivePanelWidth = (stored: number, preview: number | undefined): number =>
  clampPanelWidth(preview ?? stored);
