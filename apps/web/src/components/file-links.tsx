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

const pathCharacters = /^(?:[A-Za-z]:[\\/])?[\w.@~+\-/\\()[\]]+$/;
const extension = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;

// The narrow rule (spec 15, Open risks): no spaces, no colon but a drive's (so no address
// scheme), and a file extension or a slash. `src/timer.ts`, `README.md`, `docs/` and `C:\work\a.ts` are paths; `pnpm test`,
// `https://…`, `1.5` and `--force` are not.
export function isFilePath(text: string): boolean {
  const value = text.trim();
  if (value === '' || value !== text || value.length > 400) return false;
  if (value.startsWith('-') || !pathCharacters.test(value)) return false;
  if (/^[./\\]+$/.test(value)) return false;
  const last =
    value
      .split(/[\\/]/)
      .filter((part) => part !== '')
      .at(-1) ?? '';
  return /[\\/]/.test(value) || extension.test(last);
}

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
