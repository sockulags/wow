import {
  RunDiff,
  runFolder,
  type Project,
  type RunDiffFile,
  type Workflow,
  type WorkflowRun,
} from '@wow/contracts';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { CopyIcon, FileTextIcon, GitCompareIcon, RefreshCwIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useStore } from 'zustand';
import { useRuntime } from '@/app/runtime';
import { errorMessage } from '@/chat/data';
import { IconButton, ShortcutHint } from '@/components/hint';
import { EmptyState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { openFile } from '@/panel/viewer';
import {
  changedByStep,
  changesStore,
  emptyReason,
  fileStatusLabels,
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

function readAnswer(received: unknown): RunDiff | Error {
  const result = RunDiff.safeParse(received);
  return result.success
    ? result.data
    : new Error('The server answered in a form this app does not read.');
}

function DiffLines({ path, patch }: { readonly path: string; readonly patch: string }) {
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

function FileDiff({
  run,
  project,
  file,
  answer,
  marked,
}: {
  readonly run: WorkflowRun;
  readonly project: Project | undefined;
  readonly file: RunDiffFile;
  // The server's answer for this file, once it has come.
  readonly answer: RunDiff | Error | undefined;
  readonly marked: boolean;
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
        {marked && <Badge variant="info">This step</Badge>}
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
          <DiffLines path={file.path} patch={answer.patch} />
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
  const { connection } = useRuntime();
  const navigate = useNavigate();
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
            className="w-72 max-w-[40%] shrink-0 overflow-y-auto border-r border-border p-1.5"
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
                        {marked && <Badge variant="info">This step</Badge>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          {selected && (
            <FileDiff
              key={selected.path}
              run={run}
              project={project}
              file={selected}
              answer={patch?.path === selected.path ? patch.answer : undefined}
              marked={changedByStep(selected, step)}
            />
          )}
        </div>
      )}
    </div>
  );
}
