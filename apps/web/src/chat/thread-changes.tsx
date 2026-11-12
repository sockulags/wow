import { ThreadDiff, type RunDiffFile, type RunDiffStatus, type Turn } from '@wow/contracts';
import { ArrowLeftIcon, GitCompareIcon, RefreshCwIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { createStore, useStore } from 'zustand';
import type { AppCommand } from '@/app/commands';
import { useRuntime, type LayoutStore } from '@/app/runtime';
import { IconButton, ShortcutHint } from '@/components/hint';
import { EmptyState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { setContextPanelShown } from '@/panel/panel-state';
import type { SettingsStore } from '@wow/client-runtime';
import { DiffLines } from '@/workflows/changes-tab';
import {
  fileStatusLabels,
  fileStatusLetters,
  lineChanges,
  unshownReason,
} from '@/workflows/changes';
import { errorMessage, useTopic } from './data';

// A chat thread's Changes (agent workbench spec 34, 35): what changed in its folder since its
// first turn, from the server's `threads.diff`, with "This turn only" narrowing the list to what
// changed since the last turn began. It is one view with an open function, shown in the context
// panel in place of the thread's details until Back; the panel's tabs (U5) can hold it as a tab.

interface ThreadChangesState {
  // The thread whose Changes are open in the panel, and the file shown in it.
  readonly threadId: string | undefined;
  readonly path: string | undefined;
  readonly turnOnly: boolean;
  readonly refresh: number;
}

export const threadChangesStore = createStore<ThreadChangesState>(() => ({
  threadId: undefined,
  path: undefined,
  turnOnly: false,
  refresh: 0,
}));

interface PanelContext {
  readonly settings: SettingsStore;
  readonly layout: LayoutStore;
}

export function openThreadChanges(context: PanelContext, threadId: string, path?: string): void {
  threadChangesStore.setState((state) => ({
    threadId,
    path,
    turnOnly: state.threadId === threadId ? state.turnOnly : false,
  }));
  setContextPanelShown(context, true);
}

export const closeThreadChanges = (): void =>
  threadChangesStore.setState({ threadId: undefined, path: undefined });

export const useOpenThreadChanges = (threadId: string | undefined): boolean =>
  useStore(threadChangesStore, (state) => threadId !== undefined && state.threadId === threadId);

// What a turn list changes when it matters here: a turn starts, gets its mark or ends. A turn
// starts before wow has read the folder for it, so its Changes are read again once it has.
const turnsKey = (turns: readonly Turn[]) =>
  turns.map((turn) => `${turn.id}:${turn.state}:${turn.marked === true}`).join(',');

function parsed(received: unknown): ThreadDiff {
  const result = ThreadDiff.safeParse(received);
  if (!result.success) throw new Error('The server answered in a form this app does not read.');
  return result.data;
}

// The thread's changes, read again when a turn starts, is marked or ends and when the user asks.
export function useThreadDiff(
  threadId: string,
  path?: string,
  // Off where the thread has no Changes (a step's or the assistant's thread).
  wanted = true,
): { readonly diff: ThreadDiff | undefined; readonly error: string | undefined } {
  const { connection } = useRuntime();
  const turns = useTopic('turns', threadId) ?? [];
  const refresh = useStore(threadChangesStore, (state) => state.refresh);
  const key = turnsKey(turns);
  const [answer, setAnswer] = useState<{ diff?: ThreadDiff; error?: string; for: string }>();
  const what = `${threadId}\n${path ?? ''}`;
  const asked = `${what}\n${key}\n${refresh}`;
  useEffect(() => {
    if (!connection || !wanted) return;
    let current = true;
    connection
      .request('threads.diff', path === undefined ? { threadId } : { threadId, path })
      .then(parsed)
      .then(
        (diff) => current && setAnswer({ diff, for: asked }),
        (error: unknown) => current && setAnswer({ error: errorMessage(error), for: asked }),
      );
    return () => {
      current = false;
    };
  }, [connection, threadId, path, asked, wanted]);
  // An older read of the same thread and file stays on screen until the new one comes; one for
  // another thread or file is never shown in its place.
  const shown = answer !== undefined && answer.for.startsWith(`${what}\n`) ? answer : undefined;
  return { diff: shown?.diff, error: shown?.error };
}

// "+42 −7 in 5 files"; undefined when nothing changed or there is nothing to compare.
export function changesSummary(files: readonly RunDiffFile[]): string | undefined {
  if (files.length === 0) return undefined;
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  return `+${added} −${removed} in ${files.length} ${files.length === 1 ? 'file' : 'files'}`;
}

// The header chip (spec 34): the thread's whole changes, opening its Changes.
export function ThreadChangesChip({ threadId }: { readonly threadId: string }) {
  const { settings, layout } = useRuntime();
  const { diff } = useThreadDiff(threadId);
  const summary = diff?.status === 'ok' ? changesSummary(diff.files) : undefined;
  if (summary === undefined) return null;
  return (
    <Badge asChild variant="outline" className="shrink-0 font-mono tabular-nums">
      <button
        type="button"
        data-testid="thread-changes-chip"
        aria-label={`Changes: ${summary}`}
        onClick={() => openThreadChanges({ settings, layout }, threadId)}
      >
        <GitCompareIcon aria-hidden />
        {summary}
      </button>
    </Badge>
  );
}

// Why there is nothing to list, in the user's words (spec 35).
function emptyText(status: Exclude<RunDiffStatus, 'ok'>, message: string | null) {
  switch (status) {
    case 'noRepository':
      return {
        title: 'Not a Git repository',
        description:
          "This thread's folder is not a Git repository, so wow cannot tell what changed in it.",
      };
    case 'gitUnavailable':
      return {
        title: 'Git was not found',
        description: 'Git is not on the PATH of the wow server, so wow cannot tell what changed.',
      };
    case 'folderMissing':
      return { title: 'Folder missing', description: "This thread's folder is no longer there." };
    case 'noBase':
      return {
        title: 'No starting point',
        description:
          'This thread began before wow kept where a thread starts from, or outside Git, so there is nothing to compare with. A new thread in a Git folder has its Changes.',
      };
    case 'baseMissing':
      return {
        title: 'The starting commit is gone',
        description: 'The commit this thread started from is no longer in the repository.',
      };
    case 'failed':
      return {
        title: 'Git could not compare the folder',
        description: message ?? 'Git gave no reason.',
      };
  }
}

function FilePatch({ threadId, file }: { readonly threadId: string; readonly file: RunDiffFile }) {
  const { diff, error } = useThreadDiff(threadId, file.path);
  const shown = diff?.files[0] ?? file;
  const reason = unshownReason(shown);
  if (reason !== undefined) {
    return (
      <p className="px-3 py-4 text-xs text-muted-foreground">{reason}. Its lines are not shown.</p>
    );
  }
  if (error !== undefined) {
    return (
      <p role="alert" className="px-3 py-4 text-xs text-destructive">
        {error}
      </p>
    );
  }
  if (!diff || diff.files[0]?.path !== file.path) {
    return (
      <div className="flex flex-col gap-1.5 p-3" aria-busy>
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    );
  }
  if (!diff.patch) {
    return <p className="px-3 py-4 text-xs text-muted-foreground">No line differs.</p>;
  }
  return <DiffLines path={file.path} patch={diff.patch} />;
}

export function ThreadChanges({ threadId }: { readonly threadId: string }) {
  const { diff, error } = useThreadDiff(threadId);
  const turnOnly = useStore(threadChangesStore, (state) => state.turnOnly);
  const selected = useStore(threadChangesStore, (state) => state.path);
  const switchId = useId();
  const files = diff?.status === 'ok' ? diff.files : [];
  const turnPaths = diff?.turnPaths;
  const shown =
    turnOnly && turnPaths ? files.filter((file) => turnPaths.includes(file.path)) : files;
  const open = shown.find((file) => file.path === selected) ?? shown[0];
  return (
    <section
      aria-label="Changes"
      data-testid="thread-changes"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <Button size="xs" variant="ghost" onClick={closeThreadChanges}>
          <ArrowLeftIcon aria-hidden />
          Back
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="thread-changes-summary">
          {changesSummary(files) ?? ''}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <Switch
            id={switchId}
            checked={turnOnly}
            disabled={!turnPaths}
            onCheckedChange={(checked) => threadChangesStore.setState({ turnOnly: checked })}
          />
          <Label htmlFor={switchId} className="text-xs font-normal">
            This turn only
          </Label>
          <ShortcutHint shortcut="keybindings.changesStepOnly" />
          <IconButton
            label="Read the changes again"
            size="icon-xs"
            onClick={() => threadChangesStore.setState((state) => ({ refresh: state.refresh + 1 }))}
          >
            <RefreshCwIcon />
          </IconButton>
        </span>
      </div>
      {error !== undefined ? (
        <p role="alert" className="px-3 py-4 text-xs text-destructive">
          {error}
        </p>
      ) : !diff ? (
        <div className="flex flex-col gap-1.5 p-3" aria-busy>
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ) : diff.status !== 'ok' ? (
        <EmptyState
          compact
          icon={GitCompareIcon}
          title={emptyText(diff.status, diff.message).title}
        >
          {emptyText(diff.status, diff.message).description}
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState compact icon={GitCompareIcon} title="No changes">
          {turnOnly
            ? 'Nothing changed in this folder since the last turn began.'
            : 'Nothing changed in this folder since the thread began.'}
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <ul
            aria-label="Changed files"
            className="max-h-48 shrink-0 overflow-auto border-b border-border py-1"
          >
            {shown.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  data-testid="thread-changes-file"
                  aria-current={file.path === open?.path || undefined}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-muted',
                    file.path === open?.path && 'bg-muted',
                  )}
                  onClick={() => threadChangesStore.setState({ path: file.path })}
                >
                  <span
                    aria-label={fileStatusLabels[file.status]}
                    className="w-3 shrink-0 font-mono text-muted-foreground"
                  >
                    {fileStatusLetters[file.status]}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                  <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                    {lineChanges(file)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {diff.omitted > 0 && (
            <p className="px-3 py-1 text-2xs text-muted-foreground">
              {diff.omitted} more files are not listed.
            </p>
          )}
          {open && (
            <div className="min-h-0 flex-1 overflow-auto" data-testid="thread-changes-diff">
              <FilePatch key={open.path} threadId={threadId} file={open} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// Palette commands of the open chat thread's Changes (spec 34): show and hide them, and
// "This turn only" (O) while they are open.
export function threadChangesCommands(
  threadId: string | undefined,
  open: boolean,
  turnOnly: boolean,
): AppCommand[] {
  if (threadId === undefined) return [];
  const commands: AppCommand[] = [
    {
      id: 'chat.changes',
      title: open ? 'Hide changes' : 'Show changes',
      group: 'Chat',
      keywords: ['changes', 'diff', 'files', 'git'],
      keybinding: 'keybindings.threadChanges',
      run: (context) => {
        if (open) closeThreadChanges();
        else openThreadChanges(context, threadId);
      },
    },
  ];
  if (open) {
    commands.push({
      id: 'chat.changes.turnOnly',
      title: turnOnly ? 'Changes: whole thread' : 'Changes: this turn only',
      group: 'Chat',
      keywords: ['changes', 'turn', 'only', 'narrow'],
      keybinding: 'keybindings.changesStepOnly',
      run: () => threadChangesStore.setState({ turnOnly: !turnOnly }),
    });
  }
  return commands;
}
