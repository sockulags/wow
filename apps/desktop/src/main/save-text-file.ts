import { SaveTextFileRequest } from '@wow/contracts';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// `wow:save-text-file` (thread work spec 7): the app's own page asks to save a text file, the
// system's save dialog picks the path, and the text is written there as UTF-8. Only `wow://app`
// pages are answered, as for the folder dialog, and the page never names the path: the
// suggested name is cut to a bare file name, so it cannot point the dialog elsewhere.

export interface SaveDialogOptions {
  readonly title: string;
  readonly defaultPath: string;
  readonly filters: ReadonlyArray<{ readonly name: string; readonly extensions: string[] }>;
}

export interface SaveTextFileShell {
  // The asking page is one of the app's own.
  readonly fromApp: boolean;
  // Where the dialog opens: the user's documents folder.
  readonly folder: string;
  showSaveDialog(
    options: SaveDialogOptions,
  ): Promise<{ readonly canceled: boolean; readonly filePath?: string | undefined }>;
}

// Characters Windows refuses in a file name, names it keeps for devices (also before a dot),
// and direction marks that could make the name in the dialog read otherwise. The page is not
// trusted to have cleaned the name.
const refused = /[<>:"/\\|?*]/g;
const deviceName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const directionMarks = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// Room for ".md" under the 255 characters Windows allows.
const nameLength = 200;
const printable = (text: string) =>
  [...text].filter((character) => (character.codePointAt(0) ?? 0) >= 32).join('');
const trimEnd = (text: string) => text.trim().replace(/[. ]+$/, '');

export function bareFileName(suggested: string): string {
  const name = trimEnd(
    [
      ...trimEnd(
        printable(suggested.split(/[\\/]/).at(-1) ?? '')
          .replace(directionMarks, '')
          .replace(refused, ''),
      ).replace(/\.md$/i, ''),
    ]
      .slice(0, nameLength)
      .join(''),
  );
  const base = name === '' ? 'conversation' : name;
  return `${deviceName.test(base) ? base.replace(/^[^.]*/, '$&-conversation') : base}.md`;
}

// The path written, or null when the page is not the app's or the user cancelled the dialog. A
// request that is not one throws, so the page says the file was not saved rather than nothing.
export async function saveTextFile(
  request: unknown,
  shell: SaveTextFileShell,
): Promise<string | null> {
  if (!shell.fromApp) return null;
  const parsed = SaveTextFileRequest.safeParse(request);
  if (!parsed.success) throw new Error('The request to save a file was not readable.');
  const result = await shell.showSaveDialog({
    title: 'Save conversation',
    defaultPath: path.join(shell.folder, bareFileName(parsed.data.suggestedName)),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || result.filePath === undefined || result.filePath === '') return null;
  await writeFile(result.filePath, parsed.data.text, { encoding: 'utf8' });
  return result.filePath;
}
