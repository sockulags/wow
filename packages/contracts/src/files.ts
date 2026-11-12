import { z } from 'zod';

const FilePath = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0'), 'A path cannot hold a NUL character');

// Whose folders a file is read from or listed in (agent workbench Interface): a run (its working
// folder, then the project folder), a chat or step thread (its folder, then its project's
// folder) or a project (its folder). Files outside those folders are never read.
const RunScope = z.object({ runId: z.string().min(1) });
const ThreadScope = z.object({ threadId: z.string().min(1) });
const ProjectScope = z.object({ projectId: z.string().min(1) });
export const FileScope = z.union([RunScope, ThreadScope, ProjectScope]);
export type FileScope = z.infer<typeof FileScope>;

// One file for the viewer in the side panel (review loop spec 6 to 8, agent workbench spec 15,
// 16). The path is relative to the scope's first folder, or to a later one, or absolute inside
// one of them.
export const FileReadParams = z.union([
  RunScope.extend({ path: FilePath }),
  ThreadScope.extend({ path: FilePath }),
  ProjectScope.extend({ path: FilePath }),
]);
export type FileReadParams = z.infer<typeof FileReadParams>;

// "Open in editor" (agent workbench spec 81): the server runs the command the
// `viewer.editorCommand` setting names with the file's full path and line. Only a file or folder
// inside the scope's folders is opened, by the same rules as `files.read`.
const EditorPlace = {
  path: FilePath,
  line: z.number().int().min(1).optional(),
};
export const FileOpenInEditorParams = z.union([
  RunScope.extend(EditorPlace),
  ThreadScope.extend(EditorPlace),
  ProjectScope.extend(EditorPlace),
]);
export type FileOpenInEditorParams = z.infer<typeof FileOpenInEditorParams>;

// The full path the editor was given.
export const FileOpenInEditorResult = z.object({ path: z.string().min(1) });
export type FileOpenInEditorResult = z.infer<typeof FileOpenInEditorResult>;

// The files of the scope's first folder for "Open file…" and `@` (agent workbench spec 18, 56):
// what Git tracks plus the untracked files it does not ignore, or a bounded walk where the folder
// is not in Git. Paths are relative with forward slashes; at most `viewer.fileListLimit` of them.
export const FileListParams = FileScope;
export type FileListParams = z.infer<typeof FileListParams>;

export const FileListResult = z.object({
  files: z.array(z.string().min(1)),
  source: z.enum(['git', 'walk']),
  // More files were there than the limit lets through.
  truncated: z.boolean(),
});
export type FileListResult = z.infer<typeof FileListResult>;

// Why a file was not read. The server reads nothing in these cases; `message` says it in words.
export const FileRefusal = z.enum([
  'outside',
  'missing',
  'not_a_file',
  'unreadable',
  'binary',
  'too_large',
]);
export type FileRefusal = z.infer<typeof FileRefusal>;

export const FileTextKind = z.enum(['markdown', 'html', 'text']);
export type FileTextKind = z.infer<typeof FileTextKind>;

export const ImageMediaType = z.enum([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);
export type ImageMediaType = z.infer<typeof ImageMediaType>;

const read = {
  // The file's full path after resolving symbolic links, for "Copy path".
  absolutePath: z.string().min(1),
  size: z.number().int().nonnegative(),
};

export const FileReadResult = z.discriminatedUnion('kind', [
  z.object({ kind: FileTextKind, ...read, text: z.string() }),
  z.object({ kind: z.literal('image'), ...read, mediaType: ImageMediaType, base64: z.string() }),
  z.object({ kind: z.literal('refused'), reason: FileRefusal, message: z.string().min(1) }),
]);
export type FileReadResult = z.infer<typeof FileReadResult>;
