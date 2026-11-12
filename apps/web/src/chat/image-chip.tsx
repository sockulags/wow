import {
  AttachmentMediaType,
  AttachmentPutResult,
  AttachmentReadResult,
  imageSizeRefusal,
  imageTypeRefusal,
  type SentImage,
} from '@wow/contracts';
import type { Connection } from '@wow/client-runtime';
import { ImageIcon, XIcon } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent, type Ref } from 'react';
import { useRuntime } from '@/app/runtime';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { errorMessage } from './data';

// Images pasted or dropped on the composer (agent workbench spec 53 to 55). Each goes to the
// server once when it is added; the chip and the sent message name it by the id the server gave
// and read it back for display.

// Where an image goes: the thread it is stored for, and for a thread not created yet the
// provider instance and model it will be sent to, so the server can refuse a model without
// image input (spec 54).
export interface ImageTarget {
  readonly threadId: string;
  readonly providerInstanceId?: string | undefined;
  readonly model?: string | undefined;
}

export const imageLabel = (image: SentImage, index: number): string =>
  image.name ?? `Image ${index + 1}`;

// The browser's own check before anything is sent: the type it says the file is and its size.
// The server checks the bytes again.
export function localImageRefusal(file: File, maxBytes: number): string | undefined {
  const name = file.name === '' || file.name === 'image.png' ? undefined : file.name;
  if (!AttachmentMediaType.safeParse(file.type).success) return imageTypeRefusal(file.type, name);
  if (file.size > maxBytes) return imageSizeRefusal(file.size, maxBytes, name);
  return undefined;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let text = '';
  // In slices, since one call with every byte overflows the argument list of a large image.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(text);
}

// A pasted screenshot comes as "image.png" from most browsers; it is shown as "Image n".
const givenName = (file: File) =>
  file.name === '' || file.name === 'image.png' ? undefined : file.name.slice(0, 200);

export async function putImage(
  connection: Connection,
  target: ImageTarget,
  file: File,
): Promise<SentImage> {
  const name = givenName(file);
  const result = AttachmentPutResult.parse(
    await connection.request('attachments.put', {
      threadId: target.threadId,
      base64: toBase64(await file.arrayBuffer()),
      type: file.type,
      ...(name !== undefined ? { name } : {}),
      ...(target.providerInstanceId !== undefined
        ? { providerInstanceId: target.providerInstanceId }
        : {}),
      ...(target.model !== undefined ? { model: target.model } : {}),
    }),
  );
  return {
    id: result.id,
    mediaType: result.mediaType,
    ...(result.name !== undefined ? { name: result.name } : {}),
  };
}

// Read once per connection and image; the bytes do not change once stored.
const reads = new WeakMap<Connection, Map<string, Promise<string>>>();

function readImage(connection: Connection, threadId: string, id: string): Promise<string> {
  let perConnection = reads.get(connection);
  if (!perConnection) {
    perConnection = new Map();
    reads.set(connection, perConnection);
  }
  const key = `${threadId}\n${id}`;
  let read = perConnection.get(key);
  if (!read) {
    read = connection.request('attachments.read', { threadId, id }).then((result) => {
      const image = AttachmentReadResult.parse(result);
      return `data:${image.mediaType};base64,${image.base64}`;
    });
    read.catch(() => perConnection.delete(key));
    perConnection.set(key, read);
  }
  return read;
}

type ImageState =
  | { readonly status: 'loading' }
  | { readonly status: 'done'; readonly url: string }
  | { readonly status: 'failed'; readonly error: string };

export function useImage(threadId: string, id: string): ImageState {
  const { connection } = useRuntime();
  const [state, setState] = useState<ImageState & { readonly for?: string }>({
    status: 'loading',
  });
  const key = `${threadId}\n${id}`;
  useEffect(() => {
    if (!connection) return undefined;
    let current = true;
    readImage(connection, threadId, id).then(
      (url) => current && setState({ status: 'done', url, for: key }),
      (error: unknown) =>
        current && setState({ status: 'failed', error: errorMessage(error), for: key }),
    );
    return () => {
      current = false;
    };
  }, [connection, threadId, id, key]);
  return state.for === key ? state : { status: 'loading' };
}

function Thumbnail({
  threadId,
  image,
  label,
  className,
}: {
  threadId: string;
  image: SentImage;
  label: string;
  className?: string;
}) {
  const state = useImage(threadId, image.id);
  if (state.status === 'done') {
    return (
      <img
        src={state.url}
        alt={label}
        draggable={false}
        className={cn('size-full object-cover', className)}
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={state.status === 'failed' ? `${label}: ${state.error}` : label}
      className="flex size-full items-center justify-center bg-muted text-muted-foreground"
    >
      <ImageIcon aria-hidden className="size-4" />
    </span>
  );
}

// The image at full size (spec 53), in a dialog that Escape closes.
export function ImageViewer({
  threadId,
  image,
  label,
  onClose,
}: {
  threadId: string;
  image: SentImage | undefined;
  label: string;
  onClose(): void;
}) {
  return (
    <Dialog open={image !== undefined} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] w-auto max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-2rem)]">
        <DialogTitle className="pr-8 text-sm">{label}</DialogTitle>
        <DialogDescription className="sr-only">The image at full size</DialogDescription>
        {image && <FullImage threadId={threadId} image={image} label={label} />}
      </DialogContent>
    </Dialog>
  );
}

function FullImage({
  threadId,
  image,
  label,
}: {
  threadId: string;
  image: SentImage;
  label: string;
}) {
  const state = useImage(threadId, image.id);
  if (state.status === 'failed') {
    return <p className="text-xs text-destructive">{state.error}</p>;
  }
  if (state.status === 'loading') {
    return <p className="text-xs text-muted-foreground">Loading the image…</p>;
  }
  return (
    <img
      data-testid="image-full-size"
      src={state.url}
      alt={label}
      className="max-h-[calc(100vh-8rem)] max-w-full object-contain"
    />
  );
}

const thumbnailButton =
  'block size-12 overflow-hidden rounded-md border border-border bg-background outline-none hover:border-ring focus-visible:ring-2 focus-visible:ring-ring';

// An image added to the composer, before the message is sent: a thumbnail that opens it full
// size, and a cross that takes it off. Backspace and Delete on it take it off too.
export function ComposerImageChip({
  ref,
  threadId,
  image,
  label,
  onOpen,
  onRemove,
  onKeyDown,
}: {
  ref?: Ref<HTMLButtonElement>;
  threadId: string;
  image: SentImage;
  label: string;
  onOpen(): void;
  onRemove(): void;
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void;
}) {
  return (
    <span role="listitem" data-testid="composer-image-chip" className="relative inline-flex">
      <button
        ref={ref}
        type="button"
        aria-label={`Show ${label} full size`}
        title={label}
        className={thumbnailButton}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onOpen}
        onKeyDown={onKeyDown}
      >
        <Thumbnail threadId={threadId} image={image} label={label} />
      </button>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full border border-border bg-background text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onRemove}
      >
        <XIcon className="size-3" />
      </button>
    </span>
  );
}

// The images a user message was sent with (spec 53), above its text; a click shows one full size.
export function SentImages({
  threadId,
  images,
}: {
  threadId: string;
  images: readonly SentImage[];
}) {
  const [open, setOpen] = useState<number>();
  const shown = open === undefined ? undefined : images[open];
  return (
    <>
      <div
        role="list"
        aria-label="Sent with images"
        className="flex max-w-[85%] flex-wrap justify-end gap-1"
      >
        {images.map((image, index) => (
          <span role="listitem" key={image.id} data-testid="sent-image">
            <button
              type="button"
              aria-label={`Show ${imageLabel(image, index)} full size`}
              title={imageLabel(image, index)}
              className={cn(thumbnailButton, 'size-20')}
              onClick={() => setOpen(index)}
            >
              <Thumbnail threadId={threadId} image={image} label={imageLabel(image, index)} />
            </button>
          </span>
        ))}
      </div>
      <ImageViewer
        threadId={threadId}
        image={shown}
        label={shown && open !== undefined ? imageLabel(shown, open) : ''}
        onClose={() => setOpen(undefined)}
      />
    </>
  );
}
