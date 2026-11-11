import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gitEnvironment,
  guessJiraKeys,
  parseGitConfigRemotes,
  parseRemoteList,
  parseRemoteUrl,
  primaryRemote,
  readFolderGit,
  readHistoryTexts,
} from './git.js';

// Owner decision F-4: GitHub owner and repository come from the project folder's git remote,
// and Jira keys seen in its history are offered as a suggestion. All repositories here are
// invented and made in a temporary folder.

const github = (owner: string, repo: string) => ({
  owner,
  repo,
  host: 'github.com',
  apiBaseUrl: 'https://api.github.com',
  enterprise: false,
});

describe('gitEnvironment', () => {
  it('lets git ask for nothing: no terminal prompt and no Git Credential Manager window', () => {
    const env = gitEnvironment({ PATH: '/usr/bin', GCM_INTERACTIVE: 'auto' });
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
    });
  });
});

describe('parseRemoteUrl', () => {
  it.each([
    ['https://github.com/acme/widgets.git', github('acme', 'widgets')],
    ['https://github.com/acme/widgets', github('acme', 'widgets')],
    ['https://github.com/acme/widgets/', github('acme', 'widgets')],
    ['git@github.com:acme/widgets.git', github('acme', 'widgets')],
    ['ssh://git@github.com/acme/widgets.git', github('acme', 'widgets')],
    ['ssh://git@ssh.github.com:443/acme/widgets.git', github('acme', 'widgets')],
    ['git://github.com/acme/widgets.git', github('acme', 'widgets')],
    ['https://GitHub.com/Acme/Widgets.git', github('Acme', 'Widgets')],
  ])('reads %s as a github.com repository', (url, expected) => {
    expect(parseRemoteUrl('origin', url).github).toEqual(expected);
  });

  it('treats any other host with owner/repo as GitHub Enterprise Server', () => {
    for (const url of [
      'https://git.example.invalid/platform/billing.git',
      'git@git.example.invalid:platform/billing.git',
      'ssh://git@git.example.invalid:2222/platform/billing.git',
    ]) {
      expect({ url, github: parseRemoteUrl('origin', url).github }).toEqual({
        url,
        github: {
          owner: 'platform',
          repo: 'billing',
          host: 'git.example.invalid',
          apiBaseUrl: 'https://git.example.invalid/api/v3',
          enterprise: true,
        },
      });
    }
  });

  it('gives a <name>.ghe.com remote the API of GitHub Enterprise Cloud with data residency', () => {
    for (const url of [
      'https://octo.ghe.com/platform/billing.git',
      'git@Octo.ghe.com:platform/billing.git',
    ]) {
      expect({ url, github: parseRemoteUrl('origin', url).github }).toEqual({
        url,
        github: {
          owner: 'platform',
          repo: 'billing',
          host: 'octo.ghe.com',
          apiBaseUrl: 'https://api.octo.ghe.com',
          enterprise: true,
        },
      });
    }
  });

  it('drops user names and passwords from https remotes', () => {
    const remote = parseRemoteUrl('origin', 'https://me:s3cret@github.com/acme/widgets.git');
    expect(remote.url).toBe('https://github.com/acme/widgets.git');
    expect(JSON.stringify(remote)).not.toContain('s3cret');
  });

  it('offers no GitHub repository for other hosts, subgroups and local paths', () => {
    for (const url of [
      'git@gitlab.com:acme/widgets.git',
      'https://gitlab.example.invalid/acme/team/widgets.git',
      'https://bitbucket.org/acme/widgets.git',
      'https://dev.azure.com/acme/project/_git/widgets',
      '/srv/git/widgets.git',
      '../widgets',
      'C:\\code\\widgets',
      'file:///srv/git/widgets.git',
    ]) {
      expect({ url, github: parseRemoteUrl('origin', url).github }).toEqual({ url, github: null });
    }
    expect(parseRemoteUrl('origin', 'C:\\code\\widgets').host).toBeNull();
    expect(parseRemoteUrl('origin', '/srv/git/widgets.git').host).toBeNull();
  });
});

describe('remote lists and .git/config', () => {
  it('keeps one entry per remote, with its fetch URL', () => {
    const remotes = parseRemoteList(
      [
        'origin\tgit@github.com:me/widgets.git (fetch)',
        'origin\tgit@github.com:me/widgets-push.git (push)',
        'upstream\thttps://github.com/acme/widgets.git (fetch)',
        'upstream\thttps://github.com/acme/widgets.git (push)',
        '',
      ].join('\r\n'),
    );
    expect(remotes.map((remote) => [remote.name, remote.github?.owner])).toEqual([
      ['origin', 'me'],
      ['upstream', 'acme'],
    ]);
    expect(primaryRemote(remotes)?.name).toBe('origin');
  });

  it('prefers origin, then the first GitHub remote, then the first', () => {
    const lab = parseRemoteUrl('lab', 'git@gitlab.com:acme/widgets.git');
    const hub = parseRemoteUrl('hub', 'git@github.com:acme/widgets.git');
    expect(primaryRemote([lab, hub])?.name).toBe('hub');
    expect(primaryRemote([lab])?.name).toBe('lab');
    expect(primaryRemote([])).toBeUndefined();
  });

  it('reads remotes from a config file', () => {
    const text = [
      '[core]',
      '\trepositoryformatversion = 0',
      '[remote "origin"]',
      '\turl = https://github.com/acme/widgets.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '; a comment',
      '[remote "my \\"fork\\""]',
      '\tURL = "git@github.com:me/widgets.git"',
      '[branch "main"]',
      '\tremote = origin',
    ].join('\n');
    expect(parseGitConfigRemotes(text).map((remote) => [remote.name, remote.github?.repo])).toEqual(
      [
        ['origin', 'widgets'],
        ['my "fork"', 'widgets'],
      ],
    );
  });
});

describe('guessJiraKeys', () => {
  it('counts distinct issues per key and ignores look-alikes', () => {
    expect(
      guessJiraKeys([
        'feature/WOW-12-login',
        'WOW-12 Fix the login\nRefs WOW-14 and OPS-3',
        'Use UTF-8 and SHA-256 per RFC-7231',
        'WOW-15: tidy',
        'lowercase wow-16 and x-1 do not count',
      ]),
    ).toEqual([
      { key: 'WOW', issues: 3, example: 'WOW-12' },
      { key: 'OPS', issues: 1, example: 'OPS-3' },
    ]);
    expect(guessJiraKeys(['no keys here'])).toEqual([]);
  });
});

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

describe('readFolderGit', () => {
  let root: string;
  const options = { timeoutMs: 10_000 };
  const ceiling = process.env['GIT_CEILING_DIRECTORIES'];

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'wow-git-'));
    // The temporary folder must never be read as part of a repository around it.
    process.env['GIT_CEILING_DIRECTORIES'] = root;
  });
  afterAll(async () => {
    if (ceiling === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
    else process.env['GIT_CEILING_DIRECTORIES'] = ceiling;
    await rm(root, { recursive: true, force: true });
  });

  it('says when the folder is missing or not a repository', async () => {
    expect((await readFolderGit(path.join(root, 'gone'), options)).status).toBe('folderMissing');
    const plain = path.join(root, 'plain');
    await mkdir(plain);
    expect(await readFolderGit(plain, options)).toEqual({
      status: 'noRepository',
      remotes: [],
      primary: null,
      branch: null,
      message: null,
    });
  });

  it('reads remotes and the branch of a repository, and its history', async () => {
    const repo = path.join(root, 'widgets');
    await mkdir(repo);
    git(repo, 'init', '-q', '-b', 'main');
    expect((await readFolderGit(repo, options)).status).toBe('noRemote');
    git(repo, 'remote', 'add', 'upstream', 'https://github.com/acme/widgets.git');
    git(repo, 'remote', 'add', 'origin', 'git@github.com:me/widgets.git');
    git(repo, 'checkout', '-q', '-b', 'feature/WID-7-dark-mode');
    const found = await readFolderGit(repo, options);
    expect(found).toMatchObject({
      status: 'ok',
      primary: 'origin',
      branch: 'feature/WID-7-dark-mode',
    });
    expect(found.remotes.map((remote) => remote.name).toSorted()).toEqual(['origin', 'upstream']);

    // A repository without commits has no history and no branch list yet; the service adds the
    // current branch (`branch` above) itself.
    expect(await readHistoryTexts(repo, 50, options)).toEqual([]);
    for (const message of ['WID-8 Add the toggle', 'WID-9 Respect the system theme']) {
      git(
        repo,
        '-c',
        'user.name=Invented',
        '-c',
        'user.email=invented@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        message,
      );
    }
    expect(guessJiraKeys(await readHistoryTexts(repo, 50, options))[0]).toEqual({
      key: 'WID',
      issues: 3,
      example: 'WID-7',
    });
    expect(await readHistoryTexts(repo, 0, options)).toEqual([]);
  });

  it('reads .git/config itself when git cannot run', async () => {
    const repo = path.join(root, 'no-git');
    await mkdir(path.join(repo, '.git'), { recursive: true });
    await writeFile(
      path.join(repo, '.git', 'config'),
      '[remote "origin"]\n\turl = git@git.example.invalid:platform/billing.git\n',
    );
    await writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const missingGit = { ...options, git: path.join(root, 'no-such-git') };
    expect(await readFolderGit(repo, missingGit)).toMatchObject({
      status: 'ok',
      primary: 'origin',
      branch: 'main',
      remotes: [{ name: 'origin', github: { owner: 'platform', enterprise: true } }],
    });
    const plain = path.join(root, 'plain-no-git');
    await mkdir(plain);
    expect((await readFolderGit(plain, missingGit)).status).toBe('gitUnavailable');
  });
});
