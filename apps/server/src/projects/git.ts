import type {
  DiffFileStatus,
  GitHubRemote,
  GitLabProject,
  GitRemote,
  ProjectGitStatus,
} from '@wow/contracts';
import { spawn } from 'node:child_process';
import {
  access,
  constants,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { stopProcessTree, type StopProcess } from './stop-process.js';

// What a project folder's git repository says about its trackers (owner decision F-4): the
// remotes (GitHub owner and repository come from them) and Jira keys in recent branch names and
// commit messages. The server owns Git; this only reads, and never runs anything that could ask
// for credentials or write to the repository.

// Hosts that are known not to be GitHub, so their remotes are not offered as GitHub repositories.
const otherHosts = new Set([
  'gitlab.com',
  'bitbucket.org',
  'dev.azure.com',
  'ssh.dev.azure.com',
  'vs-ssh.visualstudio.com',
  'codeberg.org',
]);

const GITHUB = 'github.com';

// GitHub Enterprise Cloud with data residency serves <name>.ghe.com and its API at
// api.<name>.ghe.com; GitHub Enterprise Server serves its API under /api/v3 on its own host.
const apiBaseUrlOf = (host: string): string => {
  if (host === GITHUB) return 'https://api.github.com';
  if (/^[a-z0-9-]+\.ghe\.com$/.test(host)) return `https://api.${host}`;
  return `https://${host}/api/v3`;
};

const githubOf = (host: string | null, repoPath: string | null): GitHubRemote | null => {
  if (!host || !repoPath) return null;
  const lower = host.toLowerCase();
  // ssh.github.com:443 is github.com's SSH-over-HTTPS host.
  const normalized = lower === 'ssh.github.com' || lower === 'www.github.com' ? GITHUB : lower;
  if (otherHosts.has(normalized) || normalized.endsWith('.visualstudio.com')) return null;
  const parts = repoPath.split('/');
  // owner/repo only: deeper paths are GitLab subgroups or something else.
  if (parts.length !== 2 || parts.some((part) => part === '')) return null;
  const [owner, repo] = parts as [string, string];
  const enterprise = normalized !== GITHUB;
  return {
    owner,
    repo,
    host: normalized,
    apiBaseUrl: apiBaseUrlOf(normalized),
    enterprise,
  };
};

const cleanPath = (value: string): string | null => {
  const trimmed = value
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  return trimmed === '' ? null : trimmed;
};

// Parses a remote URL in any form git accepts: https://host/owner/repo(.git), with or without a
// user name and password (dropped), ssh://[user@]host[:port]/owner/repo, git://host/owner/repo, the
// scp-like [user@]host:owner/repo, and local paths (no host).
export function parseRemoteUrl(name: string, raw: string): GitRemote {
  const url = raw.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (scheme) {
    const protocol = scheme[1]?.toLowerCase() ?? '';
    if (protocol === 'file') return { name, url, host: null, path: null, github: null };
    try {
      const parsed = new URL(url);
      // Credentials in an https remote must never reach the UI or a log.
      parsed.username = '';
      parsed.password = '';
      const host = parsed.hostname === '' ? null : parsed.hostname.toLowerCase();
      const repoPath = cleanPath(decodeURIComponent(parsed.pathname));
      const shown =
        protocol === 'http' || protocol === 'https' ? parsed.toString() : url.replace(/\/+$/, '');
      return { name, url: shown, host, path: repoPath, github: githubOf(host, repoPath) };
    } catch {
      return { name, url, host: null, path: null, github: null };
    }
  }
  // scp-like: [user@]host:path, where host has no slash and the path does not start with "/" or
  // "\" right after a drive letter (C:\code is a Windows path, not a host called C).
  const scp = /^(?:[^@/\\]+@)?([^:/\\]+):(?!\/\/)(.+)$/.exec(url);
  if (scp && !/^[a-z]$/i.test(scp[1] ?? '')) {
    const host = (scp[1] ?? '').toLowerCase();
    const repoPath = cleanPath(scp[2] ?? '');
    return { name, url, host, path: repoPath, github: githubOf(host, repoPath) };
  }
  return { name, url, host: null, path: null, github: null };
}

// The GitLab project a remote points at, when the remote is on the GitLab site the user stored
// (`trackers.gitlab.baseUrl`). Any host can run GitLab, so only the stored site says that one
// does; the remote's own host is never enough. The path keeps every nested group
// (`group/sub/app`). A site under a sub-path (https://example.com/gitlab) has that prefix in its
// https remotes, which is not part of the project path.
export function gitLabProjectOf(
  remote: GitRemote | undefined,
  baseUrl: string,
): GitLabProject | null {
  if (!remote?.host || !remote.path || !URL.canParse(baseUrl)) return null;
  const site = new URL(baseUrl);
  if (site.hostname.toLowerCase() !== remote.host) return null;
  const prefix = cleanPath(site.pathname);
  const web = /^https?:\/\//i.test(remote.url);
  const underSite =
    prefix !== null && remote.path.toLowerCase().startsWith(`${prefix.toLowerCase()}/`);
  // An https remote on the same host but outside the site's sub-path is another server's.
  if (web && prefix !== null && !underSite) return null;
  const projectPath = web && underSite ? remote.path.slice(prefix.length + 1) : remote.path;
  const parts = projectPath.split('/');
  if (parts.length < 2 || parts.some((part) => part === '')) return null;
  return { host: remote.host, path: projectPath };
}

// `git remote -v` prints each remote twice, "(fetch)" and "(push)"; the fetch URL is the one
// that names the repository.
export function parseRemoteList(output: string): GitRemote[] {
  const remotes = new Map<string, GitRemote>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S.*?)\s+\((fetch|push)\)\s*$/.exec(line);
    if (!match) continue;
    const [, name = '', url = '', kind] = match;
    if (kind === 'push' && remotes.has(name)) continue;
    remotes.set(name, parseRemoteUrl(name, url));
  }
  return [...remotes.values()];
}

// The `[remote "name"] url = …` entries of a .git/config file, for when git itself cannot run.
export function parseGitConfigRemotes(text: string): GitRemote[] {
  const remotes: GitRemote[] = [];
  let current: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[\s*([^\s\]"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]$/.exec(line);
    if (section) {
      current =
        section[1]?.toLowerCase() === 'remote' && section[2] !== undefined
          ? section[2].replace(/\\(.)/g, '$1')
          : undefined;
      continue;
    }
    if (current === undefined) continue;
    const entry = /^url\s*=\s*(.*)$/i.exec(line);
    if (entry && !remotes.some((remote) => remote.name === current)) {
      const value = (entry[1] ?? '').replace(/^"(.*)"$/, '$1').trim();
      if (value !== '') remotes.push(parseRemoteUrl(current, value));
    }
  }
  return remotes;
}

// origin when there is one (the fork itself, not its upstream), else the first remote that is a
// GitHub repository, else the first remote.
export function primaryRemote(remotes: readonly GitRemote[]): GitRemote | undefined {
  return (
    remotes.find((remote) => remote.name === 'origin') ??
    remotes.find((remote) => remote.github !== null) ??
    remotes[0]
  );
}

// Uppercase prefixes of things that look like Jira keys but are not.
const notJiraKeys = new Set([
  'UTF',
  'SHA',
  'ISO',
  'RFC',
  'CVE',
  'HTTP',
  'TLS',
  'SSL',
  'ES',
  'MD',
  'AES',
  'RSA',
  'GH',
  'PR',
  'WIP',
]);

export interface JiraKeyGuess {
  readonly key: string;
  // Distinct issues seen, such as ABC-12 and ABC-13.
  readonly issues: number;
  readonly example: string;
}

// Project keys referenced as KEY-123 in the given texts, most issues first. The current branch
// counts like any other text.
export function guessJiraKeys(texts: readonly string[]): JiraKeyGuess[] {
  const seen = new Map<string, Set<string>>();
  for (const text of texts) {
    for (const match of text.matchAll(
      /(?<![A-Za-z0-9])([A-Z][A-Z0-9_]{1,9})-([1-9]\d{0,6})(?!\d)/g,
    )) {
      const key = match[1] ?? '';
      if (notJiraKeys.has(key)) continue;
      const issues = seen.get(key) ?? new Set<string>();
      issues.add(`${key}-${match[2] ?? ''}`);
      seen.set(key, issues);
    }
  }
  return [...seen.entries()]
    .map(([key, issues]) => ({ key, issues: issues.size, example: [...issues][0] ?? key }))
    .toSorted((a, b) => b.issues - a.issues || a.key.localeCompare(b.key));
}

export interface GitRunOptions {
  readonly timeoutMs: number;
  // How long a git stopped for running out of time may take to be gone before the answer goes
  // anyway; a stopped git that never closes would otherwise hold the answer for ever.
  readonly stopWaitMs: number;
  // Replaces the git binary, for tests.
  readonly git?: string | undefined;
  // Replace starting and stopping git, for tests.
  readonly start?: StartGit | undefined;
  readonly stop?: StopProcess | undefined;
}

interface GitOutput {
  setEncoding(encoding: 'utf8'): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
}

export interface GitProcess {
  readonly pid?: number | undefined;
  readonly stdout: GitOutput;
  readonly stderr: GitOutput;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  kill(): boolean;
}

// `env` is given for the commands that run the repository's hooks (commitPaths, pushBranch);
// every other command runs with `gitEnvironment`.
export type StartGit = (command: string, args: string[], env?: NodeJS.ProcessEnv) => GitProcess;

export const startGit: StartGit = (command, args, env = gitEnvironment(process.env)) =>
  spawn(command, args, {
    windowsHide: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

type GitResult = { ok: true; stdout: string } | { ok: false; missing: boolean; message: string };

// A repository's config can name programs git runs while it only reads: hooks, a file system
// monitor, and (per command) external diff and text conversion programs. wow runs none of them.
const neverRun = ['-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false'];
// Paths come back as they are, not quoted and escaped.
const plainPaths = ['-c', 'core.quotePath=false'];

// Git runs with nobody to answer it: no password prompt in a terminal, and no sign-in window
// from Git Credential Manager (Windows), which would otherwise wait for a click.
export function gitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    // No optional lock is taken in the user's repository.
    GIT_OPTIONAL_LOCKS: '0',
    // A file name is a name, never a pattern.
    GIT_LITERAL_PATHSPECS: '1',
    LC_ALL: 'C',
  };
}

// The arguments of a read-only git command in `folder`, with nothing of the repository's run.
export const readOnlyGitArgs = (folder: string, args: readonly string[]): string[] => [
  ...neverRun,
  ...plainPaths,
  '-C',
  folder,
  ...args,
];

function runGit(
  folder: string,
  args: readonly string[],
  options: GitRunOptions,
  config: readonly string[] = [],
) {
  return execGit([...neverRun, ...plainPaths, ...config, '-C', folder, ...args], args, options);
}

// How a git that runs the repository's hooks keeps what it writes: only the last `tailBytes`
// characters of stdout and stderr together, so a hook that writes a lot is not stopped for it.
interface HookOutput {
  readonly env: NodeJS.ProcessEnv;
  readonly tailBytes: number;
}

type ExecResult = GitResult & { readonly output?: string };

function execGit(
  fullArgs: readonly string[],
  args: readonly string[],
  options: GitRunOptions,
  hooks?: HookOutput,
) {
  return new Promise<ExecResult>((resolve) => {
    const command = options.git ?? 'git';
    const child = hooks
      ? (options.start ?? startGit)(command, [...fullArgs], hooks.env)
      : (options.start ?? startGit)(command, [...fullArgs]);
    const stop = options.stop ?? stopProcessTree();
    let stdout = '';
    let stderr = '';
    let output = '';
    let stopped: string | undefined;
    let done = false;
    let afterStop: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: GitResult) => {
      if (done) return;
      done = true;
      clearTimeout(limit);
      clearTimeout(afterStop);
      resolve(hooks ? { ...result, output } : result);
    };
    // A stopped git is waited for, since on Windows one still running holds the folder, but only
    // for `stopWaitMs`.
    const stopGit = (reason: string) => {
      if (stopped !== undefined) return;
      stopped = reason;
      stop(child);
      afterStop = setTimeout(
        () => finish({ ok: false, missing: false, message: reason }),
        options.stopWaitMs,
      );
    };
    const limit = setTimeout(
      () => stopGit(`git did not finish within ${options.timeoutMs} ms and was stopped`),
      options.timeoutMs,
    );
    const take = (chunk: string, into: 'stdout' | 'stderr') => {
      if (hooks) {
        output = (output + chunk).slice(-hooks.tailBytes);
        if (into === 'stdout') stdout = (stdout + chunk).slice(-hooks.tailBytes);
        else stderr = (stderr + chunk).slice(-hooks.tailBytes);
        return;
      }
      if (into === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (stdout.length + stderr.length > 4 * 1024 * 1024) stopGit('git wrote more than wow reads');
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => take(chunk, 'stdout'));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => take(chunk, 'stderr'));
    child.on('error', (error) => {
      if (stopped !== undefined) return;
      finish({ ok: false, missing: error.code === 'ENOENT', message: error.message });
    });
    child.on('close', (code) => {
      if (stopped !== undefined) return finish({ ok: false, missing: false, message: stopped });
      if (code === 0) return finish({ ok: true, stdout });
      // Git may say what it was doing ("Preparing worktree …") before why it stopped.
      const lines = stderr.trim().split(/\r?\n/);
      const message =
        (lines.find((line) => /^(fatal|error):/.test(line)) ?? lines[0] ?? '') ||
        `git ${args[0] ?? ''} exited with code ${code}`;
      finish({ ok: false, missing: false, message });
    });
  });
}

export interface FolderGit {
  readonly status: ProjectGitStatus;
  readonly remotes: GitRemote[];
  readonly primary: string | null;
  readonly branch: string | null;
  readonly message: string | null;
}

const none = (status: ProjectGitStatus, message: string | null = null): FolderGit => ({
  status,
  remotes: [],
  primary: null,
  branch: null,
  message,
});

const withRemotes = (remotes: GitRemote[], branch: string | null): FolderGit => ({
  status: remotes.length === 0 ? 'noRemote' : 'ok',
  remotes,
  primary: primaryRemote(remotes)?.name ?? null,
  branch,
  message: null,
});

// Without git on the PATH, the folder's own .git/config still names the remotes.
async function readConfigDirectly(folder: string): Promise<FolderGit> {
  const dotGit = path.join(folder, '.git');
  const found = await stat(dotGit).catch(() => undefined);
  if (!found) return none('gitUnavailable', 'git was not found on the PATH');
  if (!found.isDirectory()) return none('gitUnavailable', 'git was not found on the PATH');
  const text = await readFile(path.join(dotGit, 'config'), 'utf8').catch(() => undefined);
  if (text === undefined) return none('gitUnavailable', 'git was not found on the PATH');
  const head = await readFile(path.join(dotGit, 'HEAD'), 'utf8').catch(() => '');
  const branch = /^ref:\s*refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim() ?? null;
  return withRemotes(parseGitConfigRemotes(text), branch);
}

export async function readFolderGit(folder: string, options: GitRunOptions): Promise<FolderGit> {
  const found = await stat(folder).catch(() => undefined);
  if (!found?.isDirectory()) return none('folderMissing');
  const repository = await runGit(folder, ['rev-parse', '--git-dir'], options);
  if (!repository.ok) {
    if (repository.missing) return readConfigDirectly(folder);
    return none(
      'noRepository',
      /not a git repository/i.test(repository.message) ? null : repository.message,
    );
  }
  const [remotes, branch] = await Promise.all([
    runGit(folder, ['remote', '-v'], options),
    runGit(folder, ['symbolic-ref', '--quiet', '--short', 'HEAD'], options),
  ]);
  if (!remotes.ok) return none('noRemote', remotes.message);
  return withRemotes(
    parseRemoteList(remotes.stdout),
    branch.ok ? branch.stdout.trim() || null : null,
  );
}

// Branch names and the subjects and bodies of the newest commits, for guessJiraKeys. Empty when
// the folder is not a repository or has no commits yet.
export async function readHistoryTexts(
  folder: string,
  commits: number,
  options: GitRunOptions,
): Promise<string[]> {
  if (commits <= 0) return [];
  const [log, branches] = await Promise.all([
    runGit(folder, ['log', `-n${commits}`, '--format=%s%n%b'], options),
    runGit(folder, ['branch', '--format=%(refname:short)'], options),
  ]);
  return [...(branches.ok ? branches.stdout.split('\n') : []), ...(log.ok ? [log.stdout] : [])]
    .map((text) => text.trim())
    .filter((text) => text !== '');
}

// What a run's Changes tab needs (review loop spec 10 to 13). Everything below only reads: no
// index refresh is written (optional locks are off) and no object is added.

export type HeadCommit =
  | { readonly status: 'ok'; readonly sha: string }
  | {
      readonly status: 'noCommit' | 'noRepository' | 'gitUnavailable' | 'folderMissing';
      readonly message: string | null;
    };

// The commit the folder is on. `noCommit` is a repository that has none yet.
export async function readHeadCommit(folder: string, options: GitRunOptions): Promise<HeadCommit> {
  const found = await stat(folder).catch(() => undefined);
  if (!found?.isDirectory()) return { status: 'folderMissing', message: null };
  const repository = await runGit(folder, ['rev-parse', '--git-dir'], options);
  if (!repository.ok) {
    if (repository.missing) {
      return { status: 'gitUnavailable', message: 'git was not found on the PATH' };
    }
    return {
      status: 'noRepository',
      message: /not a git repository/i.test(repository.message) ? null : repository.message,
    };
  }
  const head = await runGit(folder, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], options);
  const sha = head.ok ? head.stdout.trim() : '';
  return sha === '' ? { status: 'noCommit', message: null } : { status: 'ok', sha };
}

export interface ChangedPath {
  // Relative to the folder, with forward slashes, as git names it.
  readonly path: string;
  readonly oldPath: string | null;
  readonly status: DiffFileStatus;
  // False for a new file git does not know yet; its lines are not counted here.
  readonly tracked: boolean;
  readonly added: number | null;
  readonly removed: number | null;
  readonly binary: boolean;
}

export type ChangedPaths =
  | { readonly ok: true; readonly files: ChangedPath[] }
  | { readonly ok: false; readonly baseMissing: boolean; readonly message: string };

// Compares the folder as it is now with the base commit, so committed and uncommitted work both
// count. Line endings follow the repository's attributes, because git converts the working file
// the way a commit would before it compares. The folder may be a subfolder of its repository.
const diffArgs = (base: string, renames: boolean) => [
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--relative',
  renames ? '-M' : '--no-renames',
  base,
];

const statusOf = (letter: string): DiffFileStatus =>
  letter === 'A' || letter === 'C'
    ? 'added'
    : letter === 'D'
      ? 'deleted'
      : letter === 'R'
        ? 'renamed'
        : 'modified';

const records = (output: string) => {
  const parts = output.split('\0');
  // The output ends with a NUL, which leaves one empty piece.
  if (parts.at(-1) === '') parts.pop();
  return parts;
};

// `--name-status -z`: "M", path; or "R100", old path, new path.
export function parseNameStatus(
  output: string,
): Pick<ChangedPath, 'path' | 'oldPath' | 'status'>[] {
  const parts = records(output);
  const files: Pick<ChangedPath, 'path' | 'oldPath' | 'status'>[] = [];
  for (let at = 0; at < parts.length;) {
    const letter = (parts[at] ?? '').charAt(0);
    const moved = letter === 'R' || letter === 'C';
    const oldPath = moved ? (parts[at + 1] ?? '') : null;
    const filePath = parts[at + (moved ? 2 : 1)] ?? '';
    at += moved ? 3 : 2;
    if (filePath === '') continue;
    files.push({
      path: filePath,
      oldPath: letter === 'R' ? oldPath : null,
      status: statusOf(letter),
    });
  }
  return files;
}

export interface LineCount {
  readonly added: number | null;
  readonly removed: number | null;
  readonly binary: boolean;
}

// `--numstat -z`: "3<tab>1<tab>path", or "3<tab>1<tab>" followed by the old and the new path of
// a rename. A binary file has "-" for both counts.
export function parseNumstat(output: string): Map<string, LineCount> {
  const parts = records(output);
  const counts = new Map<string, LineCount>();
  for (let at = 0; at < parts.length;) {
    const [added = '', removed = '', name = ''] = (parts[at] ?? '').split('\t');
    const filePath = name === '' ? (parts[at + 2] ?? '') : name;
    at += name === '' ? 3 : 1;
    const binary = added === '-' || removed === '-';
    counts.set(filePath, {
      added: binary ? null : Number(added),
      removed: binary ? null : Number(removed),
      binary,
    });
  }
  return counts;
}

// Every file that differs from the base: tracked files by what git compares, and new files git
// does not ignore. `renames` off lists a moved file as one deleted and one added path, which is
// what a per-path content hash needs.
export async function listChangedPaths(
  folder: string,
  base: string,
  options: GitRunOptions,
  renames = true,
): Promise<ChangedPaths> {
  const known = await runGit(folder, ['cat-file', '-e', `${base}^{commit}`], options);
  if (!known.ok) return { ok: false, baseMissing: !known.missing, message: known.message };
  const [names, counts, untracked] = await Promise.all([
    runGit(folder, [...diffArgs(base, renames), '--name-status', '-z', '--'], options),
    runGit(folder, [...diffArgs(base, renames), '--numstat', '-z', '--'], options),
    runGit(folder, ['ls-files', '--others', '--exclude-standard', '-z'], options),
  ]);
  for (const result of [names, counts, untracked]) {
    if (!result.ok) return { ok: false, baseMissing: false, message: result.message };
  }
  if (!names.ok || !counts.ok || !untracked.ok) throw new Error('unreachable');
  const lines = parseNumstat(counts.stdout);
  const files = new Map<string, ChangedPath>();
  for (const entry of parseNameStatus(names.stdout)) {
    const count = lines.get(entry.path);
    files.set(entry.path, {
      ...entry,
      tracked: true,
      added: count?.added ?? null,
      removed: count?.removed ?? null,
      binary: count?.binary ?? false,
    });
  }
  for (const filePath of records(untracked.stdout)) {
    // A folder that is a repository of its own is listed with a trailing slash; it is not a file.
    if (filePath === '' || filePath.endsWith('/') || files.has(filePath)) continue;
    files.set(filePath, {
      path: filePath,
      oldPath: null,
      status: 'added',
      tracked: false,
      added: null,
      removed: null,
      binary: false,
    });
  }
  return {
    ok: true,
    files: [...files.values()].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

// One tracked file's unified diff against the base, from its first hunk on ('' when only the
// name or the mode changed). Undefined when git fails, which includes a diff too long to hold.
export async function readPatch(
  folder: string,
  base: string,
  file: Pick<ChangedPath, 'path' | 'oldPath'>,
  options: GitRunOptions,
): Promise<string | undefined> {
  const paths = file.oldPath === null ? [file.path] : [file.oldPath, file.path];
  const result = await runGit(folder, [...diffArgs(base, true), '--', ...paths], options);
  if (!result.ok) return undefined;
  const text = result.stdout;
  const start = text.startsWith('@@') ? 0 : text.indexOf('\n@@');
  return start === -1 ? '' : text.slice(start === 0 ? 0 : start + 1);
}

// How many paths one command names, so a long list never meets the command line's length limit
// on Windows.
const pathsPerCommand = 100;

// The size each path had in the base commit. Paths the base does not hold are left out.
export async function readBaseSizes(
  folder: string,
  base: string,
  paths: readonly string[],
  options: GitRunOptions,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (let at = 0; at < paths.length; at += pathsPerCommand) {
    const chunk = paths.slice(at, at + pathsPerCommand);
    const result = await runGit(folder, ['ls-tree', '-l', '-z', base, '--', ...chunk], options);
    if (!result.ok) continue;
    for (const record of records(result.stdout)) {
      const match = /^\d+ blob [0-9a-f]+ +(\d+)\t([\s\S]+)$/.exec(record);
      if (match) sizes.set(match[2] ?? '', Number(match[1]));
    }
  }
  return sizes;
}

// What a run's own working copy needs (review loop spec 36 to 38). These are the only git
// commands wow runs that write: a fetch into the project's repository and a worktree beside it.
// Hooks stay off as for every other command, so making a working copy runs nothing a repository
// declares.

export type GitOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

const outcomeOf = (result: GitResult): GitOutcome =>
  result.ok ? { ok: true } : { ok: false, message: result.message };

// Brings the remote's branches up to date in the project's repository. Tags and submodules are
// left alone, and nothing in the project folder itself changes.
export async function fetchRemote(
  folder: string,
  remote: string,
  options: GitRunOptions,
): Promise<GitOutcome> {
  return outcomeOf(
    await runGit(
      folder,
      ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', remote],
      options,
    ),
  );
}

// Fetches one ref of the remote (a pull request's `refs/pull/<n>/head`) without storing it under
// a name, so its commit can be checked out by sha.
export async function fetchRemoteRef(
  folder: string,
  remote: string,
  ref: string,
  options: GitRunOptions,
): Promise<GitOutcome> {
  return outcomeOf(
    await runGit(
      folder,
      ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--end-of-options', remote, ref],
      options,
    ),
  );
}

// The branch the remote calls its default (`refs/remotes/<remote>/HEAD`, which a clone sets), or
// null when the repository does not say.
export async function readRemoteDefaultBranch(
  folder: string,
  remote: string,
  options: GitRunOptions,
): Promise<string | null> {
  const prefix = `refs/remotes/${remote}/`;
  const head = await runGit(folder, ['symbolic-ref', '--quiet', `${prefix}HEAD`], options);
  const ref = head.ok ? head.stdout.trim() : '';
  return ref.startsWith(prefix) && ref.length > prefix.length ? ref.slice(prefix.length) : null;
}

// Asks the remote itself which branch is its default, for a repository that was not cloned and
// so never stored it. Null when the remote does not answer or does not say.
export async function askRemoteDefaultBranch(
  folder: string,
  remote: string,
  options: GitRunOptions,
): Promise<string | null> {
  const listed = await runGit(folder, ['ls-remote', '--symref', remote, 'HEAD'], options);
  if (!listed.ok) return null;
  return /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(listed.stdout)?.[1] ?? null;
}

// The commit a ref names, or null when there is none.
export async function readCommit(
  folder: string,
  ref: string,
  options: GitRunOptions,
): Promise<string | null> {
  const found = await runGit(
    folder,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
    options,
  );
  const sha = found.ok ? found.stdout.trim() : '';
  return sha === '' ? null : sha;
}

// The branch the folder is on, or null on no branch.
export async function readCurrentBranch(
  folder: string,
  options: GitRunOptions,
): Promise<string | null> {
  const branch = await runGit(folder, ['symbolic-ref', '--quiet', '--short', 'HEAD'], options);
  return branch.ok ? branch.stdout.trim() || null : null;
}

// Windows refuses paths over 260 characters unless git is told to use long ones.
const longPaths = ['-c', 'core.longpaths=true'];

// A worktree of the project's repository at `target`, on the commit and on no branch.
export async function addWorktree(
  folder: string,
  target: string,
  commit: string,
  options: GitRunOptions,
): Promise<GitOutcome> {
  return outcomeOf(
    await runGit(folder, ['worktree', 'add', '--detach', target, commit], options, longPaths),
  );
}

// A worktree on a branch the repository has. Git refuses when another folder is on the branch.
export async function addBranchWorktree(
  folder: string,
  target: string,
  branch: string,
  options: GitRunOptions,
): Promise<GitOutcome> {
  return outcomeOf(await runGit(folder, ['worktree', 'add', target, branch], options, longPaths));
}

// A worktree on a new branch made at `commit`, for a chat thread's own working copy (thread work
// spec 11). Git refuses when the branch exists, which is the reason the thread's turn fails with.
export async function addNewBranchWorktree(
  folder: string,
  target: string,
  branch: string,
  commit: string,
  options: GitRunOptions,
): Promise<GitOutcome> {
  return outcomeOf(
    await runGit(folder, ['worktree', 'add', '-b', branch, target, commit], options, longPaths),
  );
}

// Whether git takes the name as a branch (`check-ref-format --branch`), with git's reason when
// not.
export async function checkBranchName(
  folder: string,
  branch: string,
  options: GitRunOptions,
): Promise<GitOutcome> {
  const checked = await runGit(folder, ['check-ref-format', '--branch', branch], options);
  if (checked.ok) return { ok: true };
  return {
    ok: false,
    message: checked.missing ? checked.message : `${branch} is not a name Git takes for a branch`,
  };
}

// A worktree on a new local branch that follows the remote's branch of the same name.
export async function addTrackingWorktree(
  folder: string,
  target: string,
  branch: string,
  remote: string,
  options: GitRunOptions,
): Promise<GitOutcome> {
  return outcomeOf(
    await runGit(
      folder,
      ['worktree', 'add', '--track', '-b', branch, target, `${remote}/${branch}`],
      options,
      longPaths,
    ),
  );
}

// Removes the worktree and its folder. Without `force` git refuses when a tracked file is
// changed or an untracked one is there, which is the last guard against losing work.
export async function removeWorktree(
  folder: string,
  target: string,
  force: boolean,
  options: GitRunOptions,
): Promise<GitOutcome> {
  return outcomeOf(
    await runGit(
      folder,
      ['worktree', 'remove', ...(force ? ['--force'] : []), target],
      options,
      longPaths,
    ),
  );
}

// Forgets worktrees whose folder is gone.
export async function pruneWorktrees(folder: string, options: GitRunOptions): Promise<GitOutcome> {
  return outcomeOf(await runGit(folder, ['worktree', 'prune'], options));
}

// The tips the history of a ref names (`git reflog`), oldest last; none when it has no history.
async function reflogTips(folder: string, ref: string, options: GitRunOptions) {
  const shown = await runGit(folder, ['reflog', 'show', '--format=%H', ref], options);
  return shown.ok ? shown.stdout.split('\n').filter((sha) => sha !== '') : [];
}

// Whether the branch's history has only its making in it: no commit, reset or rename since.
export async function branchNeverMoved(
  folder: string,
  branch: string,
  options: GitRunOptions,
): Promise<boolean> {
  return (await reflogTips(folder, `refs/heads/${branch}`, options)).length === 1;
}

// Commits HEAD of the folder has been on that no branch, tag or remote reaches and that were not
// made on one of `branches` either: commits made on no branch, gone with the folder. A commit
// amended or reset away on a branch is in that branch's history and not counted. Undefined when
// git cannot say.
export async function listCommitsOnNoBranch(
  folder: string,
  branches: readonly string[],
  options: GitRunOptions,
): Promise<readonly string[] | undefined> {
  const [visited, ...made] = await Promise.all([
    reflogTips(folder, 'HEAD', options),
    ...branches.map((branch) => reflogTips(folder, `refs/heads/${branch}`, options)),
  ]);
  const tips = ['HEAD', ...new Set(visited)];
  const known = [...new Set(made.flat())];
  const counted = await runGit(
    folder,
    ['rev-list', ...tips, '--not', '--branches', '--tags', '--remotes', ...known],
    options,
  );
  if (!counted.ok) return undefined;
  return counted.stdout.split('\n').filter((sha) => sha !== '');
}

export interface Unpushed {
  readonly uncommittedFiles: number;
  readonly ignoredFiles: number;
  readonly unpushedCommits: number;
  readonly newestSubject: string | null;
  readonly branch: string | null;
}

// What the folder holds that would be gone with it: files that are changed or new and not
// committed, ignored files, each one inside an ignored folder counted (git keeps nothing of them,
// and a file the agent wrote there may be the only copy), and commits that neither a branch on a
// remote nor the commit the folder started at reaches. Undefined when git cannot say.
export async function readUnpushed(
  folder: string,
  startSha: string | null,
  options: GitRunOptions,
): Promise<Unpushed | undefined> {
  return (await readUnpushedWithStatus(folder, startSha, options))?.unpushed;
}

// As readUnpushed, with git's status listing (`--porcelain=v1 -z`, ignored paths included) the
// counts were read from.
export async function readUnpushedWithStatus(
  folder: string,
  startSha: string | null,
  options: GitRunOptions,
): Promise<{ readonly unpushed: Unpushed; readonly status: string } | undefined> {
  const reached = ['--not', '--remotes', ...(startSha === null ? [] : [startSha])];
  // Every commit HEAD has been on, not only where it is now: a working copy starts on no branch,
  // so a commit made there and then left (by switching to another commit or branch) is reached
  // by nothing but this folder's own history of HEAD, which goes away with the folder.
  const visited = await runGit(folder, ['reflog', 'show', '--format=%H', 'HEAD'], options);
  const tips = [
    'HEAD',
    ...new Set(visited.ok ? visited.stdout.split('\n').filter((sha) => sha !== '') : []),
  ];
  const [status, count, newest, branch] = await Promise.all([
    runGit(
      folder,
      // `traditional` with every untracked file names each file inside a wholly ignored folder;
      // `matching` names the folder once, so a file added there later would go unseen.
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=traditional'],
      options,
    ),
    runGit(folder, ['rev-list', '--count', ...tips, ...reached], options),
    runGit(folder, ['log', '-n1', '--format=%s', ...tips, ...reached], options),
    readCurrentBranch(folder, options),
  ]);
  if (!status.ok || !count.ok) return undefined;
  let uncommittedFiles = 0;
  let ignoredFiles = 0;
  const entries = records(status.stdout);
  for (let at = 0; at < entries.length; at += 1) {
    if (entries[at]?.startsWith('!!')) {
      ignoredFiles += 1;
      continue;
    }
    uncommittedFiles += 1;
    // A rename or copy is followed by the path it came from.
    if (/^[RC]|^.[RC]/.test(entries[at] ?? '')) at += 1;
  }
  const unpushedCommits = Number(count.stdout.trim());
  if (!Number.isInteger(unpushedCommits)) return undefined;
  const subject = newest.ok ? newest.stdout.trim() : '';
  return {
    unpushed: {
      uncommittedFiles,
      ignoredFiles,
      unpushedCommits,
      newestSubject: unpushedCommits > 0 && subject !== '' ? subject : null,
      branch,
    },
    status: status.stdout,
  };
}

// Snapshots of a chat thread's folder (thread work spec 19 to 26) live in wow's own bare
// repository, so every command that writes runs with `GIT_DIR` set to it and nothing is written
// to the user's repository. Only `readSnapshotRepository` and `listSnapshotFiles` run in the
// user's repository, and they only read. Bytes go in and out as they are: no filter, no hook,
// no file system monitor.

export type StoreGitResult =
  | { readonly ok: true; readonly stdout: Buffer }
  | { readonly ok: false; readonly missing: boolean; readonly message: string };

export interface StoreGitCall {
  // The folder git runs in; paths given to it are relative to this folder.
  readonly cwd: string;
  // wow's repository, set as `GIT_DIR`; undefined for a command in the user's repository.
  readonly store?: string | undefined;
  // A temporary index of wow's, set as `GIT_INDEX_FILE`.
  readonly index?: string | undefined;
  readonly input?: Buffer | undefined;
  // Output past this many bytes stops git.
  readonly maxBytes: number;
}

// The git environment with nothing left that could point git at another repository than the
// one the call names.
function storeEnvironment(call: StoreGitCall): NodeJS.ProcessEnv {
  const env = gitEnvironment(process.env);
  for (const name of [
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_WORK_TREE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_NAMESPACE',
  ]) {
    delete env[name];
  }
  if (call.store !== undefined) env['GIT_DIR'] = call.store;
  if (call.index !== undefined) env['GIT_INDEX_FILE'] = call.index;
  return env;
}

// Like `runGit`, with bytes on stdin and stdout and the store's environment.
export function runStoreGit(
  args: readonly string[],
  call: StoreGitCall,
  options: GitRunOptions,
): Promise<StoreGitResult> {
  return new Promise((resolve) => {
    const child = spawn(
      options.git ?? 'git',
      [...neverRun, ...plainPaths, '-c', 'gc.auto=0', '-C', call.cwd, ...args],
      { windowsHide: true, env: storeEnvironment(call), stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stop = options.stop ?? stopProcessTree();
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let stopped: string | undefined;
    let done = false;
    let afterStop: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: StoreGitResult) => {
      if (done) return;
      done = true;
      clearTimeout(limit);
      clearTimeout(afterStop);
      resolve(result);
    };
    const stopGit = (reason: string) => {
      if (stopped !== undefined) return;
      stopped = reason;
      stop(child);
      afterStop = setTimeout(
        () => finish({ ok: false, missing: false, message: reason }),
        options.stopWaitMs,
      );
    };
    const limit = setTimeout(
      () => stopGit(`git did not finish within ${options.timeoutMs} ms and was stopped`),
      options.timeoutMs,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > call.maxBytes) stopGit('git wrote more than wow reads');
      else chunks.push(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    // A git that stops reading early closes stdin; its exit code says why.
    child.stdin.on('error', () => undefined);
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (stopped !== undefined) return;
      finish({ ok: false, missing: error.code === 'ENOENT', message: error.message });
    });
    child.on('close', (code) => {
      if (stopped !== undefined) return finish({ ok: false, missing: false, message: stopped });
      if (code === 0) return finish({ ok: true, stdout: Buffer.concat(chunks) });
      const lines = stderr.trim().split(/\r?\n/);
      const message =
        (lines.find((line) => /^(fatal|error):/.test(line)) ?? lines[0] ?? '') ||
        `git ${args[0] ?? ''} exited with code ${code}`;
      finish({ ok: false, missing: false, message });
    });
    child.stdin.end(call.input ?? Buffer.alloc(0));
  });
}

// Where the folder is in Git: `ok`, or why not.
export type SnapshotRepository =
  | { readonly status: 'ok' }
  | { readonly status: 'noRepository' | 'gitUnavailable'; readonly message: string };

export async function readSnapshotRepository(
  folder: string,
  options: GitRunOptions,
): Promise<SnapshotRepository> {
  const found = await runStoreGit(
    ['rev-parse', '--is-inside-work-tree'],
    { cwd: folder, maxBytes: 4096 },
    options,
  );
  if (found.ok && found.stdout.toString('utf8').trim() === 'true') return { status: 'ok' };
  if (!found.ok && found.missing) {
    return {
      status: 'gitUnavailable',
      message:
        'git was not found, so wow keeps no snapshots of the files and cannot put them back.',
    };
  }
  return {
    status: 'noRepository',
    message:
      "The thread's folder is not in a Git repository, so wow keeps no snapshots of its files.",
  };
}

// Every file Git tracks and every untracked file it does not ignore, relative to `folder`, with
// forward slashes, each once (a file in a merge is listed once per side).
export async function listSnapshotFiles(
  folder: string,
  maxBytes: number,
  options: GitRunOptions,
): Promise<
  { readonly ok: true; readonly paths: string[] } | { readonly ok: false; readonly message: string }
> {
  const listed = await runStoreGit(
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: folder, maxBytes },
    options,
  );
  if (!listed.ok) return { ok: false, message: listed.message };
  const paths = new Set(
    listed.stdout
      .toString('utf8')
      .split('\0')
      .filter((entry) => entry !== ''),
  );
  return { ok: true, paths: [...paths] };
}

export async function initSnapshotStore(
  store: string,
  options: GitRunOptions,
): Promise<GitOutcome> {
  const made = await runStoreGit(
    ['init', '--bare', '--quiet', store],
    { cwd: path.dirname(store), maxBytes: 64 * 1024 },
    options,
  );
  return made.ok ? { ok: true } : { ok: false, message: made.message };
}

// Writes each file's exact bytes into the store and answers their blob ids, in order. Paths are
// relative to `cwd` or absolute; a path with a line break cannot be given this way.
export async function hashSnapshotFiles(
  store: string,
  cwd: string,
  paths: readonly string[],
  options: GitRunOptions,
): Promise<
  { readonly ok: true; readonly ids: string[] } | { readonly ok: false; readonly message: string }
> {
  if (paths.length === 0) return { ok: true, ids: [] };
  const hashed = await runStoreGit(
    ['hash-object', '--no-filters', '-w', '--stdin-paths'],
    {
      cwd,
      store,
      input: Buffer.from(`${paths.join('\n')}\n`, 'utf8'),
      maxBytes: paths.length * 80 + 1024,
    },
    options,
  );
  if (!hashed.ok) return { ok: false, message: hashed.message };
  const ids = hashed.stdout
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '');
  if (ids.length !== paths.length) {
    return { ok: false, message: 'git hashed fewer files than it was given' };
  }
  return { ok: true, ids };
}

export interface SnapshotEntry {
  // 100644, 100755 or 120000 (a link, whose blob is the link's target).
  readonly mode: string;
  readonly id: string;
  readonly path: string;
  // The blob's size, when read back from a tree.
  readonly size?: number | undefined;
}

// The tree of the entries, made with a temporary index of wow's.
export async function writeSnapshotTree(
  store: string,
  index: string,
  entries: readonly SnapshotEntry[],
  options: GitRunOptions,
): Promise<
  { readonly ok: true; readonly tree: string } | { readonly ok: false; readonly message: string }
> {
  const lines = entries.map((entry) => `${entry.mode} ${entry.id}\t${entry.path}\0`).join('');
  const filled = await runStoreGit(
    ['update-index', '--add', '-z', '--index-info'],
    { cwd: store, store, index, input: Buffer.from(lines, 'utf8'), maxBytes: 64 * 1024 },
    options,
  );
  if (!filled.ok) return { ok: false, message: filled.message };
  const written = await runStoreGit(
    ['write-tree'],
    { cwd: store, store, index, maxBytes: 4096 },
    options,
  );
  if (!written.ok) return { ok: false, message: written.message };
  return { ok: true, tree: written.stdout.toString('utf8').trim() };
}

// Keeps (or with null drops) refs in the store, so its objects stay.
export async function updateSnapshotRefs(
  store: string,
  refs: readonly { readonly ref: string; readonly id: string | null }[],
  options: GitRunOptions,
): Promise<GitOutcome> {
  if (refs.length === 0) return { ok: true };
  const lines = refs
    .map(({ ref, id }) => (id === null ? `delete ${ref}\n` : `update ${ref} ${id}\n`))
    .join('');
  const updated = await runStoreGit(
    ['update-ref', '--stdin'],
    { cwd: store, store, input: Buffer.from(lines, 'utf8'), maxBytes: 64 * 1024 },
    options,
  );
  return updated.ok ? { ok: true } : { ok: false, message: updated.message };
}

// Drops the objects no ref keeps any more.
export async function pruneSnapshotStore(
  store: string,
  options: GitRunOptions,
): Promise<GitOutcome> {
  const pruned = await runStoreGit(
    ['prune', '--expire=now'],
    { cwd: store, store, maxBytes: 1024 * 1024 },
    options,
  );
  return pruned.ok ? { ok: true } : { ok: false, message: pruned.message };
}

// Every file of a snapshot tree, with its size.
export async function readSnapshotTree(
  store: string,
  tree: string,
  maxBytes: number,
  options: GitRunOptions,
): Promise<
  | { readonly ok: true; readonly entries: SnapshotEntry[] }
  | { readonly ok: false; readonly message: string }
> {
  const listed = await runStoreGit(
    ['ls-tree', '-r', '-l', '-z', '--full-tree', tree],
    { cwd: store, store, maxBytes },
    options,
  );
  if (!listed.ok) return { ok: false, message: listed.message };
  const entries: SnapshotEntry[] = [];
  for (const record of listed.stdout.toString('utf8').split('\0')) {
    const match = /^(\d{6}) blob ([0-9a-f]+) +(\d+)\t(.+)$/s.exec(record);
    if (match) {
      entries.push({
        mode: match[1] ?? '',
        id: match[2] ?? '',
        size: Number(match[3]),
        path: match[4] ?? '',
      });
    }
  }
  return { ok: true, entries };
}

// The bytes of the blobs, by id (`cat-file --batch`), in one read.
export async function readSnapshotBlobs(
  store: string,
  ids: readonly string[],
  maxBytes: number,
  options: GitRunOptions,
): Promise<
  | { readonly ok: true; readonly blobs: Map<string, Buffer> }
  | { readonly ok: false; readonly message: string }
> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return { ok: true, blobs: new Map() };
  const read = await runStoreGit(
    ['cat-file', '--batch'],
    {
      cwd: store,
      store,
      input: Buffer.from(`${wanted.join('\n')}\n`, 'utf8'),
      maxBytes: maxBytes + wanted.length * 100,
    },
    options,
  );
  if (!read.ok) return { ok: false, message: read.message };
  const blobs = new Map<string, Buffer>();
  const out = read.stdout;
  let at = 0;
  while (at < out.length) {
    const end = out.indexOf(0x0a, at);
    if (end === -1) break;
    const header = out.subarray(at, end).toString('utf8');
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (!match) return { ok: false, message: `git could not read ${header}` };
    const size = Number(match[2]);
    blobs.set(match[1] ?? '', out.subarray(end + 1, end + 1 + size));
    at = end + 1 + size + 1;
  }
  return { ok: true, blobs };
}

// Commit and push from a chat thread's Changes (thread work spec 27 to 36). `commitPaths` and
// `pushBranch` are the only git commands of wow that run the repository's hooks: they run
// without the `core.hooksPath` override every other command has, on the user's click only, and
// never with `--no-verify`. Nothing waits for an answer: no terminal prompt, no sign-in window of
// Git Credential Manager, no SSH passphrase or host key question.

// The environment of a command that runs hooks: the user's own, so a hook finds what it finds in
// a terminal, with nothing that asks. A pathspec is literal by its `:(literal)` magic here, not
// by GIT_LITERAL_PATHSPECS, which would change what the hooks' own git commands match.
export function hookGitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  };
  // A program that would show a password window is not asked either.
  delete env['GIT_ASKPASS'];
  delete env['SSH_ASKPASS'];
  env['SSH_ASKPASS_REQUIRE'] = 'never';
  if (!env['GIT_SSH_COMMAND'] && !env['GIT_SSH']) env['GIT_SSH_COMMAND'] = 'ssh -o BatchMode=yes';
  return env;
}

export interface HookGitOptions extends GitRunOptions {
  // `chat.commitOutputMaxBytes`: how much of what git and the hooks wrote is kept, from the end.
  readonly outputMaxBytes: number;
  // The environment the command starts from; the server's own when absent (tests pass theirs).
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
}

// A credential program named in the user's config (`core.askPass`) would show a password window
// even without GIT_ASKPASS, so it is emptied; `credential.interactive=never` does the same for
// Git Credential Manager. Neither is ever asked.
const neverAsk = ['-c', 'core.askPass=', '-c', 'credential.interactive=never'];

const runHookGit = (folder: string, args: readonly string[], options: HookGitOptions) =>
  execGit([...neverAsk, '-c', 'core.fsmonitor=false', ...plainPaths, '-C', folder, ...args], args, options, {
    env: hookGitEnvironment(options.baseEnv ?? process.env),
    tailBytes: options.outputMaxBytes,
  });

// `status --porcelain=v2 -z`: one entry per changed, deleted or new file Git does not ignore.
export interface StatusEntry {
  readonly path: string;
  // Where a renamed file was before, for a rename the index holds.
  readonly oldPath: string | null;
  // The index's and the working file's letter (`.` for none), `?` for an untracked file.
  readonly index: string;
  readonly worktree: string;
  readonly untracked: boolean;
  readonly unmerged: boolean;
}

export function parseStatusV2(output: string): StatusEntry[] {
  const parts = records(output);
  const entries: StatusEntry[] = [];
  for (let at = 0; at < parts.length; at += 1) {
    const record = parts[at] ?? '';
    const kind = record.charAt(0);
    if (kind === '?') {
      entries.push({
        path: record.slice(2),
        oldPath: null,
        index: '?',
        worktree: '?',
        untracked: true,
        unmerged: false,
      });
      continue;
    }
    // "1 XY sub mH mI mW hH hI path", "2 XY sub mH mI mW hH hI Xscore path" + NUL + old path,
    // "u XY sub m1 m2 m3 mW h1 h2 h3 path".
    const fields = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : 0;
    if (fields === 0) continue;
    const pieces = record.split(' ');
    const filePath = pieces.slice(fields).join(' ');
    const xy = pieces[1] ?? '..';
    const oldPath = kind === '2' ? (parts[at + 1] ?? null) : null;
    if (kind === '2') at += 1;
    if (filePath === '') continue;
    entries.push({
      path: filePath,
      oldPath,
      index: xy.charAt(0),
      worktree: xy.charAt(1),
      untracked: false,
      unmerged: kind === 'u',
    });
  }
  return entries;
}

export async function readStatusFiles(
  folder: string,
  options: GitRunOptions,
): Promise<
  | { readonly ok: true; readonly entries: StatusEntry[] }
  | { readonly ok: false; readonly message: string }
> {
  const status = await runGit(
    folder,
    ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames'],
    options,
  );
  if (!status.ok) return { ok: false, message: status.message };
  return { ok: true, entries: parseStatusV2(status.stdout) };
}

// The tree a repository without commits compares against.
const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Added and removed lines of every tracked file against HEAD, the index and the working file
// together (`diff HEAD --numstat`).
export async function readHeadLineCounts(
  folder: string,
  head: string | null,
  options: GitRunOptions,
): Promise<Map<string, LineCount>> {
  const counted = await runGit(
    folder,
    [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--numstat',
      '-z',
      head ?? emptyTree,
      '--',
    ],
    options,
  );
  return counted.ok ? parseNumstat(counted.stdout) : new Map();
}

// The diff of the files against HEAD, for a proposal; new files Git does not know yet are not in
// it. Undefined when git fails.
export async function readFilesPatch(
  folder: string,
  head: string | null,
  paths: readonly string[],
  options: GitRunOptions,
): Promise<string | undefined> {
  if (paths.length === 0) return '';
  const patch = await runGit(
    folder,
    [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      head ?? emptyTree,
      '--',
      ...paths.slice(0, pathsPerCommand),
    ],
    options,
  );
  return patch.ok ? patch.stdout : undefined;
}

// A merge, rebase, cherry-pick or revert the folder is in the middle of, in words, or null.
export async function readOperationInProgress(
  folder: string,
  options: GitRunOptions,
): Promise<string | null> {
  const markers = [
    ['MERGE_HEAD', 'a merge'],
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
  ] as const;
  const found = await runGit(
    folder,
    ['rev-parse', ...markers.flatMap(([name]) => ['--git-path', name])],
    options,
  );
  if (!found.ok) return null;
  const paths = found.stdout.split('\n').filter((line) => line !== '');
  for (const [index, [, words]] of markers.entries()) {
    const marker = paths[index];
    if (marker === undefined) continue;
    if (await stat(path.resolve(folder, marker)).catch(() => undefined)) return words;
  }
  return null;
}

// The hooks a commit runs, in the order git runs them.
export const commitHookNames = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit'];

// The commit hooks git would run in the folder, from the hooks folder git names (the
// repository's own, or `core.hooksPath`). Only `rev-parse` runs here, which runs no hook, so it
// is asked without the override that would name wow's empty hooks path instead. Git runs a hook
// only when it may execute the file; on Windows every file there counts, as Git for Windows runs
// it through its shell.
export async function readCommitHooks(
  folder: string,
  options: GitRunOptions,
  platform: NodeJS.Platform = process.platform,
): Promise<{ readonly hooksPath: string | null; readonly hooks: string[] }> {
  const found = await execGit(
    ['-c', 'core.fsmonitor=false', ...plainPaths, '-C', folder, 'rev-parse', '--git-path', 'hooks'],
    ['rev-parse'],
    options,
  );
  if (!found.ok) return { hooksPath: null, hooks: [] };
  const relative = found.stdout.trim();
  if (relative === '') return { hooksPath: null, hooks: [] };
  const folderPath = path.resolve(folder, relative);
  const names = new Set(await readdir(folderPath).catch(() => [] as string[]));
  const hooks: string[] = [];
  for (const name of commitHookNames) {
    if (!names.has(name)) continue;
    const file = path.join(folderPath, name);
    const entry = await stat(file).catch(() => undefined);
    if (!entry?.isFile()) continue;
    if (
      platform !== 'win32' &&
      !(await access(file, constants.X_OK).then(
        () => true,
        () => false,
      ))
    ) {
      continue;
    }
    hooks.push(name);
  }
  return { hooksPath: relative, hooks };
}

export type HookGitOutcome =
  | { readonly ok: true; readonly output: string }
  | {
      readonly ok: false;
      readonly missing: boolean;
      readonly message: string;
      readonly output: string;
    };

const hookOutcome = (result: ExecResult): HookGitOutcome =>
  result.ok
    ? { ok: true, output: result.output ?? '' }
    : {
        ok: false,
        missing: result.missing,
        message: result.message,
        output: result.output ?? '',
      };

// A pathspec file of wow's, one path per NUL, so no list meets the command line's length limit
// on Windows. Each path is literal: by GIT_LITERAL_PATHSPECS for wow's own commands, by the
// `:(literal)` magic (`magic`) for a command that runs hooks.
async function withPathspecs<T>(
  paths: readonly string[],
  message: string | undefined,
  magic: boolean,
  use: (files: { readonly paths: string; readonly message: string }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'wow-commit-'));
  try {
    const files = { paths: path.join(dir, 'paths'), message: path.join(dir, 'message') };
    const prefix = magic ? ':(literal)' : '';
    await writeFile(files.paths, paths.map((entry) => `${prefix}${entry}\0`).join(''));
    if (message !== undefined) await writeFile(files.message, message);
    return await use(files);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// HEAD's commit, or '' on a branch with no commit yet.
async function readHeadSha(folder: string, options: GitRunOptions): Promise<string> {
  const found = await runGit(folder, ['rev-parse', '--verify', '--quiet', 'HEAD'], options);
  return found.ok ? found.stdout.trim() : '';
}

// A commit that exists though git did not end well.
export interface CommitMadeOutcome {
  readonly ok: true;
  readonly output: string;
  readonly note: string;
}

// Commits exactly `paths` with the message (spec 29): new files are added first, then `commit`
// with the paths, which leaves whatever else is staged staged and uncommitted. The commit runs
// the repository's hooks as `git commit` in a terminal does, with the user's identity and
// settings; wow adds no trailer. When it is refused, the new files it added are taken out of the
// index again, so nothing changed. When git was stopped or failed after the commit was made (a
// post-commit hook that did not finish), HEAD has moved: the commit is reported as made, with a
// note, and the index is left alone.
export async function commitPaths(
  folder: string,
  change: {
    readonly paths: readonly string[];
    readonly newPaths: readonly string[];
    readonly message: string;
  },
  options: HookGitOptions,
): Promise<HookGitOutcome | CommitMadeOutcome> {
  const headBefore = await readHeadSha(folder, options);
  if (change.newPaths.length > 0) {
    const added = await withPathspecs(change.newPaths, undefined, false, (files) =>
      runGit(
        folder,
        ['add', `--pathspec-from-file=${files.paths}`, '--pathspec-file-nul'],
        options,
      ),
    );
    if (!added.ok) return { ok: false, missing: added.missing, message: added.message, output: '' };
  }
  const committed = await withPathspecs(change.paths, change.message, true, (files) =>
    runHookGit(
      folder,
      [
        'commit',
        '--quiet',
        '-F',
        files.message,
        `--pathspec-from-file=${files.paths}`,
        '--pathspec-file-nul',
      ],
      options,
    ),
  );
  if (!committed.ok && (await readHeadSha(folder, options)) !== headBefore) {
    return {
      ok: true,
      output: committed.output ?? '',
      note: `The commit was made, but Git did not finish after it: ${committed.message}. A hook did not finish.`,
    };
  }
  if (!committed.ok && change.newPaths.length > 0) {
    await withPathspecs(change.newPaths, undefined, false, (files) =>
      runGit(
        folder,
        [
          'rm',
          '--cached',
          '--quiet',
          '--ignore-unmatch',
          `--pathspec-from-file=${files.paths}`,
          '--pathspec-file-nul',
        ],
        options,
      ),
    );
  }
  return hookOutcome(committed);
}

// Makes a branch where the folder is and puts the folder on it, for a commit from a folder on no
// branch (spec 30). The files and the index stay as they are; no hook runs.
export async function switchToNewBranch(
  folder: string,
  branch: string,
  options: GitRunOptions,
): Promise<GitOutcome> {
  return outcomeOf(await runGit(folder, ['switch', '--quiet', '-c', branch], options));
}

// What git writes when it would have to ask for a password, a passphrase or a host key.
const asksForCredentials =
  /could not read (Username|Password)|terminal prompts disabled|Authentication failed|Permission denied \(|Host key verification failed|passphrase|askpass|no such identity|could not read from remote repository/i;

export type PushOutcome =
  | { readonly ok: true; readonly output: string }
  | {
      readonly ok: false;
      readonly missing: boolean;
      readonly message: string;
      readonly output: string;
      // Git would have asked for a password, a passphrase or a host key (spec 35).
      readonly needsCredentials: boolean;
    };

// Pushes the branch to the remote under the same name and sets it as the branch's upstream
// (spec 32). Never forced; the repository's pre-push hook runs. Git's own credentials only: a
// credential helper, an SSH agent. The host's API token is never given to git.
export async function pushBranch(
  folder: string,
  remote: string,
  branch: string,
  options: HookGitOptions,
): Promise<PushOutcome> {
  const ref = `refs/heads/${branch}`;
  const pushed = hookOutcome(
    await runHookGit(
      folder,
      ['push', '--porcelain', '--set-upstream', '--end-of-options', remote, `${ref}:${ref}`],
      { ...options, baseEnv: { ...(options.baseEnv ?? process.env), LC_ALL: 'C' } },
    ),
  );
  if (pushed.ok) return pushed;
  return {
    ...pushed,
    needsCredentials: asksForCredentials.test(`${pushed.message}\n${pushed.output}`),
  };
}

// The remote the branch's upstream is on, or null when it has none.
export async function readUpstreamRemote(
  folder: string,
  branch: string,
  options: GitRunOptions,
): Promise<string | null> {
  const found = await runGit(folder, ['config', '--get', `branch.${branch}.remote`], options);
  const remote = found.ok ? found.stdout.trim() : '';
  return remote === '' || remote === '.' ? null : remote;
}

// The branches the repository knows of the remote (`refs/remotes/<remote>/…`), as last fetched.
export async function listRemoteBranches(
  folder: string,
  remote: string,
  options: GitRunOptions,
): Promise<string[]> {
  const prefix = `refs/remotes/${remote}/`;
  const listed = await runGit(
    folder,
    ['for-each-ref', '--format=%(refname)', '--end-of-options', prefix],
    options,
  );
  if (!listed.ok) return [];
  return listed.stdout
    .split('\n')
    .filter((ref) => ref.startsWith(prefix))
    .map((ref) => ref.slice(prefix.length))
    .filter((name) => name !== 'HEAD' && name !== '');
}

// The commits `head` has that `base` does not, newest first, with subject and body.
export async function listCommitsAhead(
  folder: string,
  base: string | null,
  head: string,
  options: GitRunOptions,
): Promise<{ sha: string; subject: string; body: string }[] | undefined> {
  const listed = await runGit(
    folder,
    [
      'log',
      '--format=%H%x00%s%x00%b%x1e',
      '--end-of-options',
      head,
      ...(base === null ? [] : [`^${base}`]),
    ],
    options,
  );
  if (!listed.ok) return undefined;
  return listed.stdout
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record !== '')
    .map((record) => {
      const [sha = '', subject = '', body = ''] = record.split('\0');
      return { sha, subject, body: body.trim() };
    });
}

// How many commits `head` has that `base` does not; undefined when git cannot say.
export async function countCommitsAhead(
  folder: string,
  base: string | null,
  head: string,
  options: GitRunOptions,
): Promise<number | undefined> {
  const counted = await runGit(
    folder,
    ['rev-list', '--count', '--end-of-options', head, ...(base === null ? [] : [`^${base}`])],
    options,
  );
  const count = counted.ok ? Number(counted.stdout.trim()) : Number.NaN;
  return Number.isInteger(count) ? count : undefined;
}

// The paths the commits `head` has beyond `base` change.
export async function listPathsAhead(
  folder: string,
  base: string | null,
  head: string,
  options: GitRunOptions,
): Promise<string[]> {
  const listed = await runGit(
    folder,
    ['diff', '--no-ext-diff', '--name-only', '-z', base ?? emptyTree, head, '--'],
    options,
  );
  return listed.ok ? records(listed.stdout).filter((entry) => entry !== '') : [];
}

// The diff of the commits `head` has beyond `base`, for a pull request proposal.
export async function readRangePatch(
  folder: string,
  base: string | null,
  head: string,
  options: GitRunOptions,
): Promise<string | undefined> {
  const patch = await runGit(
    folder,
    ['diff', '--no-ext-diff', '--no-textconv', '--no-color', base ?? emptyTree, head, '--'],
    options,
  );
  return patch.ok ? patch.stdout : undefined;
}

// The newest commit's sha and subject.
export async function readHeadSubject(
  folder: string,
  options: GitRunOptions,
): Promise<{ sha: string; subject: string } | undefined> {
  const shown = await runGit(folder, ['log', '-n1', '--format=%H%x00%s'], options);
  if (!shown.ok) return undefined;
  const [sha = '', subject = ''] = shown.stdout.trim().split('\0');
  return sha === '' ? undefined : { sha, subject };
}
