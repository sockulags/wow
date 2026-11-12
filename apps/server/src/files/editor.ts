import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { findOnPath } from '../providers/detect.js';
import { candidatePaths, isInside } from './read.js';

// "Open in editor" (agent workbench spec 81): the server runs the command the
// `viewer.editorCommand` setting names, since the server owns subprocesses and the browser build
// has no other way to reach the editor. The command is split into words here and started as a
// program with arguments; only `viewer.editorShell` hands it to a shell.

// A launch wow will not make, with the reason for the user.
export class EditorRefused extends Error {}

export interface EditorTarget {
  // The full path of the file or folder.
  readonly path: string;
  readonly line: number;
}

// The command's words as the setting writes them: spaces split, double or single quotes keep a
// word together, a backslash is an ordinary character (Windows paths).
export function commandWords(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const character of command) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else word += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += character;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

// One pass with a function, so a `$&` or `{line}` in the path itself is never read as a
// pattern or filled in again: the editor gets the path findEditorPath checked.
const fill = (word: string, target: EditorTarget, shown: string = target.path): string =>
  word.replace(/\{path\}|\{line\}/g, (found) => (found === '{path}' ? shown : String(target.line)));

// The program and its arguments for a target. A command without {path} gets the path last.
export function editorArgs(
  command: string,
  target: EditorTarget,
): { readonly file: string; readonly args: string[] } {
  const words = commandWords(command);
  const [file, ...rest] = words;
  if (file === undefined || file === '') throw new EditorRefused('The editor command is empty.');
  const args = rest.map((word) => fill(word, target));
  if (!words.some((word) => word.includes('{path}'))) args.push(target.path);
  return { file: fill(file, target), args };
}

// cmd.exe reads `"…"` as one word and `""` inside it as a quote; a Windows path holds no quote.
// It still expands `%NAME%` inside quotes and `cmd /c` has no sure escape for it, so a path with
// a `%` is refused before it gets there (cmdSafe).
export const quoteForCmd = (value: string): string =>
  /^[\w@./:=+\\-]+$/.test(value) ? value : `"${value.replaceAll('"', '""')}"`;

function cmdSafe(target: EditorTarget): void {
  if (target.path.includes('%')) {
    throw new EditorRefused(
      `${target.path} has a % in it, which cmd.exe would read as a variable and open another path, so it was not opened.`,
    );
  }
}

const quoteForSh = (value: string): string =>
  /^[\w@./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

export interface EditorLaunch {
  readonly file: string;
  readonly args: readonly string[];
  // True when the line goes to a shell: as the setting asks, or for a Windows .cmd or .bat
  // (such as `code`), which Node starts only through cmd.exe.
  readonly shell: boolean;
  // What the shell runs, when it does.
  readonly line?: string;
}

export interface PlanOptions {
  readonly command: string;
  readonly shell: boolean;
  readonly target: EditorTarget;
  readonly platform: NodeJS.Platform;
  readonly env: Record<string, string | undefined>;
}

// How the command is started. On Windows a bare program name is looked up through PATHEXT, as a
// shell would, so `code` is found as `code.cmd` and run the Windows way.
export async function planEditor(options: PlanOptions): Promise<EditorLaunch> {
  const { file, args } = editorArgs(options.command, options.target);
  const windows = options.platform === 'win32';
  const quote = windows ? quoteForCmd : quoteForSh;
  if (options.shell) {
    // The line stays as written, shell syntax and all; only the path is quoted for the shell.
    const { command, target } = options;
    if (windows) cmdSafe(target);
    const filled = fill(command, target, quote(target.path));
    const line = command.includes('{path}') ? filled : `${filled} ${quote(target.path)}`;
    return { file, args, shell: true, line };
  }
  if (!windows) return { file, args, shell: false };
  const found =
    path.win32.isAbsolute(file) || /[\\/]/.test(file)
      ? file
      : ((await findOnPath(file, { env: options.env, platform: options.platform })) ?? file);
  if (/\.(cmd|bat)$/i.test(found)) {
    cmdSafe(options.target);
    return { file: found, args, shell: true, line: [found, ...args].map(quoteForCmd).join(' ') };
  }
  return { file: found, args, shell: false };
}

export type Spawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => ReturnType<typeof nodeSpawn>;

// Starts the editor and lets it go: wow does not wait for it to close. Resolves once the program
// has started, and rejects with the reason when it cannot. Through a shell that is once the shell
// has started: a program the shell then does not find ends there, unseen.
export function startEditor(
  launch: EditorLaunch,
  spawn: Spawn = nodeSpawn,
): Promise<{ readonly exited: Promise<number | null> }> {
  const options: SpawnOptions = {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
    ...(launch.shell ? { shell: true } : {}),
  };
  const child = launch.shell
    ? spawn(launch.line ?? launch.file, [], options)
    : spawn(launch.file, launch.args, options);
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
  return new Promise((resolve, reject) => {
    child.once('error', (error) => reject(error));
    child.once('spawn', () => {
      child.unref();
      resolve({ exited });
    });
  });
}

export type EditorFind =
  | { readonly found: string }
  | { readonly refused: 'outside' | 'missing'; readonly message: string };

// The full path to give the editor: inside one of the folders after following links, and there.
// A folder is allowed, so "Open in editor" also opens a thread's folder.
export async function findEditorPath(
  roots: readonly string[],
  requested: string,
  place: string,
): Promise<EditorFind> {
  const realRoots: string[] = [];
  for (const root of roots) {
    const real = await realpath(root).catch(() => undefined);
    if (real !== undefined) realRoots.push(real);
  }
  const candidates = candidatePaths(roots, requested, path, [...roots, ...realRoots]);
  if (candidates.length === 0) {
    return {
      refused: 'outside',
      message: `${requested} is outside ${place}, so it was not opened.`,
    };
  }
  for (const candidate of candidates) {
    const real = await realpath(candidate).catch(() => undefined);
    if (real === undefined) continue;
    if (!realRoots.some((root) => isInside(root, real))) {
      return {
        refused: 'outside',
        message: `${requested} is a link to a place outside ${place}, so it was not opened.`,
      };
    }
    if (
      await stat(real).then(
        () => true,
        () => false,
      )
    )
      return { found: real };
  }
  return { refused: 'missing', message: `There is no file ${requested}.` };
}
