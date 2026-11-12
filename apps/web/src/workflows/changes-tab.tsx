import {
  changesListWidthBounds,
  RunDiff,
  runFolder,
  type Project,
  type RunDiffFile,
  type Workflow,
  type WorkflowRun,
} from '@wow/contracts';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import {
  CopyIcon,
  FileTextIcon,
  GitCompareIcon,
  MessageSquarePlusIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useRuntime, useSetting } from '@/app/runtime';
import { errorMessage } from '@/chat/data';
import { IconButton, ShortcutHint, WithTooltip } from '@/components/hint';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useRowActions } from '@/lib/row-actions';
import { cn } from '@/lib/utils';
import { isBinding, OpenInEditorButton, useOpenInEditor } from '@/panel/editor';
import { openFile } from '@/panel/viewer';
import {
  changedByStep,
  changesStore,
  emptyReason,
  fileStatusLabels,
  firstChangedLine,
  fileStatusLetters,
  lineChanges,
  parsePatch,
  refreshChanges,
  stepUnderReview,
  unshownReason,
  visibleFiles,
  type DiffLine,
  type RunSearch,
} from './changes';
import { addSendBackComment, canSendBack, lineComment } from './gate';
import { artifactPath, attemptLabel } from './model';

const statusClass: Readonly<Record<RunDiffFile['status'], string>> = {
  added: 'text-state-done',
  modified: 'text-state-working',
  renamed: 'text-state-working',
  deleted: 'text-state-failed',
};

const lineClass: Readonly<Record<DiffLine['kind'], string>> = {
  hunk: 'bg-muted/60 text-muted-foreground',
  add: 'bg-state-done/15',
  remove: 'bg-state-failed/15',
  context: '',
  note: 'text-muted-foreground italic',
};

const lineSign: Readonly<Record<DiffLine['kind'], string>> = {
  hunk: '',
  add: '+',
  remove: '−',
  context: '',
  note: '',
};

// The step under review changed this file (spec 94): a small mark, its words in a tooltip.
function ThisStepMark() {
  return (
    <WithTooltip label="This step changed it">
      <span data-testid="this-step-mark" className="inline-flex items-center" tabIndex={-1}>
        <span aria-hidden className="size-1.5 rounded-full bg-state-working" />
        <span className="sr-only">This step</span>
      </span>
    </WithTooltip>
  );
}

const clampListWidth = (value: number) =>
  Math.round(Math.min(changesListWidthBounds.max, Math.max(changesListWidthBounds.min, value)));

// The edge between the file list and the diff: drag it, or focus it and use the arrow keys. The
// width is stored when the drag ends, so a drag is one settings write.
function SplitHandle({
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
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize changed files list"
      aria-valuenow={width}
      aria-valuemin={changesListWidthBounds.min}
      aria-valuemax={changesListWidthBounds.max}
      tabIndex={0}
      data-testid="changes-split"
      className="relative -mx-1 w-2 shrink-0 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-border hover:after:bg-ring focus-visible:after:w-0.5 focus-visible:after:bg-ring"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: width };
        latest.current = width;
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        latest.current = clampListWidth(start.startWidth + event.clientX - start.startX);
        onPreview(latest.current);
      }}
      onPointerUp={() => {
        if (!drag.current) return;
        drag.current = undefined;
        onCommit(latest.current);
      }}
      onPointerCancel={() => {
        drag.current = undefined;
        onPreview(undefined);
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 64 : 16;
        const next =
          event.key === 'ArrowLeft'
            ? width - step
            : event.key === 'ArrowRight'
              ? width + step
              : event.key === 'Home'
                ? changesListWidthBounds.min
                : event.key === 'End'
                  ? changesListWidthBounds.max
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        onCommit(clampListWidth(next));
      }}
    />
  );
}

function readAnswer(received: unknown): RunDiff | Error {
  const result = RunDiff.safeParse(received);
  return result.success
    ? result.data
    : new Error('The server answered in a form this app does not read.');
}

// What can be done on the lines of a diff: a comment on a line (C, or the gutter), and "Open in
// editor" at a line (Shift+Enter). Without them the diff only shows.
export interface DiffLineActions {
  comment?(line: number, text: string): void;
  openAt?(line: number): void;
}

const lineOf = (row: DiffLine): number | undefined => row.newNumber ?? row.oldNumber;

function LineComment({
  line,
  onAdd,
  onCancel,
}: {
  readonly line: number;
  readonly onAdd: (text: string) => void;
  readonly onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const id = useId();
  const add = () => {
    if (text.trim() !== '') onAdd(text.trim());
  };
  return (
    <form
      aria-label={`Comment on line ${line}`}
      className="flex flex-col gap-1.5 border-y border-border bg-background px-3 py-2 font-sans"
      onSubmit={(event) => {
        event.preventDefault();
        add();
      }}
    >
      <Label htmlFor={id} className="text-xs">
        Comment on line {line}
      </Label>
      <Textarea
        id={id}
        autoFocus
        rows={2}
        value={text}
        className="text-xs"
        placeholder="What should change here? Enter adds it."
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            add();
          }
        }}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={text.trim() === ''}>
          Add comment
        </Button>
      </div>
    </form>
  );
}

function DiffRow({
  row,
  index,
  actions,
  register,
  onWrite,
  onMove,
}: {
  readonly row: DiffLine;
  readonly index: number;
  readonly actions: DiffLineActions | undefined;
  readonly register: (index: number, element: HTMLTableRowElement | null) => void;
  readonly onWrite: (index: number) => void;
  readonly onMove: (index: number, step: 1 | -1) => boolean;
}) {
  const commentKey = useSetting('keybindings.diffComment');
  const editorKey = useSetting('keybindings.openInEditor');
  const line = lineOf(row);
  const comment = line === undefined ? undefined : actions?.comment;
  const openAt = line === undefined ? undefined : actions?.openAt;
  const onLine = line !== undefined && (comment !== undefined || openAt !== undefined);
  // The palette offers the focused line's actions, like a conversation row's (spec 80, 81).
  const { onFocus } = useRowActions(
    line === undefined
      ? []
      : [
          ...(comment
            ? [
                {
                  id: 'diffComment',
                  title: `Comment on line ${line}`,
                  keywords: ['diff', 'comment', 'note', 'send back'],
                  run: () => onWrite(index),
                },
              ]
            : []),
          ...(openAt
            ? [
                {
                  id: 'diffOpenInEditor',
                  title: `Open line ${line} in editor`,
                  keywords: ['diff', 'editor', 'code'],
                  run: () => openAt(line),
                },
              ]
            : []),
        ],
  );
  return (
    <tr
      data-kind={row.kind}
      data-line={line}
      tabIndex={onLine ? 0 : undefined}
      aria-label={onLine ? `Line ${line}: ${row.text}` : undefined}
      ref={(element) => register(index, element)}
      className={cn(
        lineClass[row.kind],
        'group',
        onLine &&
          'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
      )}
      onFocus={onLine ? onFocus : undefined}
      onKeyDown={(event) => {
        if (!onLine || event.target !== event.currentTarget || line === undefined) return;
        if (comment && isBinding(event, commentKey)) {
          event.preventDefault();
          event.stopPropagation();
          onWrite(index);
        } else if (openAt && isBinding(event, editorKey)) {
          event.preventDefault();
          event.stopPropagation();
          openAt(line);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (onMove(index, event.key === 'ArrowDown' ? 1 : -1)) event.preventDefault();
        }
      }}
    >
      {actions?.comment && (
        <td className="w-5 p-0 text-center align-middle select-none">
          {comment && (
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Comment on line ${line}`}
              title={`Comment on line ${line}`}
              className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 hover:bg-accent hover:text-foreground"
              onClick={() => onWrite(index)}
            >
              <MessageSquarePlusIcon aria-hidden className="size-3" />
            </button>
          )}
        </td>
      )}
      <td
        className="w-10 px-2 text-right text-muted-foreground tabular-nums select-none"
        onClick={comment ? () => onWrite(index) : undefined}
      >
        {row.oldNumber}
      </td>
      <td
        className="w-10 px-2 text-right text-muted-foreground tabular-nums select-none"
        onClick={comment ? () => onWrite(index) : undefined}
      >
        {row.newNumber}
      </td>
      <td aria-hidden className="w-4 text-center text-muted-foreground select-none">
        {lineSign[row.kind]}
      </td>
      <td className="pr-3 whitespace-pre">{row.text}</td>
    </tr>
  );
}

// A diff that only shows, as in a chat edit row and an approval card.
function PlainDiffLines({ path, patch }: { readonly path: string; readonly patch: string }) {
  const rows = parsePatch(patch);
  return (
    <table
      aria-label={`Diff of ${path}`}
      data-testid="diff-lines"
      className="min-w-full border-collapse font-mono text-xs"
    >
      <tbody>
        {rows.map((row, index) => (
          // A diff is never reordered, so the position is the row's identity.
          <tr key={index} data-kind={row.kind} className={lineClass[row.kind]}>
            <td className="w-10 px-2 text-right text-muted-foreground tabular-nums select-none">
              {row.oldNumber}
            </td>
            <td className="w-10 px-2 text-right text-muted-foreground tabular-nums select-none">
              {row.newNumber}
            </td>
            <td aria-hidden className="w-4 text-center text-muted-foreground select-none">
              {lineSign[row.kind]}
            </td>
            <td className="pr-3 whitespace-pre">{row.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DiffLines({
  path,
  patch,
  actions,
}: {
  readonly path: string;
  readonly patch: string;
  readonly actions?: DiffLineActions | undefined;
}) {
  return actions ? (
    <ActiveDiffLines path={path} patch={patch} actions={actions} />
  ) : (
    <PlainDiffLines path={path} patch={patch} />
  );
}

function ActiveDiffLines({
  path,
  patch,
  actions,
}: {
  readonly path: string;
  readonly patch: string;
  readonly actions: DiffLineActions;
}) {
  const rows = parsePatch(patch);
  const [writing, setWriting] = useState<number>();
  const [refocus, setRefocus] = useState<number>();
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());
  const comment = actions.comment;

  // After a comment the focus goes back to its line, so the next line is one arrow away.
  useEffect(() => {
    if (refocus === undefined) return;
    rowRefs.current.get(refocus)?.focus();
    setRefocus(undefined);
  }, [refocus]);

  const close = (index: number) => {
    setWriting(undefined);
    setRefocus(index);
  };
  const register = (index: number, element: HTMLTableRowElement | null) => {
    if (element) rowRefs.current.set(index, element);
    else rowRefs.current.delete(index);
  };
  const move = (index: number, step: 1 | -1): boolean => {
    for (let next = index + step; next >= 0 && next < rows.length; next += step) {
      const target = rowRefs.current.get(next);
      if (target && target.tabIndex === 0) {
        target.focus();
        return true;
      }
    }
    return false;
  };
  return (
    <table
      aria-label={`Diff of ${path}`}
      data-testid="diff-lines"
      className="min-w-full border-collapse font-mono text-xs"
    >
      <tbody>
        {rows.map((row, index) => {
          const line = lineOf(row);
          return (
            // A diff is never reordered, so the position is the row's identity.
            <Fragment key={index}>
              <DiffRow
                row={row}
                index={index}
                actions={actions}
                register={register}
                onWrite={setWriting}
                onMove={move}
              />
              {writing === index && comment && line !== undefined && (
                <tr>
                  <td colSpan={5} className="p-0">
                    <LineComment
                      line={line}
                      onCancel={() => close(index)}
                      onAdd={(text) => {
                        comment(line, text);
                        close(index);
                      }}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function FileDiff({
  run,
  project,
  file,
  answer,
  marked,
  actions,
}: {
  readonly run: WorkflowRun;
  readonly project: Project | undefined;
  readonly file: RunDiffFile;
  // The server's answer for this file, once it has come.
  readonly answer: RunDiff | Error | undefined;
  readonly marked: boolean;
  readonly actions: DiffLineActions;
}) {
  const { settings, layout } = useRuntime();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // The file as the server saw it when it made the diff, which may be newer than the list.
  const shown = answer instanceof Error ? file : (answer?.files[0] ?? file);
  const full = project ? artifactPath(runFolder(run, project.cwd), file.path) : file.path;
  const reason = unshownReason(shown);
  return (
    <section
      aria-label={`Changes in ${file.path}`}
      data-testid="file-diff"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1.5 text-xs">
        <span className="min-w-0 font-mono break-all">
          {shown.oldPath && <span className="text-muted-foreground">{shown.oldPath} → </span>}
          {shown.path}
        </span>
        <span className={statusClass[shown.status]}>{fileStatusLabels[shown.status]}</span>
        <span data-testid="diff-counts" className="text-muted-foreground tabular-nums">
          {lineChanges(shown)}
        </span>
        {marked && <ThisStepMark />}
        <span className="ml-auto flex items-center gap-1">
          {shown.status !== 'deleted' && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() =>
                openFile(
                  { settings, layout },
                  { runId: run.id, path: file.path, fullPath: full, from: pathname },
                )
              }
            >
              <FileTextIcon aria-hidden />
              Open file
            </Button>
          )}
          {shown.status !== 'deleted' && (
            <OpenInEditorButton
              target={{
                scope: { runId: run.id },
                path: file.path,
                line: answer instanceof Error ? undefined : firstChangedLine(answer?.patch),
              }}
              name={file.path}
            />
          )}
          <IconButton
            label={`Copy path of ${file.path}`}
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => void navigator.clipboard?.writeText(full).catch(() => {})}
          >
            <CopyIcon />
          </IconButton>
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {reason !== undefined ? (
          <p data-testid="diff-unshown" className="px-3 py-4 text-xs text-muted-foreground">
            {reason}. Its lines are not shown.
          </p>
        ) : answer instanceof Error ? (
          <p role="alert" className="px-3 py-4 text-xs text-destructive">
            {answer.message}
          </p>
        ) : answer === undefined ? (
          <div className="flex flex-col gap-1.5 p-3" aria-busy>
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        ) : answer.files.length === 0 ? (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            This file no longer differs from where the run started.
          </p>
        ) : !answer.patch ? (
          <p data-testid="diff-unshown" className="px-3 py-4 text-xs text-muted-foreground">
            {shown.status === 'renamed'
              ? 'Renamed without a changed line.'
              : 'No line differs: the file is empty or only its mode changed.'}
          </p>
        ) : (
          <DiffLines path={file.path} patch={answer.patch} actions={actions} />
        )}
      </div>
    </section>
  );
}

// The run's changes since its base: the files on the left, one file's diff on the right, and a
// switch that narrows the list to what the step under review changed.
export function ChangesTab({
  run,
  workflow,
  project,
  search,
}: {
  readonly run: WorkflowRun;
  readonly workflow: Workflow | undefined;
  readonly project: Project | undefined;
  readonly search: RunSearch;
}) {
  const { connection, settings } = useRuntime();
  const navigate = useNavigate();
  const editor = useOpenInEditor();
  const storedWidth = useSetting('appearance.changesListWidth');
  const [previewWidth, setPreviewWidth] = useState<number>();
  const listWidth = previewWidth ?? storedWidth;
  const refresh = useStore(changesStore, (state) => state.refresh);
  const switchId = useId();
  const [list, setList] = useState<RunDiff | Error>();
  const [patch, setPatch] = useState<{ readonly path: string; readonly answer: RunDiff | Error }>();
  const runId = run.id;
  // The folder is read again whenever the run moves on: a step ended or a gate was passed.
  const moment = [run.state, run.currentStep, ...run.steps.map((step) => step.endedAt ?? '')].join(
    '|',
  );

  useEffect(() => {
    if (!connection) return undefined;
    let current = true;
    connection.request('workflowRuns.diff', { runId }).then(
      (received) => {
        if (!current) return;
        const answer = readAnswer(received);
        setList(answer);
        changesStore.setState({ runId, files: answer instanceof Error ? [] : answer.files });
      },
      (failure: unknown) => {
        if (current) setList(new Error(errorMessage(failure)));
      },
    );
    return () => {
      current = false;
    };
  }, [connection, runId, moment, refresh]);

  useEffect(
    () => () => {
      changesStore.setState({ runId: undefined, files: [] });
    },
    [],
  );

  const step = stepUnderReview(run);
  const stepOnly = search.stepOnly === true;
  const files = list instanceof Error || !list ? [] : list.files;
  const visible = visibleFiles(files, step, stepOnly);
  const selected = visible.find((file) => file.path === search.file) ?? visible[0];
  const selectedPath = selected?.path;

  useEffect(() => {
    if (!connection || selectedPath === undefined) return undefined;
    let current = true;
    connection.request('workflowRuns.diff', { runId, path: selectedPath }).then(
      (received) => {
        if (current) setPatch({ path: selectedPath, answer: readAnswer(received) });
      },
      (failure: unknown) => {
        if (current) setPatch({ path: selectedPath, answer: new Error(errorMessage(failure)) });
      },
    );
    return () => {
      current = false;
    };
    // `list` is here so a file's diff is read again with every new list.
  }, [connection, runId, selectedPath, list]);

  // The preview stays until the stored width matches it, so the edge does not jump back.
  useEffect(() => {
    if (previewWidth !== undefined && previewWidth === storedWidth) setPreviewWidth(undefined);
  }, [previewWidth, storedWidth]);

  const go = (next: RunSearch) =>
    void navigate({
      to: '/workflows/runs/$runId',
      params: { runId },
      search: next,
      replace: true,
    });

  if (!connection) {
    return (
      <EmptyState icon={GitCompareIcon} title="No server">
        Changes are read by the wow server.
      </EmptyState>
    );
  }
  if (list === undefined) {
    return (
      <div className="flex flex-col gap-2 p-4" aria-busy aria-label="Reading the changes">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  if (list instanceof Error) {
    return (
      <p role="alert" className="p-4 text-xs text-destructive">
        {list.message}
      </p>
    );
  }
  if (list.status !== 'ok') {
    const reason = emptyReason(list.status, list.message);
    return (
      <EmptyState icon={GitCompareIcon} title={reason.title}>
        {reason.description}
      </EmptyState>
    );
  }

  const stepName =
    workflow?.steps.find((candidate) => candidate.id === step?.stepId)?.skillName ?? step?.stepId;
  const canMark = step?.fileHashes !== undefined;
  // After a send back or a loop the marks are what the latest attempt changed.
  const attempt = attemptLabel(step);
  const markedCount = files.filter((file) => changedByStep(file, step)).length;
  const total = files.length + list.omitted;
  const shownAnswer = patch?.path === selectedPath ? patch?.answer : undefined;
  const shownPatch = shownAnswer instanceof Error ? null : shownAnswer?.patch;
  const editorTarget = (file: RunDiffFile, line?: number) => ({
    scope: { runId },
    path: file.path,
    line: line ?? (file.path === selectedPath ? firstChangedLine(shownPatch) : undefined),
  });
  // Line comments gather in the send-back note while the run waits at a gate (spec 80).
  const commentable = canSendBack(run);
  const actionsFor = (file: RunDiffFile): DiffLineActions => ({
    ...(commentable
      ? {
          comment: (line: number, text: string) =>
            addSendBackComment(run, lineComment(file.path, line, text)),
        }
      : {}),
    openAt: (line: number) => editor.open(editorTarget(file, line)),
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-1.5 text-xs">
        <span data-testid="changes-summary" className="text-muted-foreground">
          {total === 1 ? '1 file' : `${total} files`} changed since{' '}
          <span className="font-mono">{list.baseSha?.slice(0, 7)}</span>
          {list.omitted > 0 && ` · ${list.omitted} not listed`}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Switch
            id={switchId}
            checked={stepOnly}
            disabled={!canMark}
            onCheckedChange={(checked) =>
              go({ tab: 'changes', ...(checked ? { stepOnly: true as const } : {}) })
            }
          />
          <Label htmlFor={switchId} className="text-xs font-normal">
            This step only
            {canMark && stepName !== undefined && (
              <span className="text-muted-foreground">
                {' '}
                ({[stepName, ...(attempt ? [attempt.toLowerCase()] : []), markedCount].join(', ')})
              </span>
            )}
          </Label>
          <ShortcutHint shortcut="keybindings.changesStepOnly" />
          <IconButton label="Refresh changes" size="icon-xs" onClick={refreshChanges}>
            <RefreshCwIcon />
          </IconButton>
        </span>
      </div>
      {visible.length === 0 ? (
        <EmptyState
          icon={GitCompareIcon}
          title={stepOnly ? 'Nothing from this step' : 'No changes'}
        >
          {stepOnly
            ? 'The step under review changed no file. Turn "This step only" off to see every change of the run.'
            : 'The folder is as it was when the run started.'}
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Changed files"
            style={{ width: `${listWidth}px` }}
            className="max-w-[60%] shrink-0 overflow-y-auto p-1.5"
          >
            <ul className="flex flex-col gap-0.5">
              {visible.map((file) => {
                const current = file.path === selectedPath;
                const marked = changedByStep(file, step);
                return (
                  <li key={file.path}>
                    <button
                      type="button"
                      data-testid="changed-file"
                      data-marked={marked}
                      aria-current={current ? 'true' : undefined}
                      onClick={() =>
                        go({
                          tab: 'changes',
                          file: file.path,
                          ...(stepOnly ? { stepOnly: true as const } : {}),
                        })
                      }
                      onKeyDown={(event) =>
                        file.status !== 'deleted' && editor.onKey(event, editorTarget(file))
                      }
                      className={cn(
                        'flex w-full flex-col gap-0.5 rounded-sm px-2 py-1 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                        current && 'bg-accent',
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span
                          aria-hidden
                          className={cn('w-3 shrink-0 font-mono', statusClass[file.status])}
                        >
                          {fileStatusLetters[file.status]}
                        </span>
                        <span className="sr-only">{fileStatusLabels[file.status]}:</span>
                        <span className="min-w-0 font-mono break-all">{file.path}</span>
                      </span>
                      <span className="flex items-center gap-1.5 pl-[1.125rem] text-muted-foreground">
                        <span className="tabular-nums">{lineChanges(file)}</span>
                        {marked && <ThisStepMark />}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          <SplitHandle
            width={listWidth}
            onPreview={setPreviewWidth}
            onCommit={(next) => {
              setPreviewWidth(next);
              void settings.write('appearance.changesListWidth', next);
            }}
          />
          {selected && (
            <FileDiff
              key={selected.path}
              run={run}
              project={project}
              file={selected}
              answer={patch?.path === selected.path ? patch.answer : undefined}
              marked={changedByStep(selected, step)}
              actions={actionsFor(selected)}
            />
          )}
        </div>
      )}
    </div>
  );
}
