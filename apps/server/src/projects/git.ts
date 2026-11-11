import type {
  DiffFileStatus,
  GitHubRemote,
  GitLabProject,
  GitRemote,
  ProjectGitStatus,
} from '@wow/contracts';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';

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
    apiBaseUrl: enterprise ? `https://${normalized}/api/v3` : 'https://api.github.com',
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
  // Replaces the git binary, for tests.
  readonly git?: string | undefined;
}

type GitResult = { ok: true; stdout: string } | { ok: false; missing: boolean; message: string };

// A repository's config can name programs git runs while it only reads: hooks, a file system
// monitor, and (per command) external diff and text conversion programs. wow runs none of them.
const neverRun = ['-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false'];
// Paths come back as they are, not quoted and escaped.
const plainPaths = ['-c', 'core.quotePath=false'];

function runGit(
  folder: string,
  args: readonly string[],
  options: GitRunOptions,
  config: readonly string[] = [],
) {
  return new Promise<GitResult>((resolve) => {
    execFile(
      options.git ?? 'git',
      [...neverRun, ...plainPaths, ...config, '-C', folder, ...args],
      {
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        env: {
          ...process.env,
          // Never wait for a password prompt or take an optional lock in the user's repository.
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          // A file name is a name, never a pattern.
          GIT_LITERAL_PATHSPECS: '1',
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, stdout });
        const code = (error as NodeJS.ErrnoException).code;
        const message = (stderr.trim().split(/\r?\n/)[0] ?? '') || error.message;
        resolve({ ok: false, missing: code === 'ENOENT', message });
      },
    );
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

export interface Unpushed {
  readonly uncommittedFiles: number;
  readonly unpushedCommits: number;
  readonly newestSubject: string | null;
  readonly branch: string | null;
}

// What the folder holds that would be gone with it: files that are changed or new and not
// committed (ignored files do not count), and commits that neither a branch on a remote nor the
// commit the folder started at reaches. Undefined when git cannot say.
export async function readUnpushed(
  folder: string,
  startSha: string | null,
  options: GitRunOptions,
): Promise<Unpushed | undefined> {
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
    runGit(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], options),
    runGit(folder, ['rev-list', '--count', ...tips, ...reached], options),
    runGit(folder, ['log', '-n1', '--format=%s', ...tips, ...reached], options),
    readCurrentBranch(folder, options),
  ]);
  if (!status.ok || !count.ok) return undefined;
  let uncommittedFiles = 0;
  const entries = records(status.stdout);
  for (let at = 0; at < entries.length; at += 1) {
    uncommittedFiles += 1;
    // A rename or copy is followed by the path it came from.
    if (/^[RC]|^.[RC]/.test(entries[at] ?? '')) at += 1;
  }
  const unpushedCommits = Number(count.stdout.trim());
  if (!Number.isInteger(unpushedCommits)) return undefined;
  const subject = newest.ok ? newest.stdout.trim() : '';
  return {
    uncommittedFiles,
    unpushedCommits,
    newestSubject: unpushedCommits > 0 && subject !== '' ? subject : null,
    branch,
  };
}
