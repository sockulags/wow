import { diffCounts } from '@wow/contracts';
import { FilePenIcon, FileTextIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { DiffLines } from '@/workflows/changes-tab';
import type { ItemContext } from '../items';
import { isAbsolutePath, shownPath, type ToolPayload } from './facts';
import type { ToolParts } from './row';
import { ToolTime } from './time';

// An edit (agent workbench spec 33): "Edit src/timer.ts +4 −1"; open, its diff in colour with
// Open file. The diff is wow's own field, made by the adapter; a call stored before has none and
// shows its counts as nothing and its output as before.

export interface DiffPart {
  // The file a part is about, when the diff names several (`--- a/x`, `+++ b/x` before them).
  readonly path: string | undefined;
  readonly hunks: string;
}

const headerPath = (line: string): string | undefined => {
  const named = line.slice(4).trim();
  if (named === '/dev/null') return undefined;
  return named.replace(/^[ab]\//, '');
};

// Splits a diff into its files. A diff of one file has no headers and is one part.
export function diffParts(diff: string): DiffPart[] {
  const lines = diff.split('\n');
  const parts: { path: string | undefined; lines: string[] }[] = [];
  let current: { path: string | undefined; lines: string[] } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const next = lines[index + 1] ?? '';
    if (
      line.startsWith('--- ') &&
      next.startsWith('+++ ') &&
      (lines[index + 2] ?? '').startsWith('@@ ')
    ) {
      current = { path: headerPath(next) ?? headerPath(line), lines: [] };
      parts.push(current);
      index += 1;
      continue;
    }
    if (!current) {
      current = { path: undefined, lines: [] };
      parts.push(current);
    }
    current.lines.push(line);
  }
  return parts
    .map((part) => ({ path: part.path, hunks: part.lines.join('\n') }))
    .filter((part) => part.hunks.trim() !== '');
}

// The server counts the whole diff before cutting it; a row stored before that counts what it has.
export const editCounts = (
  diff: string | undefined,
  whole?: { readonly added: number; readonly removed: number },
): string | undefined => {
  if (diff === undefined) return undefined;
  const { added, removed } = whole ?? diffCounts(diff);
  return `+${added} −${removed}`;
};

// The diff of an edit, as a row and an approval card show it.
export function EditDiff({
  diff,
  path,
  cut,
  withoutFile,
  onOpenFile,
}: {
  readonly diff: string;
  readonly path: string | undefined;
  readonly cut?: boolean | undefined;
  // The diff is only the content the edit writes (`ToolFacts.diffWithoutFile`).
  readonly withoutFile?: boolean | undefined;
  // Opens the file; absent where nothing can open it.
  readonly onOpenFile?: ((path: string) => void) | undefined;
}) {
  const parts = diffParts(diff);
  return (
    <div data-testid="edit-diff" className="flex flex-col gap-2">
      {parts.map((part, index) => {
        const file = part.path ?? path;
        const open = file !== undefined && !isAbsolutePath(file) ? onOpenFile : undefined;
        return (
          // A diff's parts are never reordered.
          <div key={index} className="flex flex-col gap-1">
            {(parts.length > 1 || open) && file !== undefined && (
              <div className="flex items-center gap-2">
                <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">
                  {file}
                </span>
                {open && (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    className="ml-auto"
                    onClick={() => open(file)}
                  >
                    <FileTextIcon aria-hidden />
                    Open file
                  </Button>
                )}
              </div>
            )}
            <div className="max-h-80 overflow-auto rounded border border-border">
              <DiffLines path={file ?? 'the edit'} patch={part.hunks} />
            </div>
          </div>
        );
      })}
      {withoutFile && (
        <p data-testid="edit-without-file" className="text-2xs text-muted-foreground">
          The new content only; the file's current content is not shown.
        </p>
      )}
      {cut && (
        <p className="text-2xs text-muted-foreground">
          The diff is longer than this row shows; the thread's Changes have all of it.
        </p>
      )}
    </div>
  );
}

export function editParts(
  payload: ToolPayload,
  context: ItemContext,
  extra?: ReactNode,
): ToolParts {
  const target = payload.path === undefined ? undefined : shownPath(payload.path, context.cwd);
  const counts = editCounts(payload.diff, payload.diffCounts);
  return {
    line: (
      <>
        <FilePenIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span data-testid="tool-line" className="min-w-0 truncate">
          Edit{' '}
          <span className="font-mono">{target ?? (payload.diff ? 'files' : payload.name)}</span>
        </span>
        {counts !== undefined && (
          <span data-testid="edit-counts" className="shrink-0 font-mono tabular-nums">
            <span className="text-state-done">{counts.split(' ')[0]}</span>{' '}
            <span className="text-state-failed">{counts.split(' ')[1]}</span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {extra}
          <ToolTime payload={payload} context={context} />
        </span>
      </>
    ),
    body: () =>
      payload.diff === undefined ? (
        <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-2xs whitespace-pre-wrap">
          {payload.output}
        </pre>
      ) : (
        <EditDiff
          diff={payload.diff}
          path={target}
          cut={payload.diffCut}
          withoutFile={payload.diffWithoutFile}
          // A running edit may still wait for its approval and a failed or denied one changed
          // nothing; the file is in Changes once made.
          onOpenFile={payload.status === 'ok' ? context.openFile : undefined}
        />
      ),
  };
}
