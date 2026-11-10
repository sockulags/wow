import type { FileReadResult, FileRefusal, ImageMediaType } from '@wow/contracts';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

// Reads one file for the viewer in the side panel (review loop spec 6 to 8). The only way file
// content leaves the server: a path is read when, after resolving symbolic links, it is a
// regular file inside one of the given folders, no larger than the limit, and text or an image.

// node:path for this platform, or path.win32 / path.posix in tests of the other platform's rules.
type PathApi = Pick<typeof path, 'relative' | 'resolve' | 'isAbsolute' | 'sep' | 'extname'>;

// Whether `target` is `root` or below it. Both are full paths. On Windows `relative` compares
// without case and answers with a full path when the drives differ.
export function isInside(root: string, target: string, api: PathApi = path): boolean {
  const relative = api.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
}

// Where a requested path could be, one candidate per folder, keeping only those that stay inside
// a folder as written. Nothing on disk is touched.
export function candidatePaths(
  roots: readonly string[],
  requested: string,
  api: PathApi = path,
): string[] {
  const candidates = roots
    .map((root) => api.resolve(root, requested))
    .filter((candidate) => roots.some((root) => isInside(root, candidate, api)));
  return [...new Set(candidates)];
}

const refused = (reason: FileRefusal, message: string): FileReadResult => ({
  kind: 'refused',
  reason,
  message,
});

function readableSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 100) / 10} KB`;
  return `${Math.round(bytes / 100_000) / 10} MB`;
}

const startsWith = (bytes: Uint8Array, ...head: number[]) =>
  head.every((byte, index) => bytes[index] === byte);

// Pictures are told by their first bytes, not by their name.
function sniffImage(bytes: Uint8Array): ImageMediaType | undefined {
  if (startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (startsWith(bytes, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(bytes, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (
    startsWith(bytes, 0x52, 0x49, 0x46, 0x46) &&
    startsWith(bytes.subarray(8), 0x57, 0x45, 0x42, 0x50)
  ) {
    return 'image/webp';
  }
  return undefined;
}

// The file as text, or undefined when it is not text. Windows tools often write UTF-16 with a
// byte order mark, so that is read too.
function decodeText(bytes: Uint8Array): string | undefined {
  const encoding = startsWith(bytes, 0xff, 0xfe)
    ? 'utf-16le'
    : startsWith(bytes, 0xfe, 0xff)
      ? 'utf-16be'
      : 'utf-8';
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return text.includes('\0') ? undefined : text;
  } catch {
    return undefined;
  }
}

const markdownExtensions = new Set(['.md', '.markdown']);
const htmlExtensions = new Set(['.html', '.htm']);

export interface ReadFileRequest {
  // The run's working folder first, then the project folder. A relative path is looked for in
  // each, in this order.
  readonly roots: readonly string[];
  readonly path: string;
  readonly maxBytes: number;
}

export async function readViewerFile({
  roots,
  path: requested,
  maxBytes,
}: ReadFileRequest): Promise<FileReadResult> {
  const candidates = candidatePaths(roots, requested);
  if (candidates.length === 0) {
    return refused(
      'outside',
      `${requested} is outside the run's working folder and the project folder, so it was not read.`,
    );
  }
  const realRoots: string[] = [];
  for (const root of roots) {
    const real = await realpath(root).catch(() => undefined);
    if (real !== undefined) realRoots.push(real);
  }
  for (const candidate of candidates) {
    const real = await realpath(candidate).catch(() => undefined);
    if (real === undefined) continue;
    if (!realRoots.some((root) => isInside(root, real))) {
      return refused(
        'outside',
        `${requested} is a link to a place outside the run's working folder and the project folder, so it was not read.`,
      );
    }
    const found = await stat(real).catch(() => undefined);
    if (found === undefined) continue;
    if (!found.isFile()) return refused('not_a_file', `${requested} is a folder, not a file.`);
    if (found.size > maxBytes) {
      return refused(
        'too_large',
        `${requested} is ${readableSize(found.size)}, more than the ${readableSize(maxBytes)} the viewer reads. The "Largest file shown" setting changes that.`,
      );
    }
    const bytes = await readFile(real);
    // The file may have grown between the size check and the read.
    if (bytes.byteLength > maxBytes) {
      return refused(
        'too_large',
        `${requested} is ${readableSize(bytes.byteLength)}, more than the ${readableSize(maxBytes)} the viewer reads. The "Largest file shown" setting changes that.`,
      );
    }
    const shown = { absolutePath: real, size: bytes.byteLength };
    const image = sniffImage(bytes);
    if (image)
      return { kind: 'image', ...shown, mediaType: image, base64: bytes.toString('base64') };
    const text = decodeText(bytes);
    if (text === undefined) {
      return refused(
        'binary',
        `${requested} is a binary file and not a picture the viewer knows, so it is not shown.`,
      );
    }
    const extension = path.extname(real).toLowerCase();
    if (extension === '.svg') {
      return {
        kind: 'image',
        ...shown,
        mediaType: 'image/svg+xml',
        base64: bytes.toString('base64'),
      };
    }
    const kind = markdownExtensions.has(extension)
      ? 'markdown'
      : htmlExtensions.has(extension)
        ? 'html'
        : 'text';
    return { kind, ...shown, text: text.replace(/^﻿/, '') };
  }
  return refused('missing', `There is no file ${requested}.`);
}
