import {
  ChangesAppliedItemPayload,
  RpcResponse,
  applyConfirmedOf,
  type ApplyPreview,
  type ProviderInstance,
  type ServerCommand,
  type Thread,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { CommandRejected } from '../core/orchestrator.js';
import { providerInstances, threadItems, threads, turns } from '../db/schema.js';
import { MockProviderAdapter } from '../hooks/index.js';
import { startServer, type RunningServer } from '../server.js';

// Parallel threads spec 1 to 10 against repositories the test makes: a project cloned (with
// `core.autocrlf=false`) from a bare remote, and a thread working in its own copy of it. Every
// folder has a space in its name, as a Windows user folder often does. All invented.

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
  await writeFile(path.join(seed, 'bell.ts'), bellLines.join('\n'));
  await writeFile(path.join(seed, 'old.md'), 'Old page\n');
  await writeFile(path.join(seed, 'notes.md'), 'Kettle notes\n');
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

const bellLines = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', ''];

const at = (folder: string, relative: string) => path.join(folder, ...relative.split('/'));
const read = (folder: string, relative: string) => readFile(at(folder, relative), 'utf8');

const create = () =>
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

const projectHistory = () => ({
  head: git(project, 'rev-parse', 'HEAD'),
  branch: git(project, 'symbolic-ref', '--short', 'HEAD'),
  index: git(project, 'ls-files', '--stage'),
  stash: git(project, 'stash', 'list'),
});

// A turn in the thread's own copy in which the invented agent does `edit` there.
async function threadTurn(edit: (cwd: string) => void) {
  agent = (cwd) => edit(cwd);
  create();
  dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Ring the bell twice' });
  await turnEnds();
  await server.workspaces.settled();
  return thread();
}

const preview = async () =>
  resultOf(await rpc('threads.applyPreview', { threadId: 't1' })) as ApplyPreview;

const apply = (shown: ApplyPreview) =>
  rpc('dispatch', {
    commandId: `apply-${(commandCount += 1)}`,
    command: { type: 'thread.applyToProject', threadId: 't1', confirmed: applyConfirmedOf(shown) },
  });

const undo = (itemId: string) =>
  rpc('dispatch', {
    commandId: `undo-${(commandCount += 1)}`,
    command: { type: 'thread.undoApply', threadId: 't1', itemId },
  });

const lines = () =>
  server.database.db
    .select()
    .from(threadItems)
    .where(eq(threadItems.threadId, 't1'))
    .all()
    .filter((item) => item.kind === 'changes_applied')
    .toSorted((a, b) => a.index - b.index)
    .map((item) => ({ id: item.id, ...ChangesAppliedItemPayload.parse(item.payload) }));

const outcomes = (shown: ApplyPreview) =>
  Object.fromEntries(shown.files.map((file) => [file.path, [file.outcome, file.reason]]));

const ringTwice = (cwd: string) => {
  writeFileSync(at(cwd, 'bell.ts'), bellLines.join('\n').replace('two', 'ring twice'));
  writeFileSync(at(cwd, 'docs/new.md'.replace('docs/', '')), 'New page\n');
  rmSync(at(cwd, 'old.md'));
};

describe("a merge helper's copy of another repository (orchestrator threads spec 13)", () => {
  it('shows the merged commits and brings them home to that repository, not the project', async () => {
    const other = path.join(root, 'tea pot');
    git(root, 'clone', '-q', '-c', 'core.autocrlf=false', path.join(root, 'the remote.git'), other);
    // What a merge helper's agent does: two helpers' branches, merged into its own in one commit.
    agent = (cwd) => {
      const start = git(cwd, 'rev-parse', 'HEAD');
      for (const [branch, file] of [
        ['wow/helper/ring', 'ring.md'],
        ['wow/helper/polish', 'polish.md'],
      ] as const) {
        git(cwd, 'checkout', '-q', '-b', branch, start);
        writeFileSync(at(cwd, file), `${branch}\n`);
        git(cwd, 'add', '-A');
        git(cwd, 'commit', '-q', '-m', `Invented work on ${branch}`);
      }
      git(cwd, 'checkout', '-q', 'wow/helper/abc123');
      git(cwd, 'merge', '-q', '--no-edit', 'wow/helper/ring', 'wow/helper/polish');
    };
    dispatch({
      type: 'thread.create',
      threadId: 't1',
      providerInstanceId: 'claude-work',
      projectId: 'mug',
      cwd: other,
      title: 'Merge the helpers',
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
      ownWorkingCopy: true,
      copyFrom: other,
      branch: 'wow/helper/abc123',
    });
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Merge them' });
    await turnEnds();
    await server.workspaces.settled();
    const projectBefore = projectHistory();
    const shown = await preview();
    expect(shown).toMatchObject({ status: 'ok', projectFolder: other });
    expect(outcomes(shown)).toEqual({
      'polish.md': ['write', null],
      'ring.md': ['write', null],
    });
    expect(errorOf(await apply(shown))).toBeUndefined();
    expect(await read(other, 'ring.md')).toBe('wow/helper/ring\n');
    expect(await read(other, 'polish.md')).toBe('wow/helper/polish\n');
    expect(existsSync(at(project, 'ring.md'))).toBe(false);
    expect(projectHistory()).toEqual(projectBefore);
  });
});

describe('Apply to project folder (parallel threads spec 1 to 10)', () => {
  it('writes, adds and deletes what the thread changed and leaves the history alone (spec 2, 3, 7, 8)', async () => {
    await threadTurn(ringTwice);
    const history = projectHistory();
    const shown = await preview();
    expect(shown).toMatchObject({ status: 'ok', projectFolder: project });
    expect(outcomes(shown)).toEqual({
      'bell.ts': ['write', null],
      'new.md': ['write', null],
      'old.md': ['delete', null],
    });
    expect(shown.files.map((file) => file.change)).toEqual(['modified', 'added', 'deleted']);
    expect(errorOf(await apply(shown))).toBeUndefined();
    expect(await read(project, 'bell.ts')).toContain('ring twice');
    expect(await read(project, 'new.md')).toBe('New page\n');
    expect(existsSync(at(project, 'old.md'))).toBe(false);
    expect(projectHistory()).toEqual(history);
    expect(git(thread().cwd, 'status', '--porcelain')).toContain('bell.ts');
    expect(lines()).toMatchObject([
      { written: ['bell.ts', 'new.md'], merged: [], removed: ['old.md'], left: [], failed: [] },
    ]);
    expect(lines()[0]?.savedAs).toMatch(/^\d+-[0-9a-f]{40}$/);
  });

  it('takes commits on the thread branch too and says when there is nothing left to write', async () => {
    await threadTurn((cwd) => {
      writeFileSync(at(cwd, 'notes.md'), 'Kettle notes, steeped\n');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-q', '-m', 'Invented commit in the copy');
    });
    const shown = await preview();
    expect(outcomes(shown)).toEqual({ 'notes.md': ['write', null] });
    await apply(shown);
    expect(await preview()).toMatchObject({
      status: 'nothing',
      files: [{ path: 'notes.md', outcome: 'same' }],
    });
  });

  it('merges a file both changed in different places and leaves the rest for the user (spec 3)', async () => {
    await threadTurn((cwd) => {
      writeFileSync(at(cwd, 'bell.ts'), bellLines.join('\n').replace('two', 'ring twice'));
      writeFileSync(at(cwd, 'notes.md'), 'Kettle notes from the thread\n');
      writeFileSync(at(cwd, 'old.md'), 'Old page, changed by the thread\n');
      rmSync(at(cwd, 'readme.md'));
      writeFileSync(at(cwd, 'mug.bin'), Buffer.from([0, 1, 2]));
    });
    await writeFile(at(project, 'bell.ts'), bellLines.join('\n').replace('seven', 'mine'));
    await writeFile(at(project, 'notes.md'), 'Kettle notes of mine\n');
    await rm(at(project, 'old.md'));
    await writeFile(at(project, 'readme.md'), '# Mine\n');
    await writeFile(at(project, 'mug.bin'), Buffer.from([0, 9]));
    const shown = await preview();
    expect(outcomes(shown)).toEqual({
      'bell.ts': ['merge', null],
      'mug.bin': ['left', 'binary'],
      'notes.md': ['left', 'conflict'],
      'old.md': ['left', 'deletedHere'],
      'readme.md': ['left', 'deletedThere'],
    });
    await apply(shown);
    const bell = await read(project, 'bell.ts');
    expect(bell).toContain('ring twice');
    expect(bell).toContain('mine');
    expect(await read(project, 'notes.md')).toBe('Kettle notes of mine\n');
    expect(existsSync(at(project, 'old.md'))).toBe(false);
    expect(await read(project, 'readme.md')).toBe('# Mine\n');
    expect(lines()[0]).toMatchObject({
      merged: ['bell.ts'],
      left: [
        { path: 'mug.bin', reason: 'both changed a binary file' },
        { path: 'notes.md', reason: 'both changed the same lines' },
        { path: 'old.md', reason: 'deleted in the project folder, changed in the thread' },
        { path: 'readme.md', reason: 'deleted in the thread, changed in the project folder' },
      ],
    });
  });

  it('writes nothing when the files changed since the confirm, and answers with the new lists (spec 6)', async () => {
    await threadTurn(ringTwice);
    const shown = await preview();
    await writeFile(at(project, 'new.md'), 'Mine first\n');
    const answer = await apply(shown);
    expect(errorOf(answer)).toMatchObject({ code: 'conflict' });
    const now = (errorOf(answer) as { data: ApplyPreview }).data;
    expect(outcomes(now)['new.md']).toEqual(['left', 'conflict']);
    expect(await read(project, 'bell.ts')).not.toContain('ring twice');
    expect(lines()).toEqual([]);
  });

  it('puts the files back on Undo, and leaves a file changed since (spec 9)', async () => {
    await threadTurn(ringTwice);
    await apply(await preview());
    await writeFile(at(project, 'new.md'), 'Edited after the apply\n');
    const [applied] = lines();
    expect(errorOf(await undo(applied?.id ?? ''))).toBeUndefined();
    expect(await read(project, 'bell.ts')).toBe(bellLines.join('\n'));
    expect(await read(project, 'old.md')).toBe('Old page\n');
    expect(await read(project, 'new.md')).toBe('Edited after the apply\n');
    const [first, second] = lines();
    expect(first?.undoneBy).toBe(second?.id);
    expect(second).toMatchObject({
      undoOf: first?.id,
      written: ['bell.ts', 'old.md'],
      left: [{ path: 'new.md', reason: 'changed since Apply' }],
    });
    expect(errorOf(await undo(first?.id ?? ''))).toMatchObject({ code: 'rejected' });
  });

  it('refuses without a working copy, while a turn runs, and from the engine alone (spec 1, 5, 10)', async () => {
    dispatch({
      type: 'thread.create',
      threadId: 't2',
      providerInstanceId: 'claude-work',
      projectId: 'mug',
      cwd: project,
      title: 'In the folder',
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
    });
    expect(
      resultOf(await rpc('threads.applyPreview', { threadId: 't2' })) as ApplyPreview,
    ).toMatchObject({ status: 'noWorkingCopy' });
    await threadTurn(ringTwice);
    // A turn in the project folder itself holds the apply.
    agent = () => undefined;
    dispatch({ type: 'thread.sendMessage', threadId: 't2', text: 'wait here' });
    expect(await preview()).toMatchObject({
      status: 'projectBusy',
      message: expect.stringContaining('In the folder'),
    });
    expect(() =>
      dispatch({
        type: 'thread.applyToProject',
        threadId: 't1',
        confirmed: { write: [], merge: [], left: [] },
      }),
    ).toThrow(CommandRejected);
  });
});
