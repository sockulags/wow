import { contextPanelWidthBounds } from '@wow/contracts';
import { useRouterState } from '@tanstack/react-router';
import { PanelRightIcon, XIcon } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useConnectionState, useLayout, useRuntime, useSetting } from '@/app/runtime';
import { DisconnectedState, EmptyState } from '@/components/states';
import { IconButton } from '@/components/hint';
import { useBelow } from '@/lib/use-breakpoint';
import { cn } from '@/lib/utils';
import { BacklogPanel } from './backlog-panel';
import { CalendarPanel, useCalendarPanelTitle } from './calendar-panel';
import { FileViewer } from './file-viewer';
import { PageViewer } from './page-viewer';
import { clampPanelWidth, hasSelection, panelSelection, type PanelSelection } from './model';
import { CONTEXT_PANEL_ID, closeContextPanel, takePanelFocusRequest } from './panel-state';
import { ThreadPanel } from './thread-panel';
import { shownFile, shownPage } from './viewer';
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
// ends, so a drag is one settings write.
function ResizeHandle({
  width,
  onPreview,
  onCommit,
}: {
  readonly width: number;
  readonly onPreview: (width: number | undefined) => void;
  readonly onCommit: (width: number) => void;
}) {
  const drag = useRef<{ readonly startX: number; readonly startWidth: number }>(undefined);
  const latest = useRef(width);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width };
    latest.current = width;
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    latest.current = clampPanelWidth(start.startWidth + start.startX - event.clientX);
    onPreview(latest.current);
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = undefined;
    onCommit(latest.current);
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
              ? contextPanelWidthBounds.max
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onCommit(clampPanelWidth(next));
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize context panel"
      aria-valuenow={width}
      aria-valuemin={contextPanelWidthBounds.min}
      aria-valuemax={contextPanelWidthBounds.max}
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
  const [preview, setPreview] = useState<number>();
  const ref = useRef<HTMLElement>(null);
  const selection = panelSelection(pathname, search);
  // A file opened from this view takes the place of the conversation until "Back".
  const file = shownFile(
    useLayout((state) => state.viewer),
    pathname,
  );
  // So does a linked page.
  const page = shownPage(
    useLayout((state) => state.page),
    pathname,
  );
  const width = preview ?? storedWidth;

  // "Focus context panel" on a closed panel: take the focus once it is on screen.
  useEffect(() => {
    if (focusRequested) takePanelFocusRequest(layout);
  }, [focusRequested, layout]);

  // The preview stays until the stored width matches it, so the edge does not jump back.
  useEffect(() => {
    if (preview !== undefined && preview === storedWidth) setPreview(undefined);
  }, [preview, storedWidth]);

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
        narrow &&
          'absolute inset-y-0 right-0 z-40 max-w-[calc(100%-3rem)] border-border-strong shadow-2xl',
      )}
      onKeyDown={(event) => {
        // Over the view, Escape puts it away like a popover; docked, it stays.
        if (narrow && event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          close();
        }
      }}
    >
      <ResizeHandle
        width={width}
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
          ) : page ? (
            'Page'
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
      <div className="flex min-h-0 flex-1 flex-col">
        {file ? (
          <FileViewer key={`${file.runId}\n${file.path}`} file={file} />
        ) : page ? (
          <PageViewer key={`${page.runId}\n${page.ref}`} page={page} />
        ) : (
          <PanelBody selection={selection} />
        )}
      </div>
    </aside>
  );
}
