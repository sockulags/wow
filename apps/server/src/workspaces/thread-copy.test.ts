import {
  RpcResponse,
  branchIdOf,
  type ProviderCommand,
  type ProviderInstance,
  type ServerCommand,
  type Thread,
  type UnpushedWork,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { CommandRejected } from '../core/orchestrator.js';
import { providerInstances, threads, turns } from '../db/schema.js';
import { MockProviderAdapter } from '../hooks/index.js';
import { startServer, type RunningServer } from '../server.js';

// Thread work spec 10 to 18 against repositories the test makes: a project cloned (with
// `core.autocrlf=false`, so Windows sees its files as committed) from a bare remote. Every folder
// has a space in its name, as a Windows user folder often does. All invented.

let root: string;
let home: string;
let project: string;
let server: RunningServer;
let adapters: MockProviderAdapter[];
// What the invented agent does in the folder its turn was started in, and what it saw there.
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

let commandCount = 0;
const dispatch = (command: ServerCommand) =>
  server.engine.dispatch(`test-${(commandCount += 1)}`, command);

const thread = (id = 't1'): Thread =>
  server.database.db.select().from(threads).where(eq(threads.id, id)).get() as Thread;

const lastTurn = (id = 't1') =>
  server.database.db
    .select()
    .from(turns)
    .where(eq(turns.threadId, id))
    .all()
    .toSorted((a, b) => b.index - a.index)[0];

// Resolves on the commit after which the turn has ended: no sleeping or polling.
function turnEnds(id = 't1', index?: number) {
  return new Promise<NonNullable<ReturnType<typeof lastTurn>>>((resolve) => {
    const check = () => {
      const turn = lastTurn(id);
      if (turn && turn.state !== 'running' && (index === undefined || turn.index === index)) {
        unsubscribe();
        resolve(turn);
      }
    };
    const unsubscribe = server.engine.onCommit(check);
    check();
  });
}

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

const resultOf = (response: RpcResponse) => ('result' in response ? response.result : undefined);
const errorOf = (response: RpcResponse) => ('error' in response ? response.error : undefined);

const launch = () =>
  startServer({
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
            // "wait" leaves the turn running until the test ends it.
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

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'wow thread copies ')));
  process.env['GIT_CEILING_DIRECTORIES'] = root;
  home = path.join(root, 'wow home');
  const remote = path.join(root, 'the remote.git');
  project = path.join(root, 'tea mug');
  const seed = path.join(root, 'seed');
  await mkdir(seed);
  git(seed, 'init', '-q', '-b', 'main');
  await writeFile(path.join(seed, '.gitignore'), '*.log\n');
  await commit(seed, 'readme.md', '# Invented tea mug\n', 'Invented start');
  git(root, 'clone', '-q', '--bare', seed, remote);
  git(root, 'clone', '-q', '-c', 'core.autocrlf=false', remote, project);
  adapters = [];
  agent = () => undefined;
  server = await launch();
  server.database.db.insert(providerInstances).values([instance]).run();
  dispatch({ type: 'project.create', projectId: 'mug', name: 'Tea mug', cwd: project });
});

afterEach(async () => {
  await server.stop();
  if (ceiling === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
  else process.env['GIT_CEILING_DIRECTORIES'] = ceiling;
  await rm(root, { recursive: true, force: true });
});

const create = (overrides: Partial<Extract<ServerCommand, { type: 'thread.create' }>> = {}) =>
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
    ...overrides,
  });

const send = (text = 'Make the bell ring twice', threadId = 't1') =>
  dispatch({ type: 'thread.sendMessage', threadId, text });

const projectState = () => ({
  status: git(project, 'status', '--porcelain', '--ignored'),
  head: git(project, 'rev-parse', 'HEAD'),
  branch: git(project, 'symbolic-ref', '--short', 'HEAD'),
  index: git(project, 'ls-files', '--stage'),
});

const branchOf = (threadId = 't1') => `wow/ring-the-bell-twice-${branchIdOf(threadId)}`;

// A turn that ran and whose copy is ready, with the agent's edit committed or not.
async function firstTurn(edit: (cwd: string) => void = () => undefined) {
  agent = (cwd) => edit(cwd);
  create();
  send();
  await turnEnds();
  await server.workspaces.settled();
  return thread();
}

describe("a chat thread's own working copy (thread work spec 10 to 18)", () => {
  it('names the folder and branch at create and makes the worktree before the provider is called, leaving the project folder alone (spec 11)', async () => {
    await writeFile(path.join(project, 'draft.md'), 'Mine, not committed\n');
    const before = projectState();
    create();
    const created = thread();
    expect(created.cwd).toBe(path.join(home, 'workspaces', `tea-mug-t${created.cwd.slice(-8)}`));
    expect(path.basename(created.cwd)).toMatch(/^tea-mug-t[0-9a-f]{8}$/);
    expect(created.branch).toBe(branchOf());
    expect(created.workingCopy).toMatchObject({ state: 'pending', branch: branchOf() });

    const seen: { cwd: string; branch: string; head: string }[] = [];
    agent = (cwd) => {
      seen.push({
        cwd,
        branch: git(cwd, 'symbolic-ref', '--short', 'HEAD'),
        head: git(cwd, 'rev-parse', 'HEAD'),
      });
      execFileSync('node', ['-e', "require('fs').writeFileSync('bell.ts', 'ring(); ring();\\n')"], {
        cwd,
      });
    };
    send();
    const ended = await turnEnds();
    expect(ended.state).toBe('completed');
    expect(seen).toEqual([{ cwd: created.cwd, branch: branchOf(), head: before.head }]);
    expect(await readFile(path.join(created.cwd, 'bell.ts'), 'utf8')).toBe('ring(); ring();\n');
    expect(thread().workingCopy).toMatchObject({
      state: 'ready',
      startSha: before.head,
      defaultBranch: 'main',
      note: null,
    });
    expect(projectState()).toEqual(before);
    expect(existsSync(path.join(project, 'bell.ts'))).toBe(false);
  });

  it('starts at the default branch tip after a fetch when the project says so', async () => {
    const other = path.join(root, 'other clone');
    git(root, 'clone', '-q', path.join(root, 'the remote.git'), other);
    const tip = await commit(other, 'news.md', 'Invented news\n', 'Invented commit elsewhere');
    git(other, 'push', '-q', 'origin', 'main');
    dispatch({
      type: 'setting.set',
      key: 'chat.workingCopyStart',
      scope: 'project:mug',
      value: 'defaultBranch',
    });
    const plan = await rpc('threads.workingCopyPlan', { projectId: 'mug' });
    expect(resultOf(plan)).toMatchObject({
      status: 'ok',
      start: 'defaultBranch',
      from: 'main',
      fetch: true,
    });
    const done = await firstTurn();
    expect(done.workingCopy).toMatchObject({
      state: 'ready',
      startSha: tip,
      defaultBranch: 'main',
    });
    expect(git(done.cwd, 'rev-parse', 'HEAD')).toBe(tip);
  });

  it('answers the plan for /chat/new, and none for a folder that is not a repository (spec 10)', async () => {
    dispatch({
      type: 'setting.set',
      key: 'chat.ownWorkingCopy',
      scope: 'project:mug',
      value: true,
    });
    const plan = await rpc('threads.workingCopyPlan', { projectId: 'mug' });
    expect(resultOf(plan)).toEqual({
      status: 'ok',
      on: true,
      template: 'wow/{{title}}-{{id}}',
      start: 'head',
      from: 'main',
      sha: git(project, 'rev-parse', 'HEAD'),
      fetch: false,
    });
    const plain = path.join(root, 'plain folder');
    await mkdir(plain);
    dispatch({ type: 'project.create', projectId: 'plain', name: 'Plain', cwd: plain });
    const none = await rpc('threads.workingCopyPlan', { projectId: 'plain' });
    expect(resultOf(none)).toMatchObject({ status: 'unavailable' });
  });

  it('refuses a copy without a project or for a session from a terminal', () => {
    expect(() => create({ projectId: undefined })).toThrow(CommandRejected);
    expect(() => create({ resumeSessionId: 'session-1' })).toThrow(/own folder/);
    expect(thread()).toBeUndefined();
  });

  it("fails the turn with git's reason when the branch is taken, sends nothing, and goes once the branch is gone (spec 12)", async () => {
    git(project, 'branch', branchOf());
    create();
    send();
    const failed = await turnEnds();
    expect(failed.state).toBe('failed');
    expect(thread().workingCopy).toMatchObject({ state: 'failed' });
    expect(thread().workingCopy?.error).toMatch(/already exists/);
    await server.providerService.idle();
    expect(startTurns()).toEqual([]);

    git(project, 'branch', '-D', branchOf());
    send();
    expect((await turnEnds('t1', 1)).state).toBe('completed');
    expect(startTurns()).toHaveLength(1);
    expect(thread().workingCopy).toMatchObject({ state: 'ready', error: null });
  });

  it('keeps the branch git made when the folder could not be made and takes it up again, so Retry works once the cause is gone (spec 12)', async () => {
    create();
    // A folder left at the thread's place, not a working copy.
    await mkdir(thread().cwd, { recursive: true });
    await writeFile(path.join(thread().cwd, 'left.txt'), 'Invented\n');
    send();
    expect((await turnEnds()).state).toBe('failed');
    expect(thread().workingCopy?.error).toMatch(/already exists/);
    const start = git(project, 'rev-parse', 'HEAD');
    expect(thread().workingCopy?.branchStart).toBe(start);
    // wow never deletes a branch: the one git made stays, at the start commit.
    expect(git(project, 'rev-parse', branchOf())).toBe(start);
    await server.providerService.idle();
    expect(startTurns()).toEqual([]);

    await rm(thread().cwd, { recursive: true });
    send();
    expect((await turnEnds('t1', 1)).state).toBe('completed');
    expect(startTurns()).toHaveLength(1);
    expect(git(thread().cwd, 'symbolic-ref', '--short', 'HEAD')).toBe(branchOf());
    expect(thread().workingCopy).toMatchObject({ state: 'ready', startSha: start, note: null });
  });

  it('keeps a branch a stop left without its folder and takes it up at the next message (restart)', async () => {
    create();
    // As if git had made the branch and the server stopped before the folder.
    const start = git(project, 'rev-parse', 'HEAD');
    dispatch({ type: 'thread.workingCopyBranching', threadId: 't1', startSha: start });
    git(project, 'branch', branchOf());
    await server.stop();
    server = await launch();
    await server.workspaces.settled();
    expect(thread().workingCopy).toMatchObject({
      state: 'failed',
      error: 'The server stopped while the working copy was being made',
    });
    expect(git(project, 'rev-parse', branchOf())).toBe(start);
    send();
    expect((await turnEnds()).state).toBe('completed');
    expect(thread().workingCopy).toMatchObject({ state: 'ready', startSha: start });
    expect(git(thread().cwd, 'symbolic-ref', '--short', 'HEAD')).toBe(branchOf());
  });

  it('forgets the start it noted when a stop came before git made the branch, so a branch the user then makes is not taken (restart)', async () => {
    create();
    // As if the server stopped after noting the start and before git ran.
    const start = git(project, 'rev-parse', 'HEAD');
    dispatch({ type: 'thread.workingCopyBranching', threadId: 't1', startSha: start });
    await server.stop();
    server = await launch();
    await server.workspaces.settled();
    expect(thread().workingCopy).toMatchObject({ state: 'failed', branchStart: null });

    // The user's own branch of that name, at the same commit.
    git(project, 'branch', branchOf());
    send();
    expect((await turnEnds()).state).toBe('failed');
    expect(thread().workingCopy?.error).toMatch(/already exists/);
    expect(startTurns()).toEqual([]);
  });

  it('forgets the start it noted when git failed before making the branch, so a branch the user then makes is not taken', async () => {
    // A branch named `wow` keeps git from making any `wow/...` branch.
    git(project, 'branch', 'wow');
    create();
    send();
    expect((await turnEnds()).state).toBe('failed');
    expect(git(project, 'branch', '--list', branchOf())).toBe('');
    expect(thread().workingCopy?.branchStart ?? null).toBeNull();

    git(project, 'branch', '-D', 'wow');
    git(project, 'branch', branchOf());
    send();
    expect((await turnEnds('t1', 1)).state).toBe('failed');
    expect(thread().workingCopy?.error).toMatch(/already exists/);
    expect(startTurns()).toEqual([]);
  });

  it('never deletes a branch that was there before the thread, across a restart (spec 15)', async () => {
    // The user's branch, at a commit nothing else reaches, that the thread's name happens to take.
    git(project, 'checkout', '-q', '--detach');
    const own = await commit(project, 'notes.md', 'Invented notes\n', 'Invented own work');
    git(project, 'branch', branchOf());
    git(project, 'checkout', '-q', 'main');
    create();
    await server.stop();
    server = await launch();
    await server.workspaces.settled();
    expect(git(project, 'rev-parse', branchOf())).toBe(own);
    // Nothing was ever sent, so nothing was being made: the copy waits for the first message.
    expect(thread().workingCopy).toMatchObject({ state: 'pending', error: null });

    send();
    expect((await turnEnds()).state).toBe('failed');
    expect(thread().workingCopy?.error).toMatch(/already exists/);
    await server.stop();
    server = await launch();
    await server.workspaces.settled();
    expect(git(project, 'rev-parse', branchOf())).toBe(own);
  });

  it('fails the turn for a project folder that is not a repository and goes once it is one', async () => {
    const plain = path.join(root, 'plain folder');
    await mkdir(plain);
    dispatch({ type: 'project.create', projectId: 'plain', name: 'Plain', cwd: plain });
    create({ projectId: 'plain' });
    send();
    expect((await turnEnds()).state).toBe('failed');
    expect(thread().workingCopy?.error).toMatch(/is not a Git repository/);
    await server.providerService.idle();
    expect(startTurns()).toEqual([]);

    git(plain, 'init', '-q', '-b', 'main');
    await commit(plain, 'notes.md', 'Invented\n', 'Invented start');
    send();
    expect((await turnEnds('t1', 1)).state).toBe('completed');
    expect(startTurns()[0]?.cwd).toBe(thread().cwd);
  });

  it('removes the copy at Mark done when it holds only commits, and the branch keeps them (spec 14)', async () => {
    const done = await firstTurn((cwd) => {
      git(cwd, 'add', '-A');
      execFileSync('node', ['-e', "require('fs').writeFileSync('bell.ts', 'ring();\\n')"], { cwd });
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-q', '-m', 'Ring the bell');
    });
    dispatch({ type: 'thread.setDone', threadId: 't1', done: true });
    await server.workspaces.settled();
    expect(thread().workingCopy).toMatchObject({ state: 'removed', error: null });
    expect(existsSync(done.cwd)).toBe(false);
    expect(git(project, 'log', '-1', '--format=%s', branchOf())).toBe('Ring the bell');
  });

  it('removes the copy at Mark done after a commit was amended on the branch (spec 14)', async () => {
    const done = await firstTurn((cwd) => {
      execFileSync('node', ['-e', "require('fs').writeFileSync('bell.ts', 'ring();\\n')"], { cwd });
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-q', '-m', 'Ring');
      git(cwd, 'commit', '-q', '--amend', '-m', 'Ring the bell');
    });
    dispatch({ type: 'thread.setDone', threadId: 't1', done: true });
    await server.workspaces.settled();
    expect(thread().workingCopy).toMatchObject({ state: 'removed' });
    expect(existsSync(done.cwd)).toBe(false);
  });

  it('keeps the copy at Mark done when a commit was made on no branch, and Remove names it (spec 14, 15)', async () => {
    const done = await firstTurn((cwd) => {
      git(cwd, 'checkout', '-q', '--detach');
      execFileSync('node', ['-e', "require('fs').writeFileSync('bell.ts', 'ring();\\n')"], { cwd });
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-q', '-m', 'Ring on no branch');
      // Back on the branch: the commit is reached only by this folder's history.
      git(cwd, 'checkout', '-q', branchOf());
    });
    dispatch({ type: 'thread.setDone', threadId: 't1', done: true });
    await server.workspaces.settled();
    expect(thread().workingCopy).toMatchObject({
      state: 'kept',
      unpushed: { uncommittedFiles: 0, commitsOnNoBranch: 1 },
    });
    expect(existsSync(done.cwd)).toBe(true);

    const shown = resultOf(await rpc('threads.workingCopyStatus', { threadId: 't1' }));
    expect(shown).toMatchObject({ commitsOnNoBranch: 1 });
    git(done.cwd, 'checkout', '-q', '--detach');
    await commit(done.cwd, 'kettle.ts', 'boil();\n', 'Boil on no branch');
    const refused = await rpc('threads.removeWorkingCopy', { threadId: 't1', expect: shown });
    expect(errorOf(refused)).toMatchObject({ code: 'conflict', data: { commitsOnNoBranch: 2 } });
    expect(errorOf(refused)?.message).toMatch(/2 commits on no branch/);
    expect(existsSync(done.cwd)).toBe(true);
  });

  it('keeps the copy at Mark done with an uncommitted and an ignored file and says so (spec 14)', async () => {
    const done = await firstTurn(async () => undefined);
    await writeFile(path.join(done.cwd, 'bell.ts'), 'ring();\n');
    await writeFile(path.join(done.cwd, 'debug.log'), 'Invented log\n');
    dispatch({ type: 'thread.setDone', threadId: 't1', done: true });
    await server.workspaces.settled();
    expect(thread().workingCopy).toMatchObject({
      state: 'kept',
      unpushed: { uncommittedFiles: 1, ignoredFiles: 1, branch: branchOf() },
    });
    expect(existsSync(done.cwd)).toBe(true);
  });

  it('removes only what the dialog showed, refuses a running turn and another live thread in the folder (spec 15)', async () => {
    const done = await firstTurn();
    await writeFile(path.join(done.cwd, 'bell.ts'), 'ring();\n');
    const status = await rpc('threads.workingCopyStatus', { threadId: 't1' });
    const shown = resultOf(status) as UnpushedWork;
    expect(shown).toMatchObject({ uncommittedFiles: 1, ignoredFiles: 0 });

    // A file added after the dialog opened.
    await writeFile(path.join(done.cwd, 'kettle.ts'), 'boil();\n');
    const refused = await rpc('threads.removeWorkingCopy', { threadId: 't1', expect: shown });
    expect(errorOf(refused)).toMatchObject({ code: 'conflict', data: { uncommittedFiles: 2 } });
    expect(errorOf(refused)?.message).toMatch(/2 uncommitted files/);
    expect(existsSync(done.cwd)).toBe(true);

    // Another thread that is not done works in the same folder: a fork.
    dispatch({
      type: 'thread.create',
      threadId: 't2',
      providerInstanceId: 'claude-work',
      cwd: project,
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
      forkFrom: { threadId: 't1', turnId: lastTurn()?.id ?? '' },
    });
    const shared = await rpc('threads.removeWorkingCopy', {
      threadId: 't1',
      expect: { ...shown, uncommittedFiles: 2 },
    });
    expect(errorOf(shared)).toMatchObject({ code: 'rejected' });
    expect(errorOf(shared)?.message).toMatch(/also works in this working copy/);
    dispatch({ type: 'thread.setDone', threadId: 't2', done: true });
    await server.workspaces.settled();

    const removed = await rpc('threads.removeWorkingCopy', {
      threadId: 't1',
      expect: resultOf(await rpc('threads.workingCopyStatus', { threadId: 't1' })),
    });
    expect(errorOf(removed)).toBeUndefined();
    expect(existsSync(done.cwd)).toBe(false);
    expect(thread().workingCopy?.state).toBe('removed');
    expect(thread('t2').workingCopy?.state).toBe('removed');
    expect(git(project, 'branch', '--list', branchOf())).toContain(branchOf());
  });

  it('refuses a removal when a file was swapped for another after the dialog read it (spec 15)', async () => {
    const done = await firstTurn();
    await writeFile(path.join(done.cwd, 'bell.ts'), 'ring();\n');
    const shown = resultOf(await rpc('threads.workingCopyStatus', { threadId: 't1' }));
    expect(shown).toMatchObject({ uncommittedFiles: 1 });

    // The same count, another file: the one shown is gone, a new one would be lost unseen.
    await rm(path.join(done.cwd, 'bell.ts'));
    await writeFile(path.join(done.cwd, 'kettle.ts'), 'boil();\n');
    const refused = await rpc('threads.removeWorkingCopy', { threadId: 't1', expect: shown });
    expect(errorOf(refused)).toMatchObject({ code: 'conflict', data: { uncommittedFiles: 1 } });
    expect(errorOf(refused)?.message).toMatch(/changed since you were shown it/);
    expect(existsSync(path.join(done.cwd, 'kettle.ts'))).toBe(true);

    const now = resultOf(await rpc('threads.workingCopyStatus', { threadId: 't1' }));
    expect(errorOf(await rpc('threads.removeWorkingCopy', { threadId: 't1', expect: now }))).toBe(
      undefined,
    );
    expect(existsSync(done.cwd)).toBe(false);
  });

  it('counts every file in an ignored folder and refuses a removal when one was added there after the dialog read it (spec 15)', async () => {
    const done = await firstTurn();
    await writeFile(path.join(project, '.git', 'info', 'exclude'), 'out/\n');
    await mkdir(path.join(done.cwd, 'out'));
    await writeFile(path.join(done.cwd, 'out', 'bell.js'), 'ring();\n');
    await writeFile(path.join(done.cwd, 'out', 'bell.js.map'), '{}\n');
    const shown = resultOf(await rpc('threads.workingCopyStatus', { threadId: 't1' }));
    expect(shown).toMatchObject({ uncommittedFiles: 0, ignoredFiles: 2 });

    await writeFile(path.join(done.cwd, 'out', 'secret.env'), 'TEA=invented\n');
    const refused = await rpc('threads.removeWorkingCopy', { threadId: 't1', expect: shown });
    expect(errorOf(refused)).toMatchObject({ code: 'conflict', data: { ignoredFiles: 3 } });
    expect(errorOf(refused)?.message).toMatch(/3 ignored files/);
    expect(existsSync(path.join(done.cwd, 'out', 'secret.env'))).toBe(true);
  });

  it('refuses removal while a turn runs', async () => {
    await firstTurn();
    send('Wait for the kettle');
    await server.providerService.idle();
    expect(lastTurn()?.state).toBe('running');
    const answer = await rpc('threads.removeWorkingCopy', {
      threadId: 't1',
      expect: {
        uncommittedFiles: 0,
        ignoredFiles: 0,
        unpushedCommits: 0,
        newestSubject: null,
        branch: branchOf(),
      },
    });
    expect(errorOf(answer)).toMatchObject({ code: 'rejected' });
    expect(errorOf(answer)?.message).toMatch(/A turn runs in this thread/);
    dispatch({
      type: 'provider.events',
      threadId: 't1',
      events: [{ type: 'turnCompleted', threadId: 't1' }],
    });
    expect(existsSync(thread().cwd)).toBe(true);
  });

  it('makes the copy again on its branch for a message after removal, and fails with the reason once the branch is gone (spec 16)', async () => {
    const done = await firstTurn((cwd) => {
      execFileSync('node', ['-e', "require('fs').writeFileSync('bell.ts', 'ring();\\n')"], { cwd });
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-q', '-m', 'Ring the bell');
    });
    dispatch({ type: 'thread.setDone', threadId: 't1', done: true });
    await server.workspaces.settled();
    expect(existsSync(done.cwd)).toBe(false);

    const seen: string[] = [];
    agent = (cwd) => seen.push(git(cwd, 'log', '-1', '--format=%s'));
    send('Ring once more');
    expect((await turnEnds('t1', 1)).state).toBe('completed');
    expect(seen).toEqual(['Ring the bell']);
    expect(git(done.cwd, 'symbolic-ref', '--short', 'HEAD')).toBe(branchOf());
    expect(thread().workingCopy).toMatchObject({
      state: 'ready',
      startSha: done.workingCopy?.startSha,
    });

    dispatch({ type: 'thread.setDone', threadId: 't1', done: true });
    await server.workspaces.settled();
    git(project, 'branch', '-D', branchOf());
    send('And again');
    expect((await turnEnds('t1', 2)).state).toBe('failed');
    expect(thread().workingCopy?.error).toMatch(/invalid reference|not a valid|branch/i);
    await server.providerService.idle();
    expect(startTurns()).toHaveLength(2);
  });

  it('gives a fork the same folder and branch, and its turn works there (spec 17)', async () => {
    const done = await firstTurn();
    dispatch({
      type: 'thread.create',
      threadId: 't2',
      providerInstanceId: 'claude-work',
      cwd: project,
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
      forkFrom: { threadId: 't1', turnId: lastTurn()?.id ?? '' },
    });
    expect(thread('t2')).toMatchObject({ cwd: done.cwd, branch: branchOf() });
    expect(thread('t2').workingCopy).toMatchObject({ path: done.cwd, state: 'ready' });
    send('Fork on', 't2');
    expect((await turnEnds('t2')).state).toBe('completed');
    expect(startTurns().at(-1)?.cwd).toBe(done.cwd);
  });

  it('takes a copy left being made by a stop as made when git finished it, else fails it (restart)', async () => {
    create();
    create({ threadId: 't2', title: 'Second' });
    // As if git had finished the first before the server stopped.
    const first = thread();
    git(project, 'worktree', 'add', '-q', '-b', branchOf(), first.cwd);
    await server.stop();
    server = await launch();
    await server.workspaces.settled();
    expect(thread().workingCopy).toMatchObject({
      state: 'ready',
      startSha: git(project, 'rev-parse', 'HEAD'),
    });
    // Git was never asked to make the second: it waits for its first message.
    expect(thread('t2').workingCopy).toMatchObject({ state: 'pending', error: null });
    send('Second', 't2');
    expect((await turnEnds('t2')).state).toBe('completed');
    expect(thread('t2').workingCopy).toMatchObject({ state: 'ready' });
  });

  it('works as before for a thread stored without a copy (spec 18)', async () => {
    dispatch({
      type: 'thread.create',
      threadId: 'old',
      providerInstanceId: 'claude-work',
      projectId: 'mug',
      cwd: project,
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
    });
    server.database.sqlite.prepare(`update threads set working_copy = null where id = 'old'`).run();
    expect(thread('old').workingCopy).toBeNull();
    send('Hello', 'old');
    expect((await turnEnds('old')).state).toBe('completed');
    expect(startTurns()[0]?.cwd).toBe(project);
    expect(existsSync(path.join(home, 'workspaces'))).toBe(false);
  });
});
