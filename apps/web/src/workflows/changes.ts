import type { DiffFileStatus, RunDiffFile } from '@wow/contracts';
import { formatBytes } from '@/panel/viewer';

// The words and diff rows a thread's Changes (agent workbench spec 34) reads its files with.

export const fileStatusLabels: Readonly<Record<DiffFileStatus, string>> = {
  added: 'Added',
  modified: 'Changed',
  renamed: 'Renamed',
  deleted: 'Deleted',
};

export const fileStatusLetters: Readonly<Record<DiffFileStatus, string>> = {
  added: 'A',
  modified: 'M',
  renamed: 'R',
  deleted: 'D',
};

const sizeOf = (file: RunDiffFile) => (file.size === null ? '' : ` · ${formatBytes(file.size)}`);

// What stands in for the lines of a file that shows status and size only (spec 12).
export function unshownReason(file: RunDiffFile): string | undefined {
  if (file.content === 'binary') return `Binary file${sizeOf(file)}`;
  if (file.content === 'tooLarge') return `Too large to show${sizeOf(file)}`;
  return undefined;
}

export const lineChanges = (file: RunDiffFile): string =>
  unshownReason(file) ?? `+${file.added ?? 0} −${file.removed ?? 0}`;

export interface DiffLine {
  readonly kind: 'hunk' | 'add' | 'remove' | 'context' | 'note';
  readonly text: string;
  // Line numbers in the base and in the folder; absent on the side a line is not on.
  readonly oldNumber?: number;
  readonly newNumber?: number;
}

// Reads a unified diff from its first hunk on into rows with their line numbers.
export function parsePatch(patch: string): DiffLine[] {
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const rows: DiffLine[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldNumber = Number(hunk[1]);
      newNumber = Number(hunk[2]);
      rows.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1), newNumber });
      newNumber += 1;
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'remove', text: line.slice(1), oldNumber });
      oldNumber += 1;
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'note', text: line.slice(2) });
    } else {
      rows.push({ kind: 'context', text: line.slice(1), oldNumber, newNumber });
      oldNumber += 1;
      newNumber += 1;
    }
  }
  return rows;
}

// A comment on a diff line (agent workbench spec 80) goes into the message as
// `src/bell.ts:12 – text`, one per line. A removed line's number is the base's, so the comment
// says so; otherwise it reads as today's line.
export const lineComment = (path: string, line: number, text: string, removed = false): string =>
  `${path}:${line}${removed ? ' (removed)' : ''} – ${text}`;
