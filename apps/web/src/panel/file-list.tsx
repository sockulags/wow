import { FileListResult, type FileScope } from '@wow/contracts';
import { FileIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLayout, useRuntime, useSetting } from '@/app/runtime';
import { errorMessage } from '@/chat/data';
import { CommandDialog, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { fullPathOf, openFile } from './viewer';

// The thread folder's files, for "Open file…" (Ctrl+P) and `@` in the composer (agent workbench
// spec 18, 56). The server lists them (Git, or a bounded walk) each time a list opens; the app
// filters them as the user types.

export type FileListState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'done'; readonly files: readonly string[]; readonly truncated: boolean };

// Asks while `enabled`, again each time it turns on.
export function useFileList(scope: FileScope | undefined, enabled: boolean): FileListState {
  const { connection } = useRuntime();
  const key = scope && enabled ? JSON.stringify(scope) : undefined;
  const [answer, setAnswer] = useState<{ readonly key: string; readonly state: FileListState }>();
  useEffect(() => {
    if (!connection || key === undefined) return undefined;
    let current = true;
    const asked = JSON.parse(key) as FileScope;
    connection.request('files.list', asked).then(
      (received) => {
        if (!current) return;
        const parsed = FileListResult.safeParse(received);
        setAnswer({
          key,
          state: parsed.success
            ? { status: 'done', files: parsed.data.files, truncated: parsed.data.truncated }
            : {
                status: 'failed',
                message: 'The server answered in a form this app does not read.',
              },
        });
      },
      (error: unknown) => {
        if (current) setAnswer({ key, state: { status: 'failed', message: errorMessage(error) } });
      },
    );
    return () => {
      current = false;
    };
  }, [connection, key]);
  if (!connection) return { status: 'failed', message: 'Not connected to the wow server' };
  return answer !== undefined && answer.key === key ? answer.state : { status: 'loading' };
}

// How far `needle` is from being in `hay` in order: undefined when it is not, else the number
// of breaks between matched letters and where the first one is. Lower is better.
function subsequence(hay: string, needle: string): number | undefined {
  let from = 0;
  let last = -1;
  let breaks = 0;
  let first = -1;
  for (const letter of needle) {
    const found = hay.indexOf(letter, from);
    if (found < 0) return undefined;
    if (first < 0) first = found;
    if (last >= 0 && found !== last + 1) breaks += 1;
    last = found;
    from = found + 1;
  }
  return breaks * 100 + first;
}

// A fuzzy rank (spec 18): the letters typed, in order, anywhere in the path; a match inside the
// file's own name comes before one across folders, fewer breaks before more, shorter paths first.
export function fileScore(path: string, query: string): number | undefined {
  const needle = query.toLowerCase().replaceAll('\\', '/');
  if (needle === '') return path.length;
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  const inName = needle.includes('/') ? undefined : subsequence(name, needle);
  if (inName !== undefined) return inName * 1000 + path.length;
  const inPath = subsequence(lower, needle);
  return inPath === undefined ? undefined : 1_000_000 + inPath * 1000 + path.length;
}

export function filterFiles(files: readonly string[], query: string, shown: number): string[] {
  const scored: { readonly path: string; readonly score: number }[] = [];
  for (const path of files) {
    const score = fileScore(path, query);
    if (score !== undefined) scored.push({ path, score });
  }
  scored.sort((a, b) => a.score - b.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return scored.slice(0, shown).map((entry) => entry.path);
}

// A line under the list for a list that is not all there.
export function fileListNote(
  state: FileListState,
  matches: number,
  shown: number,
): string | undefined {
  if (state.status === 'loading') return 'Listing the files…';
  if (state.status === 'failed') return state.message;
  if (state.files.length === 0) return 'No files in this folder.';
  if (matches === 0) return 'No matching files.';
  if (matches >= shown) return `Showing the first ${shown} matches; type more to narrow them.`;
  if (state.truncated)
    return 'The folder has more files than the "Files listed" setting lets through.';
  return undefined;
}

export function FileRow({ path }: { readonly path: string }) {
  const slash = path.lastIndexOf('/');
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <FileIcon aria-hidden className="size-3.5 shrink-0 self-center text-muted-foreground" />
      <span className="shrink-0 font-medium">{path.slice(slash + 1)}</span>
      {slash > 0 && (
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {path.slice(0, slash)}
        </span>
      )}
    </span>
  );
}

// "Open file…": the dialog the palette command opens.
export function OpenFileDialog() {
  const { settings, layout } = useRuntime();
  const dialog = useLayout((state) => state.openFileDialog);
  const shown = useSetting('viewer.fileMatchesShown');
  const [query, setQuery] = useState('');
  const state = useFileList(dialog?.scope, dialog !== undefined);
  const files = state.status === 'done' ? state.files : [];
  const matches = dialog ? filterFiles(files, query, shown) : [];
  const note = fileListNote(state, matches.length, shown);
  const close = () => {
    layout.setState({ openFileDialog: undefined });
    setQuery('');
  };
  return (
    <CommandDialog
      open={dialog !== undefined}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Open file"
      description="Type part of a file's name to open it in the side panel"
      showCloseButton={false}
    >
      <CommandInput
        aria-label="File name"
        placeholder="Open file…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList aria-label="Files" className="[&_[cmdk-item]]:py-2">
        {matches.map((path) => (
          <CommandItem
            key={path}
            value={path}
            onSelect={() => {
              if (!dialog) return;
              close();
              openFile(
                { settings, layout },
                {
                  scope: dialog.scope,
                  path,
                  fullPath: fullPathOf(dialog.folder, path),
                  from: dialog.from,
                },
              );
            }}
          >
            <FileRow path={path} />
          </CommandItem>
        ))}
      </CommandList>
      {note && (
        <p
          data-testid="file-list-note"
          className="border-t border-border px-3 py-2 text-xs text-muted-foreground"
        >
          {note}
        </p>
      )}
    </CommandDialog>
  );
}
