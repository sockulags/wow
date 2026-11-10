import {
  RpcResponse,
  type ProviderCommand,
  type ProviderInstance,
  type ServerCommand,
  type Thread,
  type WorkflowRun,
  type WorkflowStep,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { workingCopyPath } from '../core/workflows.js';
import { notifications, providerInstances, threads, workflowRuns } from '../db/schema.js';
import { MockProviderAdapter } from '../hooks/index.js';
import { startServer, type RunningServer } from '../server.js';

// Review loop spec 36 to 39 against a temporary repository with a bare remote. Every folder has
// a space in its name, as a Windows user folder often does.

let root: string;
let home: string;
let remote: string;
let project: string;
let server: RunningServer;
let adapters: MockProviderAdapter[];
// What the invented agent does in the folder its turn was started in.
let agent: (cwd: string, prompt: string) => void;
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

async function commit(dir: string, file: string, text: string, message: string) {
  await writeFile(path.join(dir, file), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

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

const step = (id: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  skillName: id,
  providerInstanceId: 'claude-work',
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
  ...overrides,
});

let commandCount = 0;
const dispatch = (command: ServerCommand) =>
  server.engine.dispatch(`test-${(commandCount += 1)}`, command);

const run = (runId = 'r1'): WorkflowRun =>
  server.database.db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.id, runId))
    .get() as WorkflowRun;

const thread = (id: string): Thread | undefined =>
  server.database.db.select().from(threads).where(eq(threads.id, id)).get();

// Resolves on the commit that makes the run match: no sleeping or polling.
function runBecomes(predicate: (run: WorkflowRun) => boolean, runId = 'r1'): Promise<WorkflowRun> {
  return new Promise((resolve) => {
    const check = () => {
      const current = server.database.db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.id, runId))
        .get();
      if (current && predicate(current)) {
        unsubscribe();
        resolve(current);
      }
    };
    const unsubscribe = server.engine.onCommit(check);
    check();
  });
}

const copyIs = (state: string) => (current: WorkflowRun) => current.workingCopy?.state === state;

const startTurns = () =>
  adapters.flatMap((adapter) =>
    adapter.sent.filter(
      (command): command is Extract<ProviderCommand, { type: 'startTurn' }> =>
        command.type === 'startTurn',
    ),
  );

async function rpc(method: string, params: unknown): Promise<RpcResponse> {
  const socket = new WebSocket(server.url);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const answer = new Promise<RpcResponse>((resolve) =>
    socket.once('message', (raw) => resolve(RpcResponse.parse(JSON.parse(String(raw))))),
  );
  socket.send(JSON.stringify({ id: '1', method, params }));
  const response = await answer;
  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    socket.close();
  });
  return response;
}

async function launch(): Promise<RunningServer> {
  return startServer({
    home,
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: path.join(root, 'user'),
    watchSkills: () => ({ close: () => Promise.resolve() }),
    hooks: {
      providers: {
        claude: (row) => {
          const adapter = new MockProviderAdapter(row.kind, (command) => {
            if (command.type !== 'startTurn') return [];
            agent(command.cwd, command.prompt);
            const { threadId } = command;
            return [
              { type: 'textDelta', threadId, itemId: `${threadId}-a`, delta: 'Done' },
              { type: 'turnCompleted', threadId },
            ];
          });
          adapters.push(adapter);
          return adapter;
        },
      },
    },
  });
}

beforeEach(async () => {
  // Resolved, so paths git prints compare equal on a system whose temporary folder is a link.
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'wow copies ')));
  process.env['GIT_CEILING_DIRECTORIES'] = root;
  home = path.join(root, 'wow home');
  remote = path.join(root, 'the remote.git');
  project = path.join(root, 'tea timer');
  const seed = path.join(root, 'seed');
  await mkdir(seed);
  git(seed, 'init', '-q', '-b', 'main');
  await commit(seed, 'readme.md', '# Invented tea timer\n', 'Invented start');
  git(root, 'clone', '-q', '--bare', seed, remote);
  // Set at the clone, so the project's own files are checked out with the line endings written
  // here whatever this machine's git is set to (Windows converts by default, and turning that
  // off afterwards leaves the checked out file looking changed). Working copies share the setting.
  git(root, 'clone', '-q', '-c', 'core.autocrlf=false', remote, project);
  adapters = [];
  agent = () => undefined;
  server = await launch();
  server.database.db.insert(providerInstances).values([instance]).run();
  dispatch({ type: 'project.create', projectId: 'tea', name: 'Tea timer', cwd: project });
  dispatch({
    type: 'workflow.create',
    workflowId: 'own',
    name: 'Own copy',
    steps: [step('build', { gateAfter: true }), step('review')],
    ownWorkingCopy: true,
  });
});

afterEach(async () => {
  await server.stop();
  if (ceiling === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
  else process.env['GIT_CEILING_DIRECTORIES'] = ceiling;
  await rm(root, { recursive: true, force: true });
});

const start = (workflowId = 'own', projectId = 'tea') =>
  dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId, projectId });

// Someone else pushes a commit the project folder has not fetched yet.
async function pushFromElsewhere() {
  const other = path.join(root, 'other clone');
  git(root, 'clone', '-q', remote, other);
  const sha = await commit(other, 'news.md', 'Invented news\n', 'Invented commit by someone else');
  git(other, 'push', '-q', 'origin', 'main');
  return sha;
}

describe('a run in its own working copy (review loop spec 36)', () => {
  it('makes a detached worktree under workspaces.root at the fetched default branch tip, gives every step it as cwd and leaves the project folder alone', async () => {
    const tip = await pushFromElsewhere();
    await writeFile(path.join(project, 'draft.md'), 'Mine, not committed\n');
    const before = {
      status: git(project, 'status', '--porcelain'),
      head: git(project, 'rev-parse', 'HEAD'),
      branch: git(project, 'symbolic-ref', '--short', 'HEAD'),
    };
    expect(before.head).not.toBe(tip);

    start();
    const waiting = await runBecomes((current) => current.state === 'waiting');
    const copy = waiting.workingCopy;
    expect(copy).toMatchObject({
      state: 'ready',
      startSha: tip,
      defaultBranch: 'main',
      note: null,
      unpushed: null,
      error: null,
    });
    const folder = copy?.path ?? '';
    expect(path.dirname(folder)).toBe(path.join(home, 'workspaces'));
    expect(path.basename(folder)).toMatch(/^tea-timer-[0-9a-f]{8}$/);
    expect(git(folder, 'rev-parse', 'HEAD')).toBe(tip);
    // On no branch.
    expect(git(folder, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(waiting.baseSha).toBe(tip);

    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    await runBecomes((current) => current.state === 'done');
    expect(thread('r1.build')?.cwd).toBe(folder);
    expect(thread('r1.review')?.cwd).toBe(folder);
    expect(startTurns().map((turn) => turn.cwd)).toEqual([folder, folder]);

    expect({
      status: git(project, 'status', '--porcelain'),
      head: git(project, 'rev-parse', 'HEAD'),
      branch: git(project, 'symbolic-ref', '--short', 'HEAD'),
    }).toEqual(before);
  });

  it('uses the local tip and says so on the run when the fetch fails', async () => {
    const local = await commit(project, 'local.md', 'Only here\n', 'Invented local commit');
    git(project, 'remote', 'set-url', 'origin', path.join(root, 'no such remote.git'));
    start();
    const waiting = await runBecomes((current) => current.state === 'waiting');
    expect(waiting.workingCopy).toMatchObject({ state: 'ready', startSha: local });
    expect(waiting.workingCopy?.note).toMatch(
      /^Fetching origin failed \(.+\), so the working copy starts at the local tip of main\.$/,
    );
    expect(git(waiting.workingCopy?.path ?? '', 'rev-parse', 'HEAD')).toBe(local);
  });

  it('does not fetch when workspaces.fetchBeforeCreate is off, and says so', async () => {
    await pushFromElsewhere();
    const known = git(project, 'rev-parse', 'HEAD');
    dispatch({
      type: 'setting.set',
      key: 'workspaces.fetchBeforeCreate',
      scope: 'project:tea',
      value: false,
    });
    start();
    const waiting = await runBecomes((current) => current.state === 'waiting');
    expect(waiting.workingCopy).toMatchObject({
      state: 'ready',
      startSha: known,
      note: 'origin was not fetched (the setting is off), so the working copy starts at the local tip of main.',
    });
    expect(git(project, 'rev-parse', 'origin/main')).toBe(known);
  });

  it('puts the working copy under a workspaces.root that is a full path', async () => {
    const elsewhere = path.join(root, 'short w');
    dispatch({ type: 'setting.set', key: 'workspaces.root', scope: 'global', value: elsewhere });
    start();
    const waiting = await runBecomes((current) => current.state === 'waiting');
    expect(path.dirname(waiting.workingCopy?.path ?? '')).toBe(elsewhere);
    expect(existsSync(path.join(waiting.workingCopy?.path ?? '', 'readme.md'))).toBe(true);
  });

  it('names the folder after the project and the run, short enough for Windows', () => {
    const named = workingCopyPath('workspaces', home, 'Tea timer & more than sixteen', 'r1');
    expect(path.basename(named)).toMatch(/^tea-timer-more-t-[0-9a-f]{8}$/);
    expect(path.basename(workingCopyPath('workspaces', home, '茶', 'r1'))).toMatch(/^[0-9a-f]{8}$/);
    expect(workingCopyPath('workspaces', home, 'a', 'r1')).not.toBe(
      workingCopyPath('workspaces', home, 'a', 'r2'),
    );
    expect(() => workingCopyPath('workspaces', undefined, 'a', 'r1')).toThrow(/not a full path/);
  });
});

describe('when the run ends (review loop spec 37)', () => {
  it('removes the working copy when all work is committed and reachable from a remote branch', async () => {
    agent = (cwd, prompt) => {
      if (!prompt.startsWith('/build')) return;
      git(cwd, 'checkout', '-q', '-b', 'agent/u1-bell');
      execFileSync('git', ['-C', cwd, 'mv', 'readme.md', 'README.md']);
      git(cwd, 'commit', '-q', '-m', 'Invented commit by the agent');
      git(cwd, 'push', '-q', 'origin', 'agent/u1-bell');
    };
    start();
    const waiting = await runBecomes((current) => current.state === 'waiting');
    const folder = waiting.workingCopy?.path ?? '';
    expect(existsSync(folder)).toBe(true);
    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    const ended = await runBecomes(copyIs('removed'));
    expect(ended.state).toBe('done');
    expect(ended.workingCopy).toMatchObject({ unpushed: null, error: null });
    expect(existsSync(folder)).toBe(false);
    expect(git(project, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    // The pushed work is on the remote, and the project folder is where it was.
    expect(git(remote, 'rev-parse', '--verify', 'refs/heads/agent/u1-bell')).not.toBe('');
    expect(git(project, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  });

  it('removes a working copy nothing was changed in, also after Stop', async () => {
    start();
    const waiting = await runBecomes((current) => current.state === 'waiting');
    dispatch({ type: 'workflowRun.stop', runId: 'r1' });
    const ended = await runBecomes(copyIs('removed'));
    expect(ended.state).toBe('stopped');
    expect(existsSync(waiting.workingCopy?.path ?? '')).toBe(false);
  });

  it('keeps a working copy with uncommitted or unpushed work, lists what is unpushed, and removes it on Remove working copy', async () => {
    agent = (cwd, prompt) => {
      if (!prompt.startsWith('/build')) return;
      git(cwd, 'checkout', '-q', '-b', 'agent/u2-kettle');
      execFileSync('git', ['-C', cwd, 'mv', 'readme.md', 'kettle.md']);
      git(cwd, 'commit', '-q', '-m', 'Invented commit that was not pushed');
      execFileSync('git', ['-C', cwd, 'mv', 'kettle.md', 'whistle.md']);
    };
    start();
    await runBecomes((current) => current.state === 'waiting');
    // While the run is live the working copy stays, whatever is in it.
    await expect(server.workspaces.remove('r1')).rejects.toThrow(/still going/);
    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    const kept = await runBecomes(copyIs('kept'));
    const folder = kept.workingCopy?.path ?? '';
    expect(kept.state).toBe('done');
    expect(kept.workingCopy).toMatchObject({
      unpushed: {
        uncommittedFiles: 1,
        unpushedCommits: 1,
        newestSubject: 'Invented commit that was not pushed',
        branch: 'agent/u2-kettle',
      },
      error: null,
    });
    expect(existsSync(path.join(folder, 'whistle.md'))).toBe(true);

    const removed = await rpc('workflowRuns.removeWorkingCopy', { runId: 'r1' });
    expect(removed).toMatchObject({
      result: { workingCopy: { state: 'removed', unpushed: null } },
    });
    expect(existsSync(folder)).toBe(false);
    expect(run().workingCopy?.state).toBe('removed');
    // Asking again changes nothing and is not an error.
    expect(await rpc('workflowRuns.removeWorkingCopy', { runId: 'r1' })).toMatchObject({
      result: { workingCopy: { state: 'removed' } },
    });
    expect(await rpc('workflowRuns.removeWorkingCopy', { runId: 'nope' })).toMatchObject({
      error: { code: 'not_found' },
    });
  });

  it('keeps a working copy that only has a file git does not know yet', async () => {
    agent = (cwd) => {
      execFileSync('git', ['-C', cwd, 'mv', 'readme.md', 'moved.md']);
    };
    dispatch({
      type: 'workflow.create',
      workflowId: 'one',
      name: 'One step',
      steps: [step('build')],
      ownWorkingCopy: true,
    });
    start('one');
    const kept = await runBecomes(copyIs('kept'));
    expect(kept.workingCopy?.unpushed).toEqual({
      uncommittedFiles: 1,
      unpushedCommits: 0,
      newestSubject: null,
      branch: null,
    });
  });

  it('keeps and lists a working copy that could not be removed, with the reason, and tries nothing again', async () => {
    start();
    const waiting = await runBecomes((current) => current.state === 'waiting');
    const folder = waiting.workingCopy?.path ?? '';
    // Git refuses to remove a locked worktree, as it does one with a file in use on Windows.
    git(project, 'worktree', 'lock', folder);
    dispatch({ type: 'workflowRun.stop', runId: 'r1' });
    const kept = await runBecomes(copyIs('kept'));
    expect(kept.workingCopy?.unpushed).toBeNull();
    expect(kept.workingCopy?.error).toMatch(
      /^Nothing in it would be lost, but it could not be removed: .+/,
    );
    expect(existsSync(folder)).toBe(true);

    await expect(server.workspaces.remove('r1')).rejects.toThrow(
      /^The working copy could not be removed: .+/,
    );
    expect(run().workingCopy).toMatchObject({ state: 'kept' });
    expect(run().workingCopy?.error).toMatch(/^The working copy could not be removed: .+/);
    expect(existsSync(folder)).toBe(true);

    git(project, 'worktree', 'unlock', folder);
    await server.workspaces.remove('r1');
    expect(run().workingCopy).toMatchObject({ state: 'removed', error: null });
    expect(existsSync(folder)).toBe(false);
  });

  it('looks at a working copy whose run ended while the server was down', async () => {
    start();
    const waiting = await runBecomes((current) => current.state === 'waiting');
    await server.stop();
    server = await launch();
    expect(run().workingCopy?.state).toBe('ready');
    dispatch({ type: 'workflowRun.stop', runId: 'r1' });
    await runBecomes(copyIs('removed'));
    expect(existsSync(waiting.workingCopy?.path ?? '')).toBe(false);
  });
});

describe('a working copy that cannot be made (review loop spec 38)', () => {
  let plain: string;

  beforeEach(async () => {
    plain = path.join(root, 'not a repository');
    await mkdir(plain);
    await writeFile(path.join(plain, 'notes.md'), 'Invented notes\n');
    dispatch({ type: 'project.create', projectId: 'plain', name: 'Plain', cwd: plain });
  });

  it('fails the run before step one with the reason when the project is not a repository, and runs nothing in the project folder', async () => {
    start('own', 'plain');
    const failed = await runBecomes((current) => current.state === 'failed');
    await server.workflows.settled();
    expect(failed.workingCopy?.state).toBe('failed');
    expect(failed.workingCopy?.error).toBe(
      `No working copy could be made: ${plain} is not a Git repository.`,
    );
    expect(failed.steps[0]).toMatchObject({ state: 'failed', error: failed.workingCopy?.error });
    expect(failed.steps[1]?.state).toBe('not_started');
    expect(startTurns()).toEqual([]);
    expect(thread('r1.build')).toMatchObject({ state: 'failed' });
    expect(thread('r1.build')?.cwd).not.toBe(plain);
    expect(existsSync(failed.workingCopy?.path ?? '')).toBe(false);
    expect(
      server.database.db
        .select()
        .from(notifications)
        .all()
        .map((row) => row.kind),
    ).toEqual(['failed']);
  });

  it('fails a run that waits before its first step', async () => {
    dispatch({
      type: 'workflow.create',
      workflowId: 'gated',
      name: 'Gated',
      steps: [step('build', { gateBefore: true })],
      ownWorkingCopy: true,
    });
    start('gated', 'plain');
    const failed = await runBecomes((current) => current.state === 'failed');
    expect(failed.steps[0]?.error).toMatch(/is not a Git repository/);
    expect(startTurns()).toEqual([]);
  });

  it('fails when the folder for the working copy is already taken', async () => {
    const taken = workingCopyPath('workspaces', home, 'Tea timer', 'r1');
    await mkdir(taken, { recursive: true });
    await writeFile(path.join(taken, 'in the way.txt'), 'Invented\n');
    start();
    const failed = await runBecomes((current) => current.state === 'failed');
    expect(failed.workingCopy?.error).toMatch(/^No working copy could be made: .+/);
    expect(startTurns()).toEqual([]);
    expect(git(project, 'status', '--porcelain')).toBe('');
  });
});

describe('with the switch off (review loop spec 39)', () => {
  it('runs in the project folder as before', async () => {
    dispatch({
      type: 'workflow.create',
      workflowId: 'plain',
      name: 'In place',
      steps: [step('build')],
    });
    start('plain');
    const done = await runBecomes((current) => current.state === 'done');
    expect(done.workingCopy ?? null).toBeNull();
    expect(thread('r1.build')?.cwd).toBe(project);
    expect(startTurns().map((turn) => turn.cwd)).toEqual([project]);
    expect(existsSync(path.join(home, 'workspaces'))).toBe(false);
  });

  it('stores the switch on the workflow and leaves a started run where it is', async () => {
    start();
    const waiting = await runBecomes((current) => current.state === 'waiting');
    dispatch({ type: 'workflow.update', workflowId: 'own', ownWorkingCopy: false });
    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    await runBecomes((current) => current.state === 'done');
    expect(thread('r1.review')?.cwd).toBe(waiting.workingCopy?.path);
    dispatch({ type: 'workflowRun.start', runId: 'r2', workflowId: 'own', projectId: 'tea' });
    await runBecomes((current) => current.state === 'waiting', 'r2');
    expect(run('r2').workingCopy ?? null).toBeNull();
    expect(thread('r2.build')?.cwd).toBe(project);
  });
});

describe('reading a run with a working copy', () => {
  it('reads the Changes tab and the viewer from the working copy, not the project folder', async () => {
    agent = (cwd, prompt) => {
      if (!prompt.startsWith('/build')) return;
      execFileSync('git', ['-C', cwd, 'mv', 'readme.md', 'guide.md']);
    };
    await writeFile(path.join(project, 'mine.md'), 'Only in the project folder\n');
    start();
    const waiting = await runBecomes((current) => current.state === 'waiting');
    const folder = waiting.workingCopy?.path ?? '';

    const diff = await rpc('workflowRuns.diff', { runId: 'r1' });
    expect(diff).toMatchObject({
      result: {
        status: 'ok',
        baseSha: waiting.workingCopy?.startSha,
        files: [
          { path: 'guide.md', oldPath: 'readme.md', status: 'renamed', changedBy: ['build'] },
        ],
      },
    });
    expect(await rpc('files.read', { runId: 'r1', path: 'guide.md' })).toMatchObject({
      result: {
        kind: 'markdown',
        absolutePath: path.join(folder, 'guide.md'),
        text: '# Invented tea timer\n',
      },
    });
    // The project folder stays readable, as the viewer's rule says.
    expect(await rpc('files.read', { runId: 'r1', path: 'mine.md' })).toMatchObject({
      result: { kind: 'markdown', absolutePath: path.join(project, 'mine.md') },
    });
  });
});
