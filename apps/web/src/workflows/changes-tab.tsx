import { MessageSquarePlusIcon } from 'lucide-react';
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { useSetting } from '@/app/runtime';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useRowActions } from '@/lib/row-actions';
import { cn } from '@/lib/utils';
import { isBinding } from '@/panel/editor';
import { parsePatch, type DiffLine } from './changes';

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

// What can be done on the lines of a diff: a comment on a line (C, or the gutter), and "Open in
// editor" at a line (Shift+Enter). Without them the diff only shows.
export interface DiffLineActions {
  comment?(line: number, text: string, removed: boolean): void;
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
                        comment(line, text, row.kind === 'remove');
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
