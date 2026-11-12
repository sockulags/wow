import { z } from 'zod';

// Images pasted or dropped on a thread's composer (agent workbench spec 53 to 55, Interface).
// Each goes to the server once (`attachments.put`), is stored under wow's home in the thread's
// own folder and is named by its id afterwards: in the message, the user item, the queue and
// the draft. Only the thread's provider is handed the file.

export const AttachmentMediaType = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export type AttachmentMediaType = z.infer<typeof AttachmentMediaType>;

export const attachmentExtensions: Record<AttachmentMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

// The server picks the id: a UUID and the extension of the type it found in the bytes, so the
// id alone names the file and its type, and nothing a client sends becomes part of a path.
export const AttachmentId = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/u,
    'Not an image id wow gave out',
  );
export type AttachmentId = z.infer<typeof AttachmentId>;

export function attachmentMediaType(id: AttachmentId): AttachmentMediaType {
  const extension = id.slice(id.lastIndexOf('.') + 1);
  const found = AttachmentMediaType.options.find(
    (type) => attachmentExtensions[type] === extension,
  );
  if (!found) throw new Error(`Not an image id: ${id}`);
  return found;
}

// What the user called the image, for its chip and its alt text: a dropped file's name, or none
// for a pasted screenshot.
const AttachmentName = z.string().min(1).max(200);

// An image as a message carries it.
export const SentImage = z.object({
  id: AttachmentId,
  mediaType: AttachmentMediaType,
  name: AttachmentName.optional(),
});
export type SentImage = z.infer<typeof SentImage>;

// One image for a thread. `threadId` may name a thread that is not created yet (a new thread's
// composer picks its id before the first message); `providerInstanceId` and `model` then say
// where it will go, so a model that takes no images refuses it (spec 54). For a thread that
// exists the server reads them from the thread. `type` is what the browser said the file is; the
// server decides by the bytes and uses it only to word a refusal.
export const AttachmentPutParams = z.object({
  threadId: z.string().min(1),
  base64: z.string().min(1),
  type: z.string(),
  name: AttachmentName.optional(),
  providerInstanceId: z.string().min(1).optional(),
  model: z.string().optional(),
});
export type AttachmentPutParams = z.infer<typeof AttachmentPutParams>;

export const AttachmentPutResult = SentImage.extend({ bytes: z.number().int().positive() });
export type AttachmentPutResult = z.infer<typeof AttachmentPutResult>;

export const AttachmentReadParams = z.object({
  threadId: z.string().min(1),
  id: AttachmentId,
});
export type AttachmentReadParams = z.infer<typeof AttachmentReadParams>;

export const AttachmentReadResult = z.object({
  mediaType: AttachmentMediaType,
  base64: z.string(),
});
export type AttachmentReadResult = z.infer<typeof AttachmentReadResult>;

// The sentence for a file of another type (spec 54). `type` is what the browser said.
export function imageTypeRefusal(type: string, name?: string): string {
  const what = name ?? 'This file';
  const shown = /^image\/(x-)?(ms-)?bmp$/u.test(type)
    ? 'a BMP image'
    : type.startsWith('image/')
      ? `a ${type.slice('image/'.length).toUpperCase()} image`
      : type === ''
        ? 'not an image wow can tell'
        : `${type}, not an image`;
  return `${what} is ${shown}. Only PNG, JPEG, GIF and WebP images can be sent.`;
}

export function imageSizeRefusal(bytes: number, limit: number, name?: string): string {
  return `${name ?? 'This image'} is ${megabytes(bytes)}; images up to ${megabytes(limit)} can be sent (Settings → Chat, "Largest image").`;
}

const megabytes = (bytes: number) =>
  bytes < 1_000_000 ? `${Math.round(bytes / 1000)} KB` : `${Math.round(bytes / 100_000) / 10} MB`;
