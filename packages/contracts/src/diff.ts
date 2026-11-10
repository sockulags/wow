import { z } from 'zod';

// What a run changed in its working folder since its base commit (review loop spec 11 to 13).
// Without `path` the answer lists the changed files; with it, the answer holds that one file and
// its unified diff, so a long list never carries every file's content.
export const RunDiffParams = z.object({
  runId: z.string().min(1),
  path: z.string().min(1).optional(),
});
export type RunDiffParams = z.infer<typeof RunDiffParams>;

// `noBase`: the run has no base commit (it started before bases were recorded, or in a
// repository without commits). `baseMissing`: the base commit is no longer in the repository.
export const RunDiffStatus = z.enum([
  'ok',
  'noBase',
  'baseMissing',
  'noRepository',
  'gitUnavailable',
  'folderMissing',
  'failed',
]);
export type RunDiffStatus = z.infer<typeof RunDiffStatus>;

export const DiffFileStatus = z.enum(['added', 'modified', 'renamed', 'deleted']);
export type DiffFileStatus = z.infer<typeof DiffFileStatus>;

// Whether the file's lines can be shown: `binary` and `tooLarge` files show status and size only.
export const DiffFileContent = z.enum(['text', 'binary', 'tooLarge']);
export type DiffFileContent = z.infer<typeof DiffFileContent>;

export const RunDiffFile = z.object({
  // Relative to the working folder, with forward slashes.
  path: z.string().min(1),
  // Where a renamed file was before.
  oldPath: z.string().min(1).nullable(),
  status: DiffFileStatus,
  content: DiffFileContent,
  // Lines added and removed; null when the content is not shown.
  added: z.number().int().nonnegative().nullable(),
  removed: z.number().int().nonnegative().nullable(),
  // The file's size in the folder, or in the base for a deleted file; null when unknown.
  size: z.number().int().nonnegative().nullable(),
  // The steps whose hashes say they changed this file, in run order.
  changedBy: z.array(z.string().min(1)),
});
export type RunDiffFile = z.infer<typeof RunDiffFile>;

export const RunDiff = z.object({
  status: RunDiffStatus,
  // Git's own words when status is `failed`, else null.
  message: z.string().nullable(),
  baseSha: z.string().nullable(),
  files: z.array(RunDiffFile),
  // Files left out because the list is longer than `diff.maxFiles`.
  omitted: z.number().int().nonnegative(),
  // The asked file's unified diff from its first hunk on. Null without `path`, and for a file
  // whose content is not shown.
  patch: z.string().nullable(),
});
export type RunDiff = z.infer<typeof RunDiff>;
