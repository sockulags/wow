import {
  AttachmentId,
  assistantThreadId,
  attachmentExtensions,
  attachmentMediaType,
  imageSizeRefusal,
  imageTypeRefusal,
  type AttachmentPutParams,
  type AttachmentPutResult,
  type AttachmentReadParams,
  type AttachmentReadResult,
  type Command,
  type ProviderModel,
} from '@wow/contracts';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/database.js';
import { threads } from '../db/schema.js';
import { sniffImage } from './read.js';

// Images pasted or dropped on a thread's composer (agent workbench spec 53 to 55). They are
// stored under wow's home, one folder per thread, and leave the server only to the thread's
// provider (the provider service hands the adapter their paths) and to the app for display.

export const imagesFolderName = 'images';

// A thread id is chosen by the app; only letters, digits, `-` and `_` go into the folder name
// as they are, so no id can climb out of the images folder or hold a character Windows refuses.
export function threadImageFolderName(threadId: string): string {
  return [...threadId]
    .map((char) =>
      /^[A-Za-z0-9_-]$/u.test(char) ? char : `~${char.codePointAt(0)?.toString(16) ?? ''}`,
    )
    .join('');
}

export const threadImageFolder = (home: string, threadId: string): string =>
  path.join(home, imagesFolderName, threadImageFolderName(threadId));

export const threadImagePath = (home: string, threadId: string, id: AttachmentId): string =>
  path.join(threadImageFolder(home, threadId), id);

export class ImageRefused extends Error {
  override readonly name = 'ImageRefused';
}

export interface ImageStoreDeps {
  readonly db: Db;
  readonly home: string;
  readonly maxBytes: () => number;
  // What the provider reports of an instance's models; a provider that cannot say throws.
  readonly listModels: (providerInstanceId: string) => Promise<readonly ProviderModel[]>;
}

// Whether the provider says this model takes no images (spec 54). Unknown is not a refusal:
// Claude Code does not say, and the provider's own refusal then shows as the turn's error.
async function modelRefusal(
  deps: ImageStoreDeps,
  providerInstanceId: string,
  model: string,
): Promise<string | undefined> {
  let models: readonly ProviderModel[];
  try {
    models = await deps.listModels(providerInstanceId);
  } catch {
    return undefined;
  }
  const chosen =
    models.find((entry) => entry.id === model) ??
    (model === '' ? models.find((entry) => entry.isDefault === true) : undefined);
  if (chosen?.imageInput !== false) return undefined;
  return `${chosen.label} takes no images. Pick a model that does, or send the message without them.`;
}

export class ImageStore {
  readonly #deps: ImageStoreDeps;

  constructor(deps: ImageStoreDeps) {
    this.#deps = deps;
  }

  async put(params: AttachmentPutParams): Promise<AttachmentPutResult> {
    if (params.threadId === assistantThreadId) {
      throw new ImageRefused('The assistant takes no images.');
    }
    const thread = this.#deps.db
      .select()
      .from(threads)
      .where(eq(threads.id, params.threadId))
      .get();
    if (thread?.kind === 'assistant') throw new ImageRefused('The assistant takes no images.');
    const bytes = Buffer.from(params.base64, 'base64');
    const mediaType = sniffImage(bytes);
    if (!mediaType || mediaType === 'image/svg+xml') {
      throw new ImageRefused(imageTypeRefusal(params.type, params.name));
    }
    const limit = this.#deps.maxBytes();
    if (bytes.length > limit) {
      throw new ImageRefused(imageSizeRefusal(bytes.length, limit, params.name));
    }
    const instance = thread?.providerInstanceId ?? params.providerInstanceId;
    const model = thread?.model ?? params.model;
    if (instance !== undefined && model !== undefined) {
      const refused = await modelRefusal(this.#deps, instance, model);
      if (refused !== undefined) throw new ImageRefused(refused);
    }
    const id = AttachmentId.parse(`${randomUUID()}.${attachmentExtensions[mediaType]}`);
    const folder = threadImageFolder(this.#deps.home, params.threadId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(path.join(folder, id), bytes, { mode: 0o600, flag: 'wx' });
    return {
      id,
      mediaType,
      ...(params.name !== undefined ? { name: params.name } : {}),
      bytes: bytes.length,
    };
  }

  async read({ threadId, id }: AttachmentReadParams): Promise<AttachmentReadResult> {
    let bytes: Buffer;
    try {
      bytes = await readFile(threadImagePath(this.#deps.home, threadId, id));
    } catch {
      throw new ImageRefused('This image is no longer stored.');
    }
    return { mediaType: attachmentMediaType(id), base64: bytes.toString('base64') };
  }

  // Looked at before a message is decided: every image it names must be stored for its thread,
  // so a turn never starts without one of its images, and the thread's model must still take
  // images, since it may have been changed after they were added (spec 54).
  async refusal(command: Command): Promise<string | undefined> {
    if (command.type !== 'thread.sendMessage') return undefined;
    const attachments = command.attachments ?? [];
    for (const { id } of attachments) {
      const found = await stat(threadImagePath(this.#deps.home, command.threadId, id)).then(
        (entry) => entry.isFile(),
        () => false,
      );
      if (!found) return 'An image of this message is no longer stored. Add it again.';
    }
    if (attachments.length === 0) return undefined;
    const thread = this.#deps.db
      .select()
      .from(threads)
      .where(eq(threads.id, command.threadId))
      .get();
    if (!thread) return undefined;
    return modelRefusal(this.#deps, thread.providerInstanceId, thread.model);
  }
}
