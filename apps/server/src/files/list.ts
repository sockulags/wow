import type { FileListResult } from '@wow/contracts';
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { gitEnvironment, readOnlyGitArgs, type GitRunOptions } from '../projects/git.js';
import { stopProcessTree } from '../projects/stop-process.js';

// The files of a folder for "Open file…" and `@` in the composer (agent workbench spec 18, 56).
// Names only: nothing is read. Inside Git the list is what Git tracks plus the untracked files it
// does not ignore; outside Git a walk, breadth first, that stops at the limit. Paths are relative
// with forward slashes, so the client compares them as the thread names them.

// What the listing needs of the git process. Tests hand in one they drive, so running out of
// time is a timer they fire rather than a wait.
export interface ListingProcess {
  readonly pid?: number | undefined;
  readonly stdout: {
    setEncoding(encoding: 'utf8'): unknown;
    on(event: 'data', listener: (chunk: string) => void): unknown;
  };
  on(event: 'error', listener: () => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  kill(): boolean;
}

export type StartListing = (command: string, args: string[]) => ListingProcess;

const startGit: StartListing = (command, args) =>
  spawn(command, args, {
    windowsHide: true,
    env: gitEnvironment(process.env),
    stdio: ['ignore', 'pipe', 'ignore'],
  });

export interface ListFilesRequest {
  readonly folder: string;
  readonly limit: number;
  readonly git: GitRunOptions;
  readonly start?: StartListing;
}

type GitList = { readonly files: string[]; readonly truncated: boolean } | undefined;

// undefined when the folder is not in a repository or git cannot run. Output is read as it comes
// and git is stopped at the limit, so a huge repository costs no more than the limit. When git
// runs out of time, what it listed so far is kept: walking instead would list what the
// repository ignores.
function gitFiles(
  folder: string,
  limit: number,
  options: GitRunOptions,
  start: StartListing,
): Promise<GitList> {
  return new Promise((resolve) => {
    const child = start(
      options.git ?? 'git',
      readOnlyGitArgs(folder, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']),
    );
    const files = new Set<string>();
    let rest = '';
    let truncated = false;
    let done = false;
    // At the limit or out of time git is stopped and the answer waits for it to be gone, since on
    // Windows a git that is still running holds the folder, but no longer than `stopWaitMs`.
    let stopped = false;
    let afterStop: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: GitList) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(afterStop);
      resolve(value);
    };
    const stop = () => {
      truncated = true;
      if (stopped) return;
      stopped = true;
      (options.stop ?? stopProcessTree())(child);
      afterStop = setTimeout(() => finish({ files: [...files], truncated }), options.stopWaitMs);
    };
    const timer = setTimeout(stop, options.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const parts = (rest + chunk).split('\0');
      rest = parts.pop() ?? '';
      for (const part of parts) {
        if (part === '') continue;
        if (stopped) return;
        if (files.size >= limit) {
          stop();
          return;
        }
        // A file both tracked and changed is listed once.
        files.add(part);
      }
    });
    child.on('error', () => finish(stopped ? { files: [...files], truncated } : undefined));
    child.on('close', (code) => {
      if (stopped) return finish({ files: [...files], truncated });
      if (code !== 0) return finish(undefined);
      if (rest !== '' && files.size < limit) files.add(rest);
      finish({ files: [...files], truncated });
    });
  });
}

// Folders a walk does not enter: hidden ones (.git, editor and tool state) and installed
// packages, which would fill the list before the user's own files.
const skipped = (name: string) => name.startsWith('.') || name === 'node_modules';

async function walkFiles(
  folder: string,
  limit: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const queue: string[] = [''];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const entries = await readdir(path.join(folder, next), { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relative = next === '' ? entry.name : `${next}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!skipped(entry.name)) queue.push(relative);
      } else if (entry.isFile()) {
        if (files.length >= limit) return { files, truncated: true };
        files.push(relative);
      }
    }
  }
  return { files, truncated: false };
}

// Git's index still names a tracked file deleted from disk, and a submodule as one entry that is
// a folder: neither can be opened.
async function onDisk(folder: string, files: readonly string[]): Promise<string[]> {
  const kept = await Promise.all(
    files.map((file) =>
      stat(path.join(folder, file)).then(
        (found) => found.isFile(),
        () => false,
      ),
    ),
  );
  return files.filter((_, index) => kept[index]);
}

export async function listFolderFiles({
  folder,
  limit,
  git,
  start = startGit,
}: ListFilesRequest): Promise<FileListResult> {
  const fromGit = await gitFiles(folder, limit, git, start);
  if (fromGit) {
    return {
      files: await onDisk(folder, fromGit.files),
      truncated: fromGit.truncated,
      source: 'git',
    };
  }
  return { ...(await walkFiles(folder, limit)), source: 'walk' };
}
