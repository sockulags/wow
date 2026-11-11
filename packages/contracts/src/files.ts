import { z } from 'zod';

// One file of a run, read for the viewer in the side panel (review loop spec 6 to 8). The path
// is relative to the run's working folder or the project folder, or absolute inside one of them.
export const FileReadParams = z.object({
  runId: z.string().min(1),
  path: z
    .string()
    .min(1)
    .refine((value) => !value.includes('\0'), 'A path cannot hold a NUL character'),
});
export type FileReadParams = z.infer<typeof FileReadParams>;

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
