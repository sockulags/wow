import { z } from 'zod';

// Restoring files when going back (thread work spec 19 to 26). wow keeps a snapshot of a chat
// thread's folder at each turn's start and end in its own Git repository; the tree's id stays on
// the server, the turns topic only says whether a turn can be restored to.

const Id = z.string().min(1);
const Timestamp = z.iso.datetime({ offset: true });
const RelativePath = z.string().min(1).max(4096);

// A file left out of a snapshot because it was larger than `chat.snapshotMaxFileBytes` when it
// was taken. A restore cannot put it back and names it.
export const OmittedFile = z.object({ path: RelativePath, size: z.number().int().min(0) });
export type OmittedFile = z.infer<typeof OmittedFile>;

// What is stored on a turn (`turns.start_snapshot`, `turns.end_snapshot`): the tree in wow's
// repository for the thread's folder, how many files it holds, the files left out, and when.
export const TurnSnapshot = z.object({
  tree: z.string().regex(/^[0-9a-f]{40,64}$/),
  files: z.number().int().min(0),
  omitted: z.array(OmittedFile),
  at: Timestamp,
});
export type TurnSnapshot = z.infer<typeof TurnSnapshot>;

// A turn whose folder was not kept, and why in words (snapshots off, not in Git, too many files,
// git out of time, dropped after `chat.snapshotKeepDays`); a restore to it is refused with it.
export const SnapshotMissing = z.object({ missing: z.string().min(1).max(1000) });
export type SnapshotMissing = z.infer<typeof SnapshotMissing>;

export const StoredSnapshot = z.union([TurnSnapshot, SnapshotMissing]);
export type StoredSnapshot = z.infer<typeof StoredSnapshot>;

export const isTurnSnapshot = (value: StoredSnapshot | null | undefined): value is TurnSnapshot =>
  value !== null && value !== undefined && 'tree' in value;

export const SnapshotAt = z.enum(['start', 'end']);
export type SnapshotAt = z.infer<typeof SnapshotAt>;

export const RestoreRefusal = z.enum([
  'noRepository',
  'gitUnavailable',
  'noSnapshot',
  'turnRunning',
  'outside',
  'notChat',
]);
export type RestoreRefusal = z.infer<typeof RestoreRefusal>;

// What the confirm showed: the files changed outside the thread and the files too large to
// restore. The server restores only when it finds the same lists (spec 22, 23).
export const RestoreConfirmed = z.object({
  outside: z.array(RelativePath),
  notRestorable: z.array(RelativePath),
});
export type RestoreConfirmed = z.infer<typeof RestoreConfirmed>;

// The answer of `threads.restorePreview`: `ok` with what the restore would do, or a refusal and
// its reason. Paths are relative to the thread's folder, with forward slashes.
// A file the restore does not touch although it differs, and why: wow holds no copy of it (too
// large), Git ignores it now, or it is neither in the snapshot nor in what the thread left, so
// wow cannot tell whose it is.
export const LeftAloneReason = z.enum(['tooLarge', 'ignoredNow', 'notFromThread']);
export type LeftAloneReason = z.infer<typeof LeftAloneReason>;
export const LeftAloneFile = z.object({ path: RelativePath, reason: LeftAloneReason });
export type LeftAloneFile = z.infer<typeof LeftAloneFile>;

export const RestorePreview = z.object({
  status: z.union([z.literal('ok'), RestoreRefusal]),
  message: z.string().nullable(),
  write: z.array(RelativePath),
  remove: z.array(RelativePath),
  outside: z.array(RelativePath),
  notRestorable: z.array(OmittedFile),
  leftAlone: z.array(LeftAloneFile),
});
export type RestorePreview = z.infer<typeof RestorePreview>;

export const RestorePreviewParams = z.union([
  z.object({ threadId: Id, turnId: Id }),
  z.object({ threadId: Id, undoItemId: Id }),
]);
export type RestorePreviewParams = z.infer<typeof RestorePreviewParams>;

// What a confirm sends back: the two lists it showed, by path.
export const confirmedOf = (preview: RestorePreview): RestoreConfirmed => ({
  outside: preview.outside,
  notRestorable: preview.notRestorable.map((file) => file.path),
});

// The `files_restored` line (spec 24): back to the start of `toTurnId`, or, with `undoOf`, back
// to how the files were before that restore. `undoneBy` is set on a restore once undone. `edit`
// marks the restore Edit's "Conversation and files" made before its turn went out: no Undo.
export const FilesRestoredItemPayload = z.object({
  toTurnId: Id,
  written: z.array(RelativePath),
  removed: z.array(RelativePath),
  failed: z.array(z.object({ path: RelativePath, message: z.string() })),
  undoOf: Id.optional(),
  undoneBy: Id.optional(),
  edit: z.boolean().optional(),
  at: Timestamp,
});
export type FilesRestoredItemPayload = z.infer<typeof FilesRestoredItemPayload>;

// Whether Undo is offered on a restore line (spec 24): the thread's newest restore, not an undo,
// not undone, not Edit's, on the thread's last turn, which is not running. A turn that starts
// after it is a new last turn, so Undo goes then.
export function undoableRestore(
  item: { readonly id: string; readonly turnId: string; readonly payload: unknown },
  newestRestoreId: string | undefined,
  lastTurn: { readonly id: string; readonly state: string } | undefined,
): boolean {
  const parsed = FilesRestoredItemPayload.safeParse(item.payload);
  if (!parsed.success) return false;
  const restore = parsed.data;
  return (
    newestRestoreId === item.id &&
    restore.undoOf === undefined &&
    restore.undoneBy === undefined &&
    restore.edit !== true &&
    lastTurn !== undefined &&
    lastTurn.id === item.turnId &&
    lastTurn.state !== 'running'
  );
}
