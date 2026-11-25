import type { Thread } from '@wow/contracts';
import { dispatch, type Connection } from '@wow/client-runtime';
import { useNavigate } from '@tanstack/react-router';
import { ArchiveIcon, ArchiveRestoreIcon, PinIcon, PinOffIcon, XIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import { useRuntime } from '@/app/runtime';
import { IconButton } from '@/components/hint';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { notify, offerUndo } from '@/lib/feedback';
import { usePanelRoute } from '@/panel/model';
import { openThreadTab } from '@/panel/viewer';
import { errorMessage } from './data';
import {
  bulkLabels,
  canMarkUnread,
  commandFor,
  rowMenuActions,
  splitPicked,
  type BulkAction,
} from './row-actions';
import { isArchived, startRename, threadListStore } from './thread-commands';

// A thread row's menu, its hover buttons and the bar over picked rows (chat overview spec 13 to
// 16). Every action sends the command the palette sends for one thread.

const send = (connection: Connection | undefined, command: Parameters<typeof dispatch>[1]) =>
  connection
    ? dispatch(connection, command).catch((error: unknown) => {
        notify.error(errorMessage(error));
        throw error;
      })
    : Promise.reject(new Error('Not connected'));

export function ThreadRowMenu({
  thread,
  children,
}: {
  readonly thread: Thread;
  readonly children: ReactNode;
}) {
  const { connection, settings, layout } = useRuntime();
  const navigate = useNavigate();
  const from = usePanelRoute();
  const open = () => void navigate({ to: '/chat/$threadId', params: { threadId: thread.id } });
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid="thread-row-menu" className="w-52">
        <ContextMenuItem onSelect={open}>Open</ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            openThreadTab({ settings, layout }, { threadId: thread.id, title: thread.title, from })
          }
        >
          Open in panel
        </ContextMenuItem>
        <ContextMenuSeparator />
        {rowMenuActions(thread).map((action) => (
          <ContextMenuItem
            key={action}
            onSelect={() =>
              void send(connection, commandFor(thread, action)).catch(() => undefined)
            }
          >
            {action === 'done' ? 'Mark done' : bulkLabels[action]}
          </ContextMenuItem>
        ))}
        <ContextMenuItem
          onSelect={() => {
            open();
            startRename(thread.id);
          }}
        >
          Rename
        </ContextMenuItem>
        {canMarkUnread(thread) && (
          <ContextMenuItem
            onSelect={() =>
              void send(connection, { type: 'thread.markUnread', threadId: thread.id }).catch(
                () => undefined,
              )
            }
          >
            Mark unread
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Pin and Archive at the row's right while it is hovered or has the keyboard; they are not in the
// tab order, so the arrow keys and Tab move through the rows as before (spec 14).
export function RowButtons({ thread }: { readonly thread: Thread }) {
  const { connection } = useRuntime();
  const archived = isArchived(thread);
  const run = (action: BulkAction) =>
    void send(connection, commandFor(thread, action)).catch(() => undefined);
  return (
    <span className="pointer-events-none absolute top-1 right-1 flex gap-0.5 rounded-md bg-sidebar opacity-0 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100">
      <IconButton
        label={`${thread.pinned ? 'Unpin' : 'Pin'} ${thread.title}`}
        size="icon-xs"
        tabIndex={-1}
        data-testid="thread-row-pin"
        onClick={() => run(thread.pinned ? 'unpin' : 'pin')}
      >
        {thread.pinned ? <PinOffIcon /> : <PinIcon />}
      </IconButton>
      <IconButton
        label={`${archived ? 'Unarchive' : 'Archive'} ${thread.title}`}
        size="icon-xs"
        tabIndex={-1}
        data-testid="thread-row-archive"
        onClick={() => run(archived ? 'unarchive' : 'archive')}
      >
        {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
      </IconButton>
    </span>
  );
}

// Sends the action for every picked thread that takes it, says what was skipped, and offers Undo
// for an archive (spec 15, 16).
export async function runBulk(
  connection: Connection | undefined,
  picked: readonly Thread[],
  action: BulkAction,
): Promise<void> {
  const { taken, skipped } = splitPicked(picked, action);
  const results = await Promise.allSettled(
    taken.map((thread) => send(connection, commandFor(thread, action))),
  );
  const done = taken.filter((_, index) => results[index]?.status === 'fulfilled');
  threadListStore.setState({ picked: [], anchor: undefined });
  const label = `${bulkLabels[action]}: ${done.length} ${done.length === 1 ? 'thread' : 'threads'}`;
  const description = skipped === undefined ? undefined : `Skipped ${skipped}.`;
  if (action === 'archive' && done.length > 0) {
    offerUndo({
      message: `Archived ${done.length} ${done.length === 1 ? 'thread' : 'threads'}`,
      description,
      undo: () =>
        Promise.all(done.map((thread) => send(connection, commandFor(thread, 'unarchive')))),
      undoneMessage: 'Unarchived',
    });
    return;
  }
  notify.info(label, { description });
}

const barActions: readonly BulkAction[] = [
  'pin',
  'unpin',
  'done',
  'reopen',
  'archive',
  'unarchive',
];

export function PickedBar({ threads }: { readonly threads: readonly Thread[] }) {
  const { connection } = useRuntime();
  const pickedIds = useStore(threadListStore, (state) => state.picked);
  const picked = threads.filter((thread) => pickedIds.includes(thread.id));
  if (picked.length === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label="Picked threads"
      data-testid="picked-bar"
      className="flex shrink-0 flex-wrap items-center gap-1 border-y border-border px-2 py-1.5"
    >
      <span className="mr-auto text-2xs text-muted-foreground tabular-nums">
        {picked.length} picked
      </span>
      {barActions
        .filter((action) => splitPicked(picked, action).taken.length > 0)
        .map((action) => (
          <Button
            key={action}
            size="xs"
            variant="outline"
            onClick={() => void runBulk(connection, picked, action)}
          >
            {bulkLabels[action]}
          </Button>
        ))}
      <IconButton
        label="Clear the picked threads"
        size="icon-xs"
        onClick={() => threadListStore.setState({ picked: [], anchor: undefined })}
      >
        <XIcon />
      </IconButton>
    </div>
  );
}
