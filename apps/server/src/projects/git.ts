import type { GitHubRemote, GitRemote, ProjectGitStatus } from '@wow/contracts';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
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

function runGit(folder: string, args: readonly string[], options: GitRunOptions) {
  return new Promise<GitResult>((resolve) => {
    execFile(
      options.git ?? 'git',
      ['-C', folder, ...args],
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
