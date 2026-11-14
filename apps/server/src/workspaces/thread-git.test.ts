import type { ProviderCommand, ProviderInstance, ServerCommand, Thread } from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { providerInstances, threadItems, threads, turns } from '../db/schema.js';
import { MockProviderAdapter } from '../hooks/index.js';
import { MockGitHub } from '../hosts/mock-github.js';
import { MockGitLab } from '../hosts/mock-gitlab.js';
import { startGit, type GitProcess, type StartGit } from '../projects/git.js';
import { startServer, type RunningServer } from '../server.js';
import { ThreadGit, ThreadGitRefused } from './thread-git.js';

// Thread work spec 27 to 36 against repositories the test makes: a project cloned from a bare
// remote, a chat thread in its own working copy whose invented agent edits src/bell.ts, hooks
// that leave a mark and one that refuses, and the mock GitHub and GitLab. Every folder has a space
// in its name, as a Windows user folder often does. All invented.

const TOKEN = 'invented-github-token-7f3a';
const GITLAB_TOKEN = 'invented-gitlab-token-91c2';
const api = 'https://github.example.test/api/v3';
const site = 'https://gitlab.example.test';

let root: string;
let home: string;
let project: string;
let remote: string;
let server: RunningServer;
let adapters: MockProviderAdapter[];
let github: MockGitHub;
let gitlab: MockGitLab;
// Every git the thread git service started, with its arguments and environment.
let calls: { args: string[]; env: NodeJS.ProcessEnv | undefined }[];
const ceiling = process.env['GIT_CEILING_DIRECTORIES'];

const git = (dir: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.name=Invented',
      '-c',
      'user.email=invented@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { stdio: 'pipe', encoding: 'utf8' },
  ).trim();

const instance: ProviderInstance = {
  id: 'claude-work',
  kind: 'claude',
  name: 'claude-work',
  binaryPath: 'claude',
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: 'opus',
  defaultEffort: 'high',
  defaultPermissionMode: 'default',
  status: 'ready',
  account: null,
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
};

let commandCount = 0;
const dispatch = (command: ServerCommand) =>
  server.engine.dispatch(`test-${(commandCount += 1)}`, command);

const thread = (): Thread =>
  server.database.db.select().from(threads).where(eq(threads.id, 't1')).get() as Thread;
const items = () =>
  server.database.db.select().from(threadItems).where(eq(threadItems.threadId, 't1')).all();
const lastTurn = () =>
  server.database.db
    .select()
    .from(turns)
    .where(eq(turns.threadId, 't1'))
    .all()
    .toSorted((a, b) => b.index - a.index)[0];

function turnEnds() {
  return new Promise<void>((resolve) => {
    const check = () => {
      const turn = lastTurn();
      if (turn && turn.state !== 'running') {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = server.engine.onCommit(check);
    check();
  });
}

const fetchBoth: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return url.startsWith(site) ? gitlab.fetch(site)(input, init) : github.fetch(api)(input, init);
};

// Git as the user's terminal would run it, but without their global or system config, so this
// machine's credential helpers and identity do not take part.
// The global config is a file that does not exist: Git on Windows cannot read the null device.
const baseEnv = () => ({
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(root, 'none'),
});
const recording: StartGit = (command, args, env) => {
  calls.push({ args, env });
  return startGit(command, args, env);
};

// Git that has made its commit and hooks, and then reports a failure: as one stopped for time in
// a slow post-commit hook does.
const failsAfterCommit: StartGit = (command, args, env) => {
  const child = recording(command, args, env);
  if (!args.includes('commit')) return child;
  const failing: GitProcess = {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => child.kill(),
    on: (event: 'error' | 'close', listener: (arg: never) => void) => {
      if (event === 'close') child.on('close', () => (listener as (code: number) => void)(1));
      else child.on('error', listener as (error: NodeJS.ErrnoException) => void);
      return failing;
    },
  };
  return failing;
};

const threadGit = (start: StartGit = recording) =>
  new ThreadGit({
    db: server.database.db,
    engine: server.engine,
    settings: server.settings,
    logger: server.logger,
    home,
    trackers: server.trackers,
    snapshots: server.snapshots,
    propose: (threadId, request, timeoutMs, signal) =>
      server.providerService.propose(threadId, request, timeoutMs, signal),
    fetch: fetchBoth,
    platform: process.platform,
    startGit: start,
    baseEnv: baseEnv(),
  });

const set = (key: string, value: unknown, scope = 'project:mug') =>
  dispatch({ type: 'setting.set', key, scope, value });

// A hook of the project's repository, shared by its worktrees. On Windows the mode is not
// kept and not needed: Git for Windows runs a hook file through its own shell by its `#!` line.
async function hook(name: string, script: string) {
  const file = path.join(project, '.git', 'hooks', name);
  await writeFile(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
}
const markFile = () => path.join(root, 'hook mark');
const forward = (file: string) => file.split(path.sep).join('/');

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'wow thread git ')));
  process.env['GIT_CEILING_DIRECTORIES'] = root;
  home = path.join(root, 'wow home');
  remote = path.join(root, 'the remote.git');
  project = path.join(root, 'tea mug');
  const seed = path.join(root, 'seed');
  await mkdir(path.join(seed, 'src'), { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  await writeFile(path.join(seed, 'readme.md'), '# Invented tea mug\n');
  await writeFile(path.join(seed, 'src', 'bell.ts'), 'ring();\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'Invented start');
  git(root, 'clone', '-q', '--bare', seed, remote);
  git(root, 'clone', '-q', '-c', 'core.autocrlf=false', remote, project);
  for (const [key, value] of [
    ['user.name', 'Invented User'],
    ['user.email', 'user@example.invalid'],
    ['commit.gpgsign', 'false'],
  ] as const) {
    git(project, 'config', key, value);
  }
  adapters = [];
  calls = [];
  github = new MockGitHub({
    owner: 'acme',
    repo: 'tea-mug',
    webUrl: 'https://github.example.test',
  });
  github.token = TOKEN;
  gitlab = new MockGitLab({ projectPath: 'tea/mug', webUrl: site });
  gitlab.token = GITLAB_TOKEN;
  server = await startServer({
    home,
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: path.join(root, 'user'),
    watchSkills: () => ({ close: () => Promise.resolve() }),
    fetch: fetchBoth,
    hooks: {
      providers: {
        claude: (row) => {
          const adapter = new MockProviderAdapter(row.kind, (command) => {
            if (command.type !== 'startTurn') return [];
            execFileSync(
              'node',
              ['-e', "require('fs').writeFileSync('src/bell.ts', 'ring(); ring();\\n')"],
              { cwd: command.cwd },
            );
            const { threadId } = command;
            return [
              { type: 'session', threadId, providerSessionId: `mock-${threadId}` },
              { type: 'textDelta', threadId, itemId: `${threadId}-a`, delta: 'Done' },
              ...(/wait/i.test(command.prompt)
                ? []
                : [{ type: 'turnCompleted' as const, threadId }]),
            ];
          });
          adapters.push(adapter);
          return adapter;
        },
      },
    },
  });
  server.database.db.insert(providerInstances).values([instance]).run();
  dispatch({ type: 'project.create', projectId: 'mug', name: 'Tea mug', cwd: project });
  set('trackers.github.baseUrl', api);
  set('trackers.github.owner', 'acme');
  set('trackers.github.repo', 'tea-mug');
  set(
    'trackers.github.token',
    await server.secrets.set('setting:project:mug:trackers.github.token', TOKEN),
  );
});

afterEach(async () => {
  await server.stop();
  if (ceiling === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
  else process.env['GIT_CEILING_DIRECTORIES'] = ceiling;
  await rm(root, { recursive: true, force: true });
});

// The thread's first turn has ended and its end snapshot is taken; then the user changes
// readme.md and stages it, and writes a new notes.txt.
async function threadWithWork(prompt = 'Make the bell ring twice') {
  dispatch({
    type: 'thread.create',
    threadId: 't1',
    providerInstanceId: 'claude-work',
    projectId: 'mug',
    cwd: project,
    title: 'Ring the bell twice',
    model: 'opus',
    effort: 'high',
    permissionMode: 'default',
    ownWorkingCopy: true,
  });
  dispatch({ type: 'thread.sendMessage', threadId: 't1', text: prompt });
  await turnEnds();
  await server.providerService.idle();
  await server.snapshots.idle();
  const folder = thread().cwd;
  await writeFile(path.join(folder, 'readme.md'), '# Invented tea mug\n\nMine.\n');
  git(folder, 'add', 'readme.md');
  await writeFile(path.join(folder, 'notes.txt'), 'one\ntwo\n');
  return folder;
}

const refusalOf = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof ThreadGitRefused)) throw new Error(`not refused: ${String(error)}`);
  return error;
};

const noVerifyAnywhere = () => calls.some(({ args }) => args.includes('--no-verify'));

describe('commit from a thread’s Changes (thread work spec 27 to 30)', () => {
  it('lists every changed and new file, ticks only the thread’s own and names the commit hooks (spec 27)', async () => {
    await hook('pre-commit', 'exit 0');
    await hook('pre-push.sample', 'exit 0');
    await threadWithWork();
    const plan = await threadGit().commitPlan('t1');
    expect(plan).toMatchObject({
      status: 'ok',
      branch: thread().branch,
      hooks: ['pre-commit'],
    });
    expect(plan.files).toEqual([
      expect.objectContaining({ path: 'notes.txt', status: 'added', added: 2, inThread: false }),
      expect.objectContaining({ path: 'readme.md', staged: true, inThread: false }),
      expect.objectContaining({
        path: 'src/bell.ts',
        status: 'modified',
        added: 1,
        removed: 1,
        inThread: true,
        staged: false,
      }),
    ]);
  });

  it('says "no commit hooks" by listing none, and names those of core.hooksPath', async () => {
    const folder = await threadWithWork();
    expect((await threadGit().commitPlan('t1')).hooks).toEqual([]);
    await mkdir(path.join(folder, 'hooks'));
    await writeFile(path.join(folder, 'hooks', 'commit-msg'), '#!/bin/sh\nexit 0\n');
    await chmod(path.join(folder, 'hooks', 'commit-msg'), 0o755);
    git(project, 'config', 'core.hooksPath', 'hooks');
    expect((await threadGit().commitPlan('t1')).hooks).toEqual(['commit-msg']);
  });

  it('proposes from the ticked file’s diff with no tools and leaves the conversation as it was (spec 28)', async () => {
    await threadWithWork();
    const before = { items: items().length, turns: lastTurn()?.index, thread: thread() };
    const answer = await threadGit().propose({
      threadId: 't1',
      requestId: 'r-1',
      purpose: 'commitMessage',
      files: ['src/bell.ts'],
    });
    expect(answer).toEqual({ text: 'Ring the bell twice' });
    const sent = adapters
      .flatMap((adapter) => adapter.sent)
      .filter(
        (command): command is Extract<ProviderCommand, { type: 'propose' }> =>
          command.type === 'propose',
      );
    expect(sent).toHaveLength(1);
    const [proposal] = sent;
    expect(proposal).toMatchObject({ model: 'opus', effort: 'high' });
    expect(proposal).not.toHaveProperty('toolset');
    expect(proposal?.prompt).toContain('+ring(); ring();');
    expect(proposal?.prompt).toContain('Ring the bell twice');
    expect(proposal?.prompt).not.toContain('Mine.');
    expect(proposal?.cwd).toBe(path.join(home, 'proposals'));
    expect(await readdir(path.join(home, 'proposals'))).toEqual([]);
    expect(items()).toHaveLength(before.items);
    expect(lastTurn()?.index).toBe(before.turns);
    expect(thread()).toEqual(before.thread);
  });

  it('commits exactly the ticked files with the hooks, leaving a staged file staged (spec 29)', async () => {
    await hook('pre-commit', `echo "checked" > "${forward(markFile())}"`);
    const folder = await threadWithWork();
    const before = git(folder, 'rev-parse', 'HEAD');
    const result = await threadGit().commit({
      threadId: 't1',
      files: ['src/bell.ts', 'notes.txt'],
      message: 'Ring the bell twice\n\nTwo rings.',
    });
    expect(result).toEqual({
      sha: git(folder, 'rev-parse', 'HEAD'),
      subject: 'Ring the bell twice',
    });
    expect(git(folder, 'rev-parse', 'HEAD~1')).toBe(before);
    expect(git(folder, 'show', '--name-only', '--format=', 'HEAD').split('\n')).toEqual([
      'notes.txt',
      'src/bell.ts',
    ]);
    // The user's own identity and message, with no trailer of wow's.
    expect(git(folder, 'log', '-1', '--format=%an <%ae>%n%B')).toBe(
      'Invented User <user@example.invalid>\nRing the bell twice\n\nTwo rings.',
    );
    expect(git(folder, 'diff', '--cached', '--name-only')).toBe('readme.md');
    expect(existsSync(markFile())).toBe(true);
    expect(items().at(-1)).toMatchObject({
      kind: 'committed',
      payload: {
        sha: result.sha,
        subject: 'Ring the bell twice',
        files: ['notes.txt', 'src/bell.ts'],
        branch: thread().branch,
      },
    });
    expect(calls.some(({ args }) => args.includes('commit'))).toBe(true);
    expect(noVerifyAnywhere()).toBe(false);
    // The commit is the one command that runs without wow's empty hooks path.
    const commit = calls.find(({ args }) => args.includes('commit'));
    expect(commit?.args.some((arg) => arg.startsWith('core.hooksPath='))).toBe(false);
  });

  it('does not read a link’s target for a proposal (U4 180)', async () => {
    const folder = await threadWithWork();
    const outside = path.join(root, 'outside secret.txt');
    await writeFile(outside, 'OUTSIDE-SECRET-CONTENT\n');
    await symlink(outside, path.join(folder, 'link.txt'), 'file');
    await threadGit().propose({
      threadId: 't1',
      requestId: 'r-link',
      purpose: 'commitMessage',
      files: ['notes.txt', 'link.txt'],
    });
    const sent = adapters
      .flatMap((adapter) => adapter.sent)
      .filter(
        (command): command is Extract<ProviderCommand, { type: 'propose' }> =>
          command.type === 'propose',
      );
    expect(sent[0]?.prompt).toContain('+one');
    expect(sent[0]?.prompt).not.toContain('OUTSIDE-SECRET-CONTENT');
  });

  it('shows a refusing hook’s output and commits nothing (spec 29)', async () => {
    await hook('pre-commit', 'echo "Lint failed: the bell rings three times" >&2\nexit 1');
    const folder = await threadWithWork();
    const before = git(folder, 'rev-parse', 'HEAD');
    const refused = await refusalOf(
      threadGit().commit({ threadId: 't1', files: ['src/bell.ts', 'notes.txt'], message: 'Ring' }),
    );
    expect(refused.data).toMatchObject({
      output: expect.stringContaining('Lint failed: the bell rings three times'),
    });
    expect(git(folder, 'rev-parse', 'HEAD')).toBe(before);
    // The new file is untracked again, the staged one still staged.
    expect(git(folder, 'status', '--porcelain', '--', 'notes.txt')).toBe('?? notes.txt');
    expect(git(folder, 'diff', '--cached', '--name-only')).toBe('readme.md');
    expect(items().some((item) => item.kind === 'committed')).toBe(false);
    expect(noVerifyAnywhere()).toBe(false);
  });

  it('reports a commit as made when git fails after it, and leaves the index alone (U4 178)', async () => {
    await hook('post-commit', `echo "done" > "${forward(markFile())}"`);
    const folder = await threadWithWork();
    const before = git(folder, 'rev-parse', 'HEAD');
    const result = await threadGit(failsAfterCommit).commit({
      threadId: 't1',
      files: ['src/bell.ts', 'notes.txt'],
      message: 'Ring the bell twice',
    });
    expect(result.sha).toBe(git(folder, 'rev-parse', 'HEAD'));
    expect(git(folder, 'rev-parse', 'HEAD~1')).toBe(before);
    expect(result.note).toMatch(/hook did not finish/);
    // The new file is committed, not taken out of the index again.
    expect(git(folder, 'ls-files', 'notes.txt')).toBe('notes.txt');
    expect(git(folder, 'status', '--porcelain', '--', 'notes.txt')).toBe('');
    expect(items().at(-1)).toMatchObject({
      kind: 'committed',
      payload: { sha: result.sha, files: ['notes.txt', 'src/bell.ts'] },
    });
    expect(calls.some(({ args }) => args.includes('rm'))).toBe(false);
  });

  it('says the folder is on the new branch when a commit from no branch is refused (U4 182)', async () => {
    await hook('pre-commit', 'echo "Lint failed" >&2\nexit 1');
    const folder = await threadWithWork();
    git(folder, 'switch', '-q', '--detach');
    const refused = await refusalOf(
      threadGit().commit({
        threadId: 't1',
        files: ['src/bell.ts'],
        message: 'Ring',
        newBranch: 'wow/ring-from-nowhere',
      }),
    );
    expect(refused.message).toContain('Nothing was committed');
    expect(refused.message).toContain('The folder is now on the new branch wow/ring-from-nowhere');
    expect(git(folder, 'symbolic-ref', '--short', 'HEAD')).toBe('wow/ring-from-nowhere');
  });

  it('refuses an empty message and a rebase in progress, and commits from no branch on a new one (spec 30)', async () => {
    const folder = await threadWithWork();
    const service = threadGit();
    expect(
      (await refusalOf(service.commit({ threadId: 't1', files: ['src/bell.ts'], message: ' ' })))
        .message,
    ).toBe('Write a commit message first.');
    const rebase = path.resolve(folder, git(folder, 'rev-parse', '--git-path', 'rebase-merge'));
    await mkdir(rebase);
    expect(await service.commitPlan('t1')).toMatchObject({
      status: 'operationInProgress',
      message: expect.stringContaining('a rebase'),
    });
    await rm(rebase, { recursive: true });

    git(folder, 'switch', '-q', '--detach');
    expect((await service.commitPlan('t1')).branch).toBeNull();
    expect(
      (await refusalOf(service.commit({ threadId: 't1', files: ['src/bell.ts'], message: 'Ring' })))
        .message,
    ).toMatch(/no branch/);
    await service.commit({
      threadId: 't1',
      files: ['src/bell.ts'],
      message: 'Ring',
      newBranch: 'wow/ring-from-nowhere',
    });
    expect(git(folder, 'symbolic-ref', '--short', 'HEAD')).toBe('wow/ring-from-nowhere');
    expect(git(folder, 'log', '-1', '--format=%s', 'wow/ring-from-nowhere')).toBe('Ring');
  });

  it('refuses while a turn runs (spec 30)', async () => {
    await threadWithWork();
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'wait here' });
    await server.providerService.idle();
    const service = threadGit();
    expect((await service.commitPlan('t1')).status).toBe('turnRunning');
    expect(
      (await refusalOf(service.commit({ threadId: 't1', files: ['src/bell.ts'], message: 'Ring' })))
        .message,
    ).toMatch(/turn is running/);
  });
});

async function committed() {
  const folder = await threadWithWork();
  await threadGit().commit({
    threadId: 't1',
    files: ['src/bell.ts'],
    message: 'Ring the bell twice',
  });
  calls = [];
  return folder;
}

const pushes = () => calls.filter(({ args }) => args.includes('push')).length;

describe('pull request from a thread (thread work spec 31 to 36)', () => {
  it('plans into the remote’s default branch, pushes to the bare origin with the upstream and opens one pull request (spec 31, 32)', async () => {
    await hook('pre-push', `echo "pushed" > "${forward(markFile())}"`);
    const folder = await committed();
    const branch = thread().branch ?? '';
    const service = threadGit();
    const plan = await service.pullRequestPlan({ threadId: 't1' });
    expect(plan).toMatchObject({
      status: 'ok',
      host: 'github',
      hostName: 'github.example.test',
      repository: 'acme/tea-mug',
      remote: 'origin',
      branch,
      target: 'main',
      branches: ['main'],
      title: 'Ring the bell twice',
      draft: false,
      existing: null,
    });
    expect(plan.commits.map((commit) => commit.subject)).toEqual(['Ring the bell twice']);
    const opened = await service.openPullRequest({
      threadId: 't1',
      target: 'main',
      title: 'Ring the bell twice',
      body: 'Two rings.',
      draft: true,
    });
    expect(opened).toEqual({
      number: 100,
      url: 'https://github.example.test/acme/tea-mug/pull/100',
    });
    expect(git(remote, 'rev-parse', `refs/heads/${branch}`)).toBe(git(folder, 'rev-parse', 'HEAD'));
    expect(git(folder, 'config', `branch.${branch}.remote`)).toBe('origin');
    expect(existsSync(markFile())).toBe(true);
    expect(github.requests.filter((request) => request.method === 'POST')).toEqual([
      { method: 'POST', path: '/repos/acme/tea-mug/pulls', authorization: `Bearer ${TOKEN}` },
    ]);
    expect(github.opened).toEqual([
      { title: 'Ring the bell twice', head: branch, base: 'main', body: 'Two rings.', draft: true },
    ]);
    expect(items().at(-1)).toMatchObject({
      kind: 'change_request_opened',
      payload: {
        number: 100,
        title: 'Ring the bell twice',
        ref: { host: 'github', kind: 'changeRequest', path: 'acme/tea-mug', id: '100' },
      },
    });
    // The token went only into the host request's header: in no git argument or environment.
    const seen = calls.flatMap(({ args, env }) => [...args, ...Object.values(env ?? {})]);
    expect(seen.some((value) => value?.includes(TOKEN))).toBe(false);
    expect(calls.some(({ args }) => args.includes('push'))).toBe(true);
    expect(calls.some(({ args }) => args.includes('--force') || args.includes('-f'))).toBe(false);
    expect(noVerifyAnywhere()).toBe(false);
    // The push ran with nothing that asks.
    const push = calls.find(({ args }) => args.includes('push'));
    expect(push?.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
  });

  it('refuses before pushing without a token, for a protected branch, on the target and with nothing ahead (spec 33)', async () => {
    await committed();
    const branch = thread().branch ?? '';
    const service = threadGit();

    github.protectedBranches.add(branch);
    expect(await service.pullRequestPlan({ threadId: 't1' })).toMatchObject({
      status: 'protected',
    });
    github.protectedBranches.clear();
    expect(await service.pullRequestPlan({ threadId: 't1', target: 'nowhere' })).toMatchObject({
      status: 'noTarget',
    });
    expect(await service.pullRequestPlan({ threadId: 't1', target: branch })).toMatchObject({
      status: 'isTarget',
    });
    git(thread().cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(await service.pullRequestPlan({ threadId: 't1' })).toMatchObject({
      status: 'noCommits',
    });
    git(thread().cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1');

    dispatch({ type: 'setting.reset', key: 'trackers.github.token', scope: 'project:mug' });
    const unset = await service.pullRequestPlan({ threadId: 't1' });
    expect(unset).toMatchObject({ status: 'notSetUp', missing: 'trackers.github.token' });
    expect(unset.message).toContain('trackers.github.token');
    expect(
      (
        await refusalOf(
          service.openPullRequest({
            threadId: 't1',
            target: 'main',
            title: 'Ring',
            body: '',
            draft: false,
          }),
        )
      ).data,
    ).toMatchObject({ pushed: false });
    expect(pushes()).toBe(0);
  });

  it('offers to push new commits to the pull request open for the branch (spec 33)', async () => {
    const folder = await committed();
    const branch = thread().branch ?? '';
    const service = threadGit();
    await service.openPullRequest({
      threadId: 't1',
      target: 'main',
      title: 'Ring the bell twice',
      body: '',
      draft: false,
    });
    git(folder, 'commit', '-q', '--allow-empty', '-m', 'Ring once more');
    const plan = await service.pullRequestPlan({ threadId: 't1' });
    expect(plan).toMatchObject({ status: 'existing', existing: { number: 100, unpushed: 1 } });
    expect(await service.pushBranch('t1')).toEqual({ remote: 'origin', branch });
    expect(git(remote, 'rev-parse', `refs/heads/${branch}`)).toBe(git(folder, 'rev-parse', 'HEAD'));
    expect(github.opened).toHaveLength(1);
  });

  it('shows the host’s refusal, keeps the branch pushed and opens on the next try (spec 34)', async () => {
    await committed();
    const branch = thread().branch ?? '';
    const service = threadGit();
    github.openRefusal = { status: 422, message: 'The title is taken by another pull request' };
    const refused = await refusalOf(
      service.openPullRequest({
        threadId: 't1',
        target: 'main',
        title: 'Ring the bell twice',
        body: '',
        draft: false,
      }),
    );
    expect(refused.message).toContain('The title is taken by another pull request');
    expect(refused.data).toMatchObject({ pushed: true });
    expect(git(remote, 'rev-parse', `refs/heads/${branch}`)).toBeTruthy();
    github.openRefusal = undefined;
    await expect(
      service.openPullRequest({
        threadId: 't1',
        target: 'main',
        title: 'Ring the bell twice',
        body: '',
        draft: false,
      }),
    ).resolves.toMatchObject({ number: 100 });
  });

  it('opens a draft merge request on GitLab with its token (spec 31)', async () => {
    git(project, 'remote', 'set-url', 'origin', 'git@gitlab.example.test:tea/mug.git');
    git(project, 'remote', 'set-url', '--push', 'origin', remote);
    set('trackers.gitlab.baseUrl', site);
    set(
      'trackers.gitlab.token',
      await server.secrets.set('setting:project:mug:trackers.gitlab.token', GITLAB_TOKEN),
    );
    await committed();
    const service = threadGit();
    expect(await service.pullRequestPlan({ threadId: 't1' })).toMatchObject({
      status: 'ok',
      host: 'gitlab',
      repository: 'tea/mug',
    });
    await expect(
      service.openPullRequest({
        threadId: 't1',
        target: 'main',
        title: 'Ring the bell twice',
        body: 'Two rings.',
        draft: true,
      }),
    ).resolves.toMatchObject({ number: 20 });
    expect(gitlab.opened).toEqual([
      {
        source_branch: thread().branch,
        target_branch: 'main',
        title: 'Draft: Ring the bell twice',
        description: 'Two rings.',
      },
    ]);
    expect(gitlab.requests.filter((request) => request.method === 'POST')).toEqual([
      expect.objectContaining({ token: GITLAB_TOKEN }),
    ]);
    const seen = calls.flatMap(({ args, env }) => [...args, ...Object.values(env ?? {})]);
    expect(seen.some((value) => value?.includes(GITLAB_TOKEN))).toBe(false);
  });

  it('refuses to push the remote’s default branch whatever the target (U4 181)', async () => {
    await committed();
    const folder = thread().cwd;
    const branch = thread().branch ?? '';
    // The remote's default is trunk, which the thread's branch is called.
    git(remote, 'branch', 'trunk', 'main');
    git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
    git(project, 'fetch', '-q', 'origin');
    git(project, 'remote', 'set-head', 'origin', 'trunk');
    git(folder, 'branch', '-m', branch, 'trunk');
    calls = [];
    const service = threadGit();
    const plan = await service.pullRequestPlan({ threadId: 't1', target: 'main' });
    expect(plan.status).toBe('isTarget');
    expect(plan.message).toContain('default branch of origin');
    const refused = await refusalOf(
      service.openPullRequest({
        threadId: 't1',
        target: 'main',
        title: 'Ring',
        body: '',
        draft: false,
      }),
    );
    expect(refused.message).toContain('default branch of origin');
    expect(pushes()).toBe(0);
    expect(git(remote, 'rev-parse', 'refs/heads/trunk')).toBe(git(remote, 'rev-parse', 'main'));
  });

  describe('a push that needs credentials', () => {
    let asking: Server;
    afterEach(async () => {
      await new Promise<void>((resolve) => asking.close(() => resolve()));
    });

    // A remote that wants a user name and password for every request.
    async function askingRemote() {
      asking = createServer((_request, response) => {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="invented"' });
        response.end();
      });
      await new Promise<void>((resolve) => asking.listen(0, '127.0.0.1', resolve));
      const address = asking.address();
      return typeof address === 'object' && address ? address.port : 0;
    }

    it('never starts a core.askPass helper of the user’s config (U4 179)', async () => {
      const port = await askingRemote();
      await committed();
      // Git runs the program itself, as hooks are run: by its `#!` line, with the mode set where
      // it counts.
      const helper = path.join(root, 'ask helper');
      await writeFile(helper, `#!/bin/sh\necho asked > "${forward(markFile())}"\necho x\n`);
      await chmod(helper, 0o755);
      git(project, 'config', 'core.askPass', forward(helper));
      git(project, 'remote', 'set-url', '--push', 'origin', `http://127.0.0.1:${port}/tea.git`);
      const refused = await refusalOf(
        threadGit().openPullRequest({
          threadId: 't1',
          target: 'main',
          title: 'Ring',
          body: '',
          draft: false,
        }),
      );
      expect(refused.message).toMatch(/Push once in a terminal/);
      expect(existsSync(markFile())).toBe(false);
    });

    it('does not call a missing remote repository a credentials problem (U4 183)', async () => {
      await committed();
      git(project, 'remote', 'set-url', '--push', 'origin', path.join(root, 'no such remote.git'));
      const refused = await refusalOf(
        threadGit().openPullRequest({
          threadId: 't1',
          target: 'main',
          title: 'Ring',
          body: '',
          draft: false,
        }),
      );
      expect(refused.message).toMatch(/^Git did not push/);
      expect(refused.message).not.toMatch(/Push once in a terminal/);
    });

    it('fails without waiting and says to push once in a terminal (spec 35)', async () => {
      const port = await askingRemote();
      await committed();
      git(project, 'remote', 'set-url', '--push', 'origin', `http://127.0.0.1:${port}/tea.git`);
      const refused = await refusalOf(
        threadGit().openPullRequest({
          threadId: 't1',
          target: 'main',
          title: 'Ring the bell twice',
          body: '',
          draft: false,
        }),
      );
      expect(refused.message).toMatch(/Push once in a terminal/);
      expect(refused.data).toMatchObject({ pushed: false });
      expect(github.opened).toEqual([]);
    });
  });
});
