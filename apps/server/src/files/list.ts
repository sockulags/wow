import type { FileListResult } from '@wow/contracts';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { gitEnvironment, readOnlyGitArgs, type GitRunOptions } from '../projects/git.js';

// The files of a folder for "Open file…" and `@` in the composer (agent workbench spec 18, 56).
// Names only: nothing is read. Inside Git the list is what Git tracks plus the untracked files it
// does not ignore; outside Git a walk, breadth first, that stops at the limit. Paths are relative
// with forward slashes, so the client compares them as the thread names them.

export interface ListFilesRequest {
  readonly folder: string;
  readonly limit: number;
  readonly git: GitRunOptions;
}

type GitList = { readonly files: string[]; readonly truncated: boolean } | undefined;

// undefined when the folder is not in a repository or git cannot run. Output is read as it comes
// and git is stopped at the limit, so a huge repository costs no more than the limit.
function gitFiles(folder: string, limit: number, options: GitRunOptions): Promise<GitList> {
  return new Promise((resolve) => {
    const child = spawn(
      options.git ?? 'git',
      readOnlyGitArgs(folder, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']),
      { windowsHide: true, env: gitEnvironment(process.env), stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const files = new Set<string>();
    let rest = '';
    let truncated = false;
    let done = false;
    const finish = (value: GitList) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, options.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const parts = (rest + chunk).split('\0');
      rest = parts.pop() ?? '';
      for (const part of parts) {
        if (part === '') continue;
        if (files.size >= limit) {
          truncated = true;
          child.kill();
          finish({ files: [...files], truncated });
          return;
        }
        // A file both tracked and changed is listed once.
        files.add(part);
      }
    });
    child.on('error', () => finish(undefined));
    child.on('close', (code) => {
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

export async function listFolderFiles({
  folder,
  limit,
  git,
}: ListFilesRequest): Promise<FileListResult> {
  const fromGit = await gitFiles(folder, limit, git);
  if (fromGit) return { ...fromGit, source: 'git' };
  return { ...(await walkFiles(folder, limit)), source: 'walk' };
}
