import { createContext, useContext, type ReactNode } from 'react';

// File paths in chat messages (agent workbench spec 15): inline code or a link target that reads
// as a path becomes a link that opens the file in a panel tab. The conversation of a chat or step
// thread provides `open`; without it (the Assistant view, backlog bodies, the viewer's own
// markdown) nothing is a file link. The server decides what may be read (spec 16): a path that
// leads outside opens a tab with the refusal, never a read.

export interface FileLinks {
  open(path: string): void;
}

export const FileLinkContext = createContext<FileLinks | undefined>(undefined);

export const useFileLinks = (): FileLinks | undefined => useContext(FileLinkContext);

const pathCharacters = /^(?:[A-Za-z]:[\\/])?[\p{L}\p{N}\p{M}_.@~+\-/\\()[\]$]+$/u;
const extension = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
const hostName =
  /\.(?:com|net|org|io|dev|app|cloud|co|info|biz|internal|local|lan|localhost|test|example|invalid)$/i;

// The narrow rule (spec 15, Open risks): no spaces, no colon but a drive's (so no address
// scheme), and a file extension or a slash. `src/timer.ts`, `README.md`, `docs/` and
// `C:\work\a.ts` are paths; `pnpm test`, `https://…`, `1.5` and `--force` are not. A line and
// column (`src/timer.ts:42:7`) or a fragment (`docs/spec.md#rules`) after the path names a place
// in the file; the path without them is what opens.
export function filePathOf(text: string): string | undefined {
  const value = text.trim();
  if (value === '' || value !== text || value.length > 400) return undefined;
  const named = value.replace(/#[^#/\\]*$/, '');
  const bare = named.replace(/:\d+(?::\d+)?$/, '');
  if (bare.startsWith('-') || !pathCharacters.test(bare)) return undefined;
  // `example.com:8080` and `user@host.com:22` are a host and a port, not a line.
  if (bare !== named && !/[\\/]/.test(bare) && (bare.includes('@') || hostName.test(bare))) {
    return undefined;
  }
  if (/^[./\\]+$/.test(bare)) return undefined;
  const last =
    bare
      .split(/[\\/]/)
      .filter((part) => part !== '')
      .at(-1) ?? '';
  return /[\\/]/.test(bare) || extension.test(last) ? bare : undefined;
}

export const isFilePath = (text: string): boolean => filePathOf(text) !== undefined;

// `example.com` or `notes.app`: a word that ends like a host name rather than a file.
export const readsAsHost = (text: string): boolean => hostName.test(text);

export function FileLink({
  path,
  children,
}: {
  readonly path: string;
  readonly children: ReactNode;
}) {
  const links = useFileLinks();
  if (!links) return <>{children}</>;
  return (
    <button
      type="button"
      data-testid="file-link"
      title={`Open ${path} in the side panel`}
      className="cursor-pointer rounded-sm text-left underline decoration-dotted underline-offset-2 outline-none hover:decoration-solid focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => links.open(path)}
    >
      {children}
    </button>
  );
}
