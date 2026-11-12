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

// Characters Windows refuses in a file name.
const refused = /[<>:"/\\|?*]/g;
const printable = (text: string) =>
  [...text].filter((character) => (character.codePointAt(0) ?? 0) >= 32).join('');

export function bareFileName(suggested: string): string {
  const name = printable(suggested.split(/[\\/]/).at(-1) ?? '')
    .replace(refused, '')
    .trim()
    .replace(/[. ]+$/, '');
  const base = name === '' ? 'conversation' : name;
  return base.toLowerCase().endsWith('.md') ? base : `${base}.md`;
}

// The path written, or null when the page is not the app's, the request is not one, or the
// user cancelled the dialog.
export async function saveTextFile(
  request: unknown,
  shell: SaveTextFileShell,
): Promise<string | null> {
  if (!shell.fromApp) return null;
  const parsed = SaveTextFileRequest.safeParse(request);
  if (!parsed.success) return null;
  const result = await shell.showSaveDialog({
    title: 'Save conversation',
    defaultPath: path.join(shell.folder, bareFileName(parsed.data.suggestedName)),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || result.filePath === undefined || result.filePath === '') return null;
  await writeFile(result.filePath, parsed.data.text, { encoding: 'utf8' });
  return result.filePath;
}
