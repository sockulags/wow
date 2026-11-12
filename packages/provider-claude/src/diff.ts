import { z } from 'zod';

// Unified diffs for Claude Code's edits (agent workbench spec 33). When a call starts, only its
// input is known, so the diff is the old text as removed lines and the new text as added lines,
// without the file around them (the fallback the spec names). Once Claude Code wrote the file its
// result carries a structured patch with real line numbers, which replaces it.

const linesOf = (text: string): string[] => {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
};

const range = (start: number, count: number) =>
  count === 1 ? `${start}` : `${count === 0 ? Math.max(0, start - 1) : start},${count}`;

export function replacedHunk(oldText: string, newText: string): string {
  const removed = linesOf(oldText);
  const added = linesOf(newText);
  if (removed.length === 0 && added.length === 0) return '';
  return [
    `@@ -${range(1, removed.length)} +${range(1, added.length)} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join('\n');
}

const StructuredPatch = z.array(
  z.object({
    oldStart: z.number().int().nonnegative(),
    oldLines: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
    newLines: z.number().int().nonnegative(),
    lines: z.array(z.string()),
  }),
);

const EditResult = z.object({ structuredPatch: StructuredPatch, type: z.string().optional() });

// The diff of an Edit, MultiEdit or Write result, or undefined when it has none (a new file's
// Write may come without one; its diff from the input is already all added lines).
export function resultDiff(result: unknown): string | undefined {
  const parsed = EditResult.safeParse(result);
  if (!parsed.success || parsed.data.structuredPatch.length === 0) return undefined;
  return parsed.data.structuredPatch
    .map((hunk) =>
      [
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        ...hunk.lines,
      ].join('\n'),
    )
    .join('\n');
}

const EditInput = z.object({ old_string: z.string(), new_string: z.string() });
const MultiEditInput = z.object({ edits: z.array(EditInput) });
const WriteInput = z.object({ content: z.string() });

// The diff an edit's input describes, or undefined for an input wow cannot read.
export function inputDiff(name: string, input: unknown): string | undefined {
  switch (name) {
    case 'Edit': {
      const parsed = EditInput.safeParse(input);
      return parsed.success
        ? replacedHunk(parsed.data.old_string, parsed.data.new_string)
        : undefined;
    }
    case 'MultiEdit': {
      const parsed = MultiEditInput.safeParse(input);
      return parsed.success
        ? parsed.data.edits
            .map((edit) => replacedHunk(edit.old_string, edit.new_string))
            .filter((hunk) => hunk !== '')
            .join('\n')
        : undefined;
    }
    case 'Write': {
      const parsed = WriteInput.safeParse(input);
      return parsed.success ? replacedHunk('', parsed.data.content) : undefined;
    }
    default:
      return undefined;
  }
}
