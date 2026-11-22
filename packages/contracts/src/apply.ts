import { z } from 'zod';

// Apply a chat thread's changes to its project folder (parallel threads spec 1 to 10). A thread
// with its own working copy writes what it changed into the project's own folder, file by file,
// on the user's click after a confirm. Nothing is committed, staged or merged as history; the
// assistant has no tool for it.

const Id = z.string().min(1);
const Timestamp = z.iso.datetime({ offset: true });
const RelativePath = z.string().min(1).max(4096);

// How the thread changed the file since its copy's start commit.
export const ApplyChange = z.enum(['added', 'modified', 'deleted']);
export type ApplyChange = z.infer<typeof ApplyChange>;

// What Apply does with it (spec 3): write the thread's version, delete it, write the merge of
// both sides, nothing (the folder already has the thread's version), or leave it for the user.
export const ApplyOutcome = z.enum(['write', 'delete', 'merge', 'same', 'left']);
export type ApplyOutcome = z.infer<typeof ApplyOutcome>;

// Why a file is left for the user: both changed it and Git found a conflict; the project folder
// deleted what the thread changed, or the thread deleted what the folder changed; both changed a
// binary file; a side is larger than `chat.snapshotMaxFileBytes`; a side is a link; or a path wow
// does not write (`..`, `.git`, a folder on the way that is a link).
export const ApplyLeftReason = z.enum([
  'conflict',
  'deletedHere',
  'deletedThere',
  'binary',
  'tooLarge',
  'link',
  'unsafe',
]);
export type ApplyLeftReason = z.infer<typeof ApplyLeftReason>;

export const ApplyFile = z.object({
  path: RelativePath,
  change: ApplyChange,
  outcome: ApplyOutcome,
  reason: ApplyLeftReason.nullable(),
});
export type ApplyFile = z.infer<typeof ApplyFile>;

// `ok`: Apply can go; `nothing`: the folder already has every change. Anything else is why not,
// with `message` in words (spec 5).
export const ApplyStatus = z.enum([
  'ok',
  'nothing',
  'notChat',
  'noWorkingCopy',
  'turnRunning',
  'projectBusy',
  'folderMissing',
  'noRepository',
  'gitUnavailable',
  'failed',
]);
export type ApplyStatus = z.infer<typeof ApplyStatus>;

// The answer of `threads.applyPreview`, read at that moment; nothing is written. Paths are
// relative to both folders, with forward slashes.
export const ApplyPreview = z.object({
  status: ApplyStatus,
  message: z.string().nullable(),
  projectFolder: z.string().nullable(),
  // The copy's start commit, short.
  base: z.string().nullable(),
  files: z.array(ApplyFile),
});
export type ApplyPreview = z.infer<typeof ApplyPreview>;

// The paths the confirm showed per kind; `write` holds writes and deletes. The server applies
// only when it finds the same lists (spec 6).
export const ApplyConfirmed = z.object({
  write: z.array(RelativePath),
  merge: z.array(RelativePath),
  left: z.array(RelativePath),
});
export type ApplyConfirmed = z.infer<typeof ApplyConfirmed>;

export const applyConfirmedOf = (preview: ApplyPreview): ApplyConfirmed => ({
  write: preview.files
    .filter((file) => file.outcome === 'write' || file.outcome === 'delete')
    .map((file) => file.path),
  merge: preview.files.filter((file) => file.outcome === 'merge').map((file) => file.path),
  left: preview.files.filter((file) => file.outcome === 'left').map((file) => file.path),
});

// The `changes_applied` line (spec 8): what Apply wrote into `projectFolder`, or, with `undoOf`,
// what Undo put back. `undoneBy` is set on an apply once undone.
export const ChangesAppliedItemPayload = z.object({
  projectFolder: z.string().min(1),
  base: z.string().nullable(),
  written: z.array(RelativePath),
  merged: z.array(RelativePath),
  removed: z.array(RelativePath),
  left: z.array(z.object({ path: RelativePath, reason: z.string().min(1) })),
  failed: z.array(z.object({ path: RelativePath, message: z.string() })),
  // Where wow keeps the files as they were before and after, for Undo: a name in its own store,
  // never a path. Absent on an undo line.
  savedAs: z
    .string()
    .regex(/^[0-9]+-[0-9a-f]{40}$/)
    .optional(),
  undoOf: Id.optional(),
  undoneBy: Id.optional(),
  at: Timestamp,
});
export type ChangesAppliedItemPayload = z.infer<typeof ChangesAppliedItemPayload>;

// Whether Undo is offered on an apply line (spec 9): the thread's newest apply, not an undo and
// not undone. The server refuses it, with the reason, once its saved copies were dropped.
export function undoableApply(
  item: { readonly id: string; readonly payload: unknown },
  newestApplyId: string | undefined,
): boolean {
  const parsed = ChangesAppliedItemPayload.safeParse(item.payload);
  if (!parsed.success) return false;
  return (
    newestApplyId === item.id &&
    parsed.data.undoOf === undefined &&
    parsed.data.undoneBy === undefined
  );
}

// The words for a left file's reason, shared by the confirm, the line and the export.
export const applyLeftWords: Record<ApplyLeftReason, string> = {
  conflict: 'both changed the same lines',
  deletedHere: 'deleted in the project folder, changed in the thread',
  deletedThere: 'deleted in the thread, changed in the project folder',
  binary: 'both changed a binary file',
  tooLarge: 'larger than "Largest file in a snapshot"',
  link: 'a link',
  unsafe: 'a path wow does not write',
};
