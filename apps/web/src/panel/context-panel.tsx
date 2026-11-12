import { contextPanelWidthBounds } from '@wow/contracts';
import { settingValue } from '@wow/client-runtime';
import { useRouterState } from '@tanstack/react-router';
import { PanelRightIcon, XIcon } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { useConnectionState, useLayout, useRuntime, useSetting } from '@/app/runtime';
import { useTopic } from '@/chat/data';
import { DisconnectedState, EmptyState } from '@/components/states';
import { IconButton } from '@/components/hint';
import { useBelow } from '@/lib/use-breakpoint';
import { cn } from '@/lib/utils';
import { ThreadChanges } from '@/chat/thread-changes';
import { ToolsTab } from './tools-tab';
import { BacklogPanel } from './backlog-panel';
import { CalendarPanel, useCalendarPanelTitle } from './calendar-panel';
import { FileViewer } from './file-viewer';
import { HostTab } from './host-tab';
import { PageViewer } from './page-viewer';
import {
  effectivePanelWidth,
  hasSelection,
  panelRoute,
  panelSelection,
  type PanelSelection,
} from './model';
import {
  CONTEXT_PANEL_ID,
  closeContextPanel,
  takePanelFocusRequest,
  useShownPanelWidth,
} from './panel-state';
import { ThreadPanel } from './thread-panel';
import { PanelTabStrip } from './tabs';
import {
  backTab,
  closeTab,
  closeViewer,
  cycleTab,
  panelTabsOf,
  selectedTab,
  tabKeyOf,
  tabOpener,
} from './viewer';
import { RunPanel, WorkflowPanel } from './workflow-panel';

// What the empty panel says it would show, per view.
const emptyText: Readonly<Record<PanelSelection['view'], string>> = {
  calendar:
    'Select a card to see its details and its workflow thread, or a meeting for its details.',
  chat: 'Open a thread to see its provider, model, usage and the run it belongs to.',
  run: '',
  workflow: '',
  workflows: 'Open a workflow for a summary of its steps and runs, or a run for its live step.',
  backlog: 'Open an item to see where it is planned, its runs and its published issue.',
  other: 'The calendar, chat, workflows and backlog show what you select here.',
};

const titles: Readonly<Record<PanelSelection['view'], string>> = {
  calendar: 'Calendar',
  chat: 'Thread details',
  run: 'Run',
  workflow: 'Workflow',
  workflows: 'Workflows',
  backlog: 'Backlog item',
  other: 'Context',
};

// What the panel's own body is called in its tab strip (agent workbench spec 11, 14).
export const baseTabLabel = (selection: PanelSelection): string =>
  selection.view === 'run'
    ? 'Conversation'
    : selection.view === 'chat'
      ? 'Details'
      : titles[selection.view];

const typing = (element: Element | null): boolean =>
  element instanceof HTMLElement &&
  (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName));

// Keyboard resizing moves the edge this far per arrow press, and more with Shift.
const KEY_STEP = 16;

function PanelBody({ selection }: { readonly selection: PanelSelection }) {
  const { configured } = useConnectionState();
  if (!hasSelection(selection)) {
    return (
      <EmptyState compact icon={PanelRightIcon} title="Nothing selected">
        {emptyText[selection.view]}
      </EmptyState>
    );
  }
  if (!configured) return <DisconnectedState compact offline />;
  switch (selection.view) {
    case 'calendar':
      return selection.itemId ? <CalendarPanel itemId={selection.itemId} /> : null;
    case 'chat':
      return selection.threadId ? <ThreadPanel threadId={selection.threadId} /> : null;
    case 'run':
      return <RunPanel runId={selection.runId} />;
    case 'workflow':
      return <WorkflowPanel workflowId={selection.workflowId} />;
    case 'backlog':
      return selection.itemId ? <BacklogPanel itemId={selection.itemId} /> : null;
    default:
      return null;
  }
}

function CalendarTitle({ itemId }: { readonly itemId: string }) {
  return <>{useCalendarPanelTitle(itemId)}</>;
}

// The left edge: drag it, or focus it and use the arrow keys. The width is stored when the drag
// ends, so a drag is one settings write. Over the view it moves within the cap, so the width
// stored is the one shown.
function ResizeHandle({
  width,
  cap,
  onPreview,
  onCommit,
}: {
  readonly width: number;
  readonly cap: number | undefined;
  readonly onPreview: (width: number | undefined) => void;
  readonly onCommit: (width: number) => void;
}) {
  const drag = useRef<{ readonly startX: number; readonly startWidth: number; moved: boolean }>(
    undefined,
  );
  const latest = useRef(width);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width, moved: false };
    latest.current = width;
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    start.moved = true;
    latest.current = effectivePanelWidth(
      start.startWidth + start.startX - event.clientX,
      undefined,
      cap,
    );
    onPreview(latest.current);
  };
  const onPointerUp = () => {
    const start = drag.current;
    if (!start) return;
    drag.current = undefined;
    // A click without a move would store the capped width over a wider stored one.
    if (start.moved) onCommit(latest.current);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    const next =
      event.key === 'ArrowLeft'
        ? width + step
        : event.key === 'ArrowRight'
          ? width - step
          : event.key === 'Home'
            ? contextPanelWidthBounds.min
            : event.key === 'End'
              ? (cap ?? contextPanelWidthBounds.max)
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onCommit(effectivePanelWidth(next, undefined, cap));
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize context panel"
      aria-valuenow={width}
      aria-valuemin={contextPanelWidthBounds.min}
      aria-valuemax={cap ?? contextPanelWidthBounds.max}
      tabIndex={0}
      data-testid="context-panel-resize"
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-transparent hover:after:bg-ring focus-visible:after:w-0.5 focus-visible:after:bg-ring"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        drag.current = undefined;
        onPreview(undefined);
      }}
      onKeyDown={onKeyDown}
    />
  );
}

// The right-hand context panel (owner decisions F-1, F-2): the selected thing's details and,
// for a card or run, its live step thread, next to the main view. In a narrow window it lies over
// the view instead of taking room from it.
export function ContextPanel() {
  const { settings, layout } = useRuntime();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const search = useRouterState({ select: (state) => state.location.search });
  const storedWidth = useSetting('appearance.contextPanelWidth');
  const focusRequested = useLayout((state) => state.contextPanelFocus);
  const narrow = useBelow('narrow');
  const preview = useLayout((state) => state.contextPanelPreview);
  const setPreview = (next: number | undefined) => layout.setState({ contextPanelPreview: next });
  const ref = useRef<HTMLElement>(null);
  const selection = panelSelection(pathname, search);
  // This view's tabs (spec 11, 13): a file or page tab, when selected, takes the place of the
  // panel's own body.
  const route = panelRoute(pathname, search);
  const tabs = useLayout((state) => panelTabsOf(state, route));
  const tab = selectedTab(tabs);
  const file = tab?.kind === 'file' ? tab.file : undefined;
  const page = tab?.kind === 'page' ? tab.page : undefined;
  const hostItem = tab?.kind === 'host' ? tab.host : undefined;
  // A chat thread's Changes (agent workbench spec 34) are one of its tabs.
  const changes = tab?.kind === 'changes' ? tab.changes : undefined;
  // What the thread's session can use (thread work spec 37).
  const tools = tab?.kind === 'tools' ? tab.tools : undefined;
  const { width, cap } = useShownPanelWidth(selection.view);
  const baseLabel = baseTabLabel(selection);
  const threads = useTopic('threads');
  // A step thread's run view shows the conversation, not a thread's details.
  const backLabel =
    selection.view === 'chat' &&
    threads?.some((thread) => thread.id === selection.threadId && thread.runId === null)
      ? 'Back to details'
      : 'Back to conversation';

  // Escape closes a file or page opened from the main view also while the focus stayed on the
  // link that opened it (spec 87); in the panel the viewers take it themselves.
  useEffect(() => {
    if (!tab) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const active = document.activeElement;
      if (typing(active) || active === null || active !== tabOpener(route, tab.id)) return;
      if (active.closest('[role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      closeViewer(layout, route);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tab, layout, route]);

  // "Focus context panel" on a closed panel: take the focus once it is on screen.
  useEffect(() => {
    if (focusRequested) takePanelFocusRequest(layout);
  }, [focusRequested, layout]);

  // The preview stays until the stored width matches it, so the edge does not jump back.
  useEffect(() => {
    if (preview !== undefined && preview === storedWidth)
      layout.setState({ contextPanelPreview: undefined });
  }, [layout, preview, storedWidth]);

  const close = () => closeContextPanel({ settings, layout });

  return (
    <aside
      ref={ref}
      id={CONTEXT_PANEL_ID}
      aria-label="Context panel"
      tabIndex={-1}
      data-overlay={narrow ? '' : undefined}
      style={{ width: `min(${width}px, 100%)` }}
      className={cn(
        'relative flex shrink-0 flex-col border-l border-border bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        narrow && 'absolute inset-y-0 right-0 z-40 border-border-strong shadow-2xl',
      )}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        // The tab keys work while the focus is in the panel (spec 12).
        const { values } = settings.getState();
        const binding = (key: Parameters<typeof settingValue>[1]): string => {
          const stored = settingValue(values, key);
          return typeof stored === 'string' ? stored : '';
        };
        const key = tabKeyOf(event, {
          close: binding('keybindings.panelCloseTab'),
          next: binding('keybindings.panelNextTab'),
          previous: binding('keybindings.panelPreviousTab'),
          back: binding('keybindings.panelBackTab'),
        });
        if (key && tabs.tabs.length > 0) {
          event.preventDefault();
          if (key === 'close') closeTab(layout, route);
          else if (key === 'back') backTab(layout, route);
          else cycleTab(layout, route, key === 'next' ? 1 : -1);
          return;
        }
        // Escape on the tab strip puts the shown file or page away, as it does in the viewer.
        if (event.key === 'Escape' && tab && !typing(event.target as Element)) {
          event.preventDefault();
          closeViewer(layout, route);
          return;
        }
        // Over the view, Escape puts it away like a popover; docked, it stays.
        if (narrow && event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
    >
      <ResizeHandle
        width={width}
        cap={cap}
        onPreview={setPreview}
        onCommit={(next) => {
          setPreview(next);
          void settings.write('appearance.contextPanelWidth', next);
        }}
      />
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
        <h2 className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {file ? (
            'File'
          ) : changes ? (
            'Changes'
          ) : tools ? (
            'Session tools'
          ) : page ? (
            'Page'
          ) : hostItem ? (
            'Linked item'
          ) : selection.view === 'calendar' && selection.itemId ? (
            <CalendarTitle itemId={selection.itemId} />
          ) : (
            titles[selection.view]
          )}
        </h2>
        <IconButton
          label="Close context panel"
          shortcut="keybindings.toggleRightPanel"
          size="icon-xs"
          onClick={close}
        >
          <XIcon />
        </IconButton>
      </div>
      {tabs.tabs.length > 0 && <PanelTabStrip route={route} tabs={tabs} baseLabel={baseLabel} />}
      <div
        className="flex min-h-0 flex-1 flex-col"
        role={tabs.tabs.length > 0 ? 'tabpanel' : undefined}
        aria-label={tabs.tabs.length > 0 ? 'Panel tab' : undefined}
      >
        {file && tab ? (
          <FileViewer key={tab.id} file={file} backLabel={backLabel} />
        ) : page && tab ? (
          <PageViewer key={tab.id} page={page} />
        ) : hostItem && tab ? (
          <HostTab key={tab.id} host={hostItem} />
        ) : changes && tab ? (
          <ThreadChanges key={tab.id} changes={changes} />
        ) : tools && tab ? (
          <ToolsTab key={tab.id} tools={tools} />
        ) : (
          <PanelBody selection={selection} />
        )}
      </div>
    </aside>
  );
}
