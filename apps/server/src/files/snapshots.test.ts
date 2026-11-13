import {
  RpcResponse,
  confirmedOf,
  type ProviderCommand,
  type ProviderInstance,
  type RestoreConfirmed,
  type RestorePreview,
  type ServerCommand,
  type ThreadItem,
  type Turn,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { snapshot } from '../core/subscriptions.js';
import { providerInstances, restorePoints, threads, turns } from '../db/schema.js';
import { MockProviderAdapter } from '../hooks/index.js';
import { startServer, type RunningServer } from '../server.js';
import { FolderSnapshots, unsafeSnapshotPath } from './snapshots.js';

// Thread work spec 19 to 26 against repositories the test makes. The invented agent edits the
// bell, adds notes and deletes an old page; the test writes files between turns as an editor
// would. Every folder has a space in its name, as a Windows user folder often does.

let root: string;
let home: string;
let project: string;
let server: RunningServer;
let adapters: MockProviderAdapter[];
// What the invented agent does in its folder; the files it saw as its turn started.
let agent: (cwd: string, prompt: string) => void;
let now: number;
const ceiling = process.env['GIT_CEILING_DIRECTORIES'];
const dayMs = 24 * 60 * 60 * 1000;

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

const file = (relative: string) => path.join(project, ...relative.split('/'));
const read = (relative: string) => readFile(file(relative), 'utf8');

const turnRows = (id = 't1') =>
  server.database.db
    .select()
    .from(turns)
    .where(eq(turns.threadId, id))
    .all()
    .toSorted((a, b) => a.index - b.index);

const topicTurns = (id = 't1') =>
  snapshot(server.database.db, { topic: 'turns', threadId: id }) as Turn[];
const restoreLines = (id = 't1') =>
  (snapshot(server.database.db, { topic: 'threadItems', threadId: id }) as ThreadItem[]).filter(
    (item) => item.kind === 'files_restored',
  );

// Resolves once the turn `index` has ended and its end snapshot is kept: no sleeping or polling.
async function turnEnds(index: number, id = 't1') {
  await new Promise<void>((resolve) => {
    const check = () => {
      const turn = turnRows(id)[index];
      if (turn && turn.state !== 'running') {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = server.engine.onCommit(check);
    check();
  });
  await server.providerService.idle();
  await server.snapshots.idle();
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

const preview = async (params: Record<string, string>) =>
  resultOf(await rpc('threads.restorePreview', { threadId: 't1', ...params })) as RestorePreview;

const restore = (turnId: string, confirmed: RestoreConfirmed) =>
  rpc('dispatch', {
    commandId: `restore-${(commandCount += 1)}`,
    command: { type: 'thread.restoreFiles', threadId: 't1', turnId, confirmed },
  });

const undo = (itemId: string, confirmed: RestoreConfirmed) =>
  rpc('dispatch', {
    commandId: `undo-${(commandCount += 1)}`,
    command: { type: 'thread.undoRestore', threadId: 't1', itemId, confirmed },
  });

// The invented agent: "edit the bell" rings twice; "add the notes" adds docs/notes.md and
// deletes docs/old.md; "commit" commits what it changed.
const inventedAgent = (cwd: string, prompt: string) => {
  const at = (relative: string) => path.join(cwd, ...relative.split('/'));
  if (/edit the bell/i.test(prompt)) {
    execFileSync('node', [
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(at('src/bell.ts'))}, 'ring();\\r\\nring();\\r\\n')`,
    ]);
  }
  if (/add the notes/i.test(prompt)) {
    execFileSync('node', [
      '-e',
      `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(at('docs/notes.md'))}, 'Notes\\n'); fs.unlinkSync(${JSON.stringify(at('docs/old.md'))})`,
    ]);
  }
  if (/commit/i.test(prompt)) {
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'Invented commit');
  }
};

const launch = () =>
  startServer({
    home,
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: path.join(root, 'user'),
    clock: () => new Date((now += 1000)),
    watchSkills: () => ({ close: () => Promise.resolve() }),
    hooks: {
      providers: {
        claude: (row) => {
          const adapter = new MockProviderAdapter(row.kind, (command) => {
            if (command.type !== 'startTurn') return [];
            agent(command.cwd, command.prompt);
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

// The bytes of everything Git keeps in the repository: objects, refs and the index.
async function gitState(dir: string): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else
        state[path.relative(dir, full)] = createHash('sha256')
          .update(await readFile(full))
          .digest('hex');
    }
  };
  for (const part of ['objects', 'refs']) await walk(path.join(dir, '.git', part));
  for (const single of ['index', 'packed-refs', 'HEAD']) {
    const full = path.join(dir, '.git', single);
    if (existsSync(full)) {
      state[single] = createHash('sha256')
        .update(await readFile(full))
        .digest('hex');
    }
  }
  return state;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'wow snapshots ')));
  process.env['GIT_CEILING_DIRECTORIES'] = root;
  now = Date.UTC(2026, 10, 13, 9, 0, 0);
  home = path.join(root, 'wow home');
  project = path.join(root, 'tea chat');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await mkdir(path.join(project, 'docs'));
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'core.autocrlf', 'false');
  await writeFile(path.join(project, '.gitignore'), '.env\n');
  await writeFile(file('src/bell.ts'), 'ring();\r\n');
  await writeFile(file('docs/old.md'), 'Old page\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'Invented start');
  await writeFile(file('.env'), 'TOKEN=invented\n');
  adapters = [];
  agent = inventedAgent;
  server = await launch();
  server.database.db.insert(providerInstances).values([instance]).run();
  dispatch({ type: 'project.create', projectId: 'chat', name: 'Tea chat', cwd: project });
  dispatch({
    type: 'thread.create',
    threadId: 't1',
    providerInstanceId: 'claude-work',
    projectId: 'chat',
    cwd: project,
    title: 'Ring the bell',
    model: 'opus',
    effort: 'high',
    permissionMode: 'default',
  });
});

afterEach(async () => {
  await server.stop();
  if (ceiling === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
  else process.env['GIT_CEILING_DIRECTORIES'] = ceiling;
  await rm(root, { recursive: true, force: true });
});

const send = (text: string) => dispatch({ type: 'thread.sendMessage', threadId: 't1', text });

async function twoTurns() {
  send('Make the bell ring twice: edit the bell');
  await turnEnds(0);
  send('Now add the notes');
  await turnEnds(1);
}

const storeOf = () => server.snapshots.storeOf(project);
const tree = (snap: unknown) => (snap as { tree: string }).tree;
const treeFiles = (id: string) =>
  git(storeOf(), 'ls-tree', '-r', '--name-only', id).split('\n').toSorted();

describe('snapshots of a turn (spec 19)', () => {
  it("keeps each turn's start and end in wow's own store and writes nothing to the repository", async () => {
    const before = await gitState(project);
    await twoTurns();
    const rows = turnRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.startSnapshot).toMatchObject({ tree: expect.stringMatching(/^[0-9a-f]{40}$/) });
      expect(row.endSnapshot).toMatchObject({ tree: expect.stringMatching(/^[0-9a-f]{40}$/) });
    }
    expect(storeOf().startsWith(path.join(home, 'snapshots'))).toBe(true);
    expect(treeFiles(tree(rows[0]?.startSnapshot))).toEqual([
      '.gitignore',
      'docs/old.md',
      'src/bell.ts',
    ]);
    expect(treeFiles(tree(rows[1]?.endSnapshot))).toEqual([
      '.gitignore',
      'docs/notes.md',
      'src/bell.ts',
    ]);
    // Refs per turn, in wow's store.
    expect(git(storeOf(), 'for-each-ref', '--format=%(refname)').split('\n')).toHaveLength(4);
    expect(await gitState(project)).toEqual(before);
    expect(git(project, 'stash', 'list')).toBe('');
    expect(topicTurns().map((turn) => turn.restorable)).toEqual([true, true]);
    expect(topicTurns()[0]).not.toHaveProperty('startSnapshot');
  });

  it('keeps the exact bytes and the executable bit where the system has one', async () => {
    await writeFile(file('run.sh'), '#!/bin/sh\r\necho tea\r\n');
    await chmod(file('run.sh'), 0o755);
    send('Make the bell ring twice: edit the bell');
    await turnEnds(0);
    const start = turnRows()[0]?.startSnapshot as { tree: string };
    const listing = git(storeOf(), 'ls-tree', '-r', start.tree);
    expect(listing).toMatch(/^100755 blob [0-9a-f]+\trun\.sh$/m);
    expect(git(storeOf(), 'cat-file', '-p', `${start.tree}:src/bell.ts`)).toBe('ring();');
    const bytes = execFileSync('git', [
      '-C',
      storeOf(),
      'cat-file',
      'blob',
      `${start.tree}:src/bell.ts`,
    ]);
    expect(bytes.toString('utf8')).toBe('ring();\r\n');
  });

  it('stores a link as a link and leaves a file over the limit out, by name and size', async () => {
    dispatch({ type: 'setting.set', key: 'chat.snapshotMaxFileBytes', scope: 'global', value: 64 });
    await writeFile(file('big.bin'), 'x'.repeat(100));
    await symlink('../outside', file('docs/away'));
    send('Make the bell ring twice: edit the bell');
    await turnEnds(0);
    const start = turnRows()[0]?.startSnapshot as { tree: string; omitted: unknown[] };
    expect(start.omitted).toEqual([{ path: 'big.bin', size: 100 }]);
    expect(git(storeOf(), 'ls-tree', '-r', start.tree)).toMatch(
      /^120000 blob [0-9a-f]+\tdocs\/away$/m,
    );
    expect(git(storeOf(), 'cat-file', '-p', `${start.tree}:docs/away`)).toBe('../outside');
  });

  it('says why there is none for a folder outside Git, and the turn still goes', async () => {
    const plain = path.join(root, 'plain folder');
    await mkdir(plain);
    dispatch({
      type: 'thread.create',
      threadId: 't2',
      providerInstanceId: 'claude-work',
      cwd: plain,
      title: 'Plain',
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
    });
    dispatch({ type: 'thread.sendMessage', threadId: 't2', text: 'Hello' });
    await turnEnds(0, 't2');
    expect(turnRows('t2')[0]?.startSnapshot).toEqual({
      missing: expect.stringContaining('not in a Git repository'),
    });
    expect(startTurns().map((command) => command.prompt)).toContain('Hello');
    const answer = resultOf(
      await rpc('threads.restorePreview', { threadId: 't2', turnId: 't2:turn:0' }),
    ) as RestorePreview;
    expect(answer).toMatchObject({
      status: 'noRepository',
      message: expect.stringContaining('Git'),
    });
  });
});

describe('Restore files to here (spec 20, 22, 24, 25)', () => {
  it('lists what changes, puts the files back to the first snapshot and undoes it', async () => {
    await twoTurns();
    const repository = await gitState(project);
    const shown = await preview({ turnId: 't1:turn:0' });
    expect(shown).toEqual({
      status: 'ok',
      message: null,
      write: ['docs/old.md', 'src/bell.ts'],
      remove: ['docs/notes.md'],
      outside: [],
      notRestorable: [],
      leftAlone: [],
      outsideUnknown: false,
    });
    const answer = await restore('t1:turn:0', confirmedOf(shown));
    expect(errorOf(answer)).toBeUndefined();
    expect(await read('src/bell.ts')).toBe('ring();\r\n');
    expect(await read('docs/old.md')).toBe('Old page\n');
    expect(existsSync(file('docs/notes.md'))).toBe(false);
    expect(await read('.env')).toBe('TOKEN=invented\n');
    expect(await gitState(project)).toEqual(repository);

    const [line] = restoreLines();
    expect(line?.turnId).toBe('t1:turn:1');
    expect(line?.payload).toMatchObject({
      toTurnId: 't1:turn:0',
      written: ['docs/old.md', 'src/bell.ts'],
      removed: ['docs/notes.md'],
      failed: [],
    });

    const back = await preview({ undoItemId: line?.id ?? '' });
    expect(back).toMatchObject({
      status: 'ok',
      write: ['docs/notes.md', 'src/bell.ts'],
      remove: ['docs/old.md'],
      outside: [],
    });
    expect(errorOf(await undo(line?.id ?? '', confirmedOf(back)))).toBeUndefined();
    expect(await read('src/bell.ts')).toBe('ring();\r\nring();\r\n');
    expect(await read('docs/notes.md')).toBe('Notes\n');
    expect(existsSync(file('docs/old.md'))).toBe(false);
    const lines = restoreLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]?.payload).toMatchObject({ undoneBy: lines[1]?.id });
    expect(lines[1]?.payload).toMatchObject({ undoOf: lines[0]?.id });
    // Undone, and an undo, offer no Undo.
    expect(await preview({ undoItemId: lines[0]?.id ?? '' })).toMatchObject({
      status: 'noSnapshot',
    });
  });

  it('removes folders a delete leaves empty', async () => {
    send('Make the bell ring twice: edit the bell');
    await turnEnds(0);
    await mkdir(file('docs/deep/er'), { recursive: true });
    agent = (cwd) => {
      execFileSync('node', [
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(path.join(cwd, 'docs', 'deep', 'er', 'x.md'))}, 'x')`,
      ]);
    };
    send('Write deep');
    await turnEnds(1);
    const shown = await preview({ turnId: 't1:turn:1' });
    expect(shown.remove).toEqual(['docs/deep/er/x.md']);
    await restore('t1:turn:1', confirmedOf(shown));
    expect(existsSync(file('docs/deep'))).toBe(false);
    expect(existsSync(file('docs'))).toBe(true);
  });

  it('lists a file changed after the last turn as changed outside and refuses lists that differ', async () => {
    await twoTurns();
    // An editor writes the bell after the turn ended.
    await writeFile(file('src/bell.ts'), 'ring(); // mine\n');
    const shown = await preview({ turnId: 't1:turn:0' });
    expect(shown.outside).toEqual(['src/bell.ts']);
    const refused = await restore('t1:turn:0', { outside: [], notRestorable: [] });
    expect(errorOf(refused)).toMatchObject({
      code: 'conflict',
      data: { outside: ['src/bell.ts'] },
    });
    expect(await read('src/bell.ts')).toBe('ring(); // mine\n');
    expect(errorOf(await restore('t1:turn:0', confirmedOf(shown)))).toBeUndefined();
    expect(await read('src/bell.ts')).toBe('ring();\r\n');
  });

  it('leaves HEAD and the commits made after the turn, so the files show as changes', async () => {
    send('Make the bell ring twice: edit the bell');
    await turnEnds(0);
    send('Now add the notes and commit');
    await turnEnds(1);
    const head = git(project, 'rev-parse', 'HEAD');
    const shown = await preview({ turnId: 't1:turn:1' });
    await restore('t1:turn:1', confirmedOf(shown));
    expect(git(project, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(project, 'log', '--format=%s', '-1')).toBe('Invented commit');
    expect(git(project, 'status', '--porcelain')).toBe('D docs/notes.md\n?? docs/old.md');
  });
});

describe('files a restore leaves alone (spec 19, 25)', () => {
  it('never deletes a file that only appeared because the ignore rules changed', async () => {
    send('Make the bell ring twice: edit the bell');
    await turnEnds(0);
    // .env was ignored when the turn was taken; an edit of .gitignore lists it from now on.
    await writeFile(file('.gitignore'), '');
    const shown = await preview({ turnId: 't1:turn:0' });
    expect(shown.remove).not.toContain('.env');
    expect(shown.leftAlone).toEqual([{ path: '.env', reason: 'notFromThread' }]);
    expect(errorOf(await restore('t1:turn:0', confirmedOf(shown)))).toBeUndefined();
    expect(await read('.env')).toBe('TOKEN=invented\n');
    expect(await read('src/bell.ts')).toBe('ring();\r\n');
  });

  it('never deletes a file over the size limit, which no snapshot holds the bytes of', async () => {
    dispatch({ type: 'setting.set', key: 'chat.snapshotMaxFileBytes', scope: 'global', value: 64 });
    send('Make the bell ring twice: edit the bell');
    await turnEnds(0);
    agent = (cwd) => writeFileSync(path.join(cwd, 'agent.bin'), 'a'.repeat(100));
    send('Make a big file');
    await turnEnds(1);
    await writeFile(file('mine.bin'), 'm'.repeat(100));
    const shown = await preview({ turnId: 't1:turn:0' });
    expect(shown.remove).toEqual([]);
    expect(shown.outside).toEqual([]);
    expect(shown.leftAlone).toEqual([
      { path: 'agent.bin', reason: 'tooLarge' },
      { path: 'mine.bin', reason: 'tooLarge' },
    ]);
    expect(errorOf(await restore('t1:turn:0', confirmedOf(shown)))).toBeUndefined();
    expect(await read('agent.bin')).toBe('a'.repeat(100));
    expect(await read('mine.bin')).toBe('m'.repeat(100));
    expect(await read('src/bell.ts')).toBe('ring();\r\n');
  });
});

describe('when wow cannot tell what changed outside the thread (spec 22)', () => {
  it('lists every touched file as changed outside when the last turn has no end snapshot', async () => {
    await twoTurns();
    for (const endSnapshot of [null, { missing: 'wow could not read the folder: invented' }]) {
      server.database.db
        .update(turns)
        .set({ endSnapshot })
        .where(eq(turns.id, 't1:turn:1'))
        .run();
      const shown = await preview({ turnId: 't1:turn:0' });
      expect(shown).toMatchObject({
        status: 'ok',
        write: ['docs/old.md', 'src/bell.ts'],
        remove: ['docs/notes.md'],
        outside: ['docs/notes.md', 'docs/old.md', 'src/bell.ts'],
        outsideUnknown: true,
      });
    }
    const shown = await preview({ turnId: 't1:turn:0' });
    expect(errorOf(await restore('t1:turn:0', { outside: [], notRestorable: [] }))).toMatchObject({
      code: 'conflict',
    });
    expect(await read('src/bell.ts')).toBe('ring();\r\nring();\r\n');
    expect(errorOf(await restore('t1:turn:0', confirmedOf(shown)))).toBeUndefined();
    expect(await read('src/bell.ts')).toBe('ring();\r\n');
  });

  it('does the same for an undo when the restore recorded no state after it', async () => {
    await twoTurns();
    const shown = await preview({ turnId: 't1:turn:0' });
    await restore('t1:turn:0', confirmedOf(shown));
    const [line] = restoreLines();
    server.database.db.update(restorePoints).set({ after: null }).run();
    const back = await preview({ undoItemId: line?.id ?? '' });
    expect(back).toMatchObject({
      status: 'ok',
      write: ['docs/notes.md', 'src/bell.ts'],
      remove: ['docs/old.md'],
      outside: ['docs/notes.md', 'docs/old.md', 'src/bell.ts'],
      outsideUnknown: true,
    });
    expect(errorOf(await undo(line?.id ?? '', { outside: [], notRestorable: [] }))).toMatchObject({
      code: 'conflict',
    });
  });
});

describe('a preview queued behind an end snapshot (spec 22)', () => {
  it('reads the end snapshot the queue just took, so a later edit shows as changed outside', async () => {
    await twoTurns();
    server.database.db
      .update(turns)
      .set({ endSnapshot: null })
      .where(eq(turns.id, 't1:turn:1'))
      .run();
    // The editor writes the bell once the snapshot has read the folder: the clock is read at the
    // end of the read, and the preview below is already queued behind it.
    let edited = false;
    const snaps = new FolderSnapshots({
      db: server.database.db,
      engine: {
        dispatch: (id, command) => server.engine.dispatch(`${id}:again`, command),
      } as typeof server.engine,
      settings: server.settings,
      logger: {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
      },
      home,
      platform: 'linux',
      clock: () => {
        if (!edited) {
          edited = true;
          writeFileSync(file('src/bell.ts'), 'ring(); // mine, after the snapshot\n');
        }
        return new Date((now += 1000));
      },
    });
    const taking = snaps.take('t1', 't1:turn:1', 'end');
    const shown = snaps.preview({ threadId: 't1', turnId: 't1:turn:0' });
    await Promise.all([taking, shown]);
    expect(await shown).toMatchObject({
      status: 'ok',
      outside: ['src/bell.ts'],
      outsideUnknown: false,
    });
    expect(turnRows()[1]?.endSnapshot).toMatchObject({ files: expect.any(Number) });
  });
});

describe('refusals (spec 23, 26, 44)', () => {
  it('refuses while a turn runs, for an old turn, a step thread and a link out of the folder', async () => {
    await twoTurns();
    // A link where a folder was: writing docs/old.md would go through it.
    const away = path.join(root, 'away');
    await mkdir(away);
    await rm(file('docs'), { recursive: true });
    await symlink(away, file('docs'));
    expect(await preview({ turnId: 't1:turn:0' })).toMatchObject({
      status: 'outside',
      message: expect.stringContaining('docs/old.md leads through a link or junction'),
    });
    expect(await readdir(away)).toEqual([]);

    server.database.db
      .update(turns)
      .set({ startSnapshot: null })
      .where(eq(turns.id, 't1:turn:0'))
      .run();
    expect(await preview({ turnId: 't1:turn:0' })).toMatchObject({
      status: 'noSnapshot',
      message: expect.stringContaining('only the conversation can go back'),
    });

    send('Please wait');
    expect(await preview({ turnId: 't1:turn:1' })).toMatchObject({
      status: 'turnRunning',
      message: expect.stringContaining('A turn is running'),
    });

    server.database.db.update(threads).set({ runId: 'r1' }).where(eq(threads.id, 't1')).run();
    expect(await preview({ turnId: 't1:turn:1' })).toMatchObject({ status: 'notChat' });
    await server.providerService.idle();
  });

  it('names a file that was over the limit and restores the rest only after a yes', async () => {
    dispatch({ type: 'setting.set', key: 'chat.snapshotMaxFileBytes', scope: 'global', value: 64 });
    await writeFile(file('big.bin'), 'x'.repeat(100));
    await twoTurns();
    await writeFile(file('big.bin'), 'y'.repeat(100));
    // Written by the test after the turns: now it counts as changed outside too.
    const shown = await preview({ turnId: 't1:turn:0' });
    expect(shown.notRestorable).toEqual([{ path: 'big.bin', size: 100 }]);
    expect(shown.write).not.toContain('big.bin');
    expect(shown.remove).not.toContain('big.bin');
    expect(
      errorOf(await restore('t1:turn:0', { outside: shown.outside, notRestorable: [] })),
    ).toMatchObject({ code: 'conflict' });
    expect(await read('src/bell.ts')).toBe('ring();\r\nring();\r\n');
    expect(errorOf(await restore('t1:turn:0', confirmedOf(shown)))).toBeUndefined();
    expect(await read('src/bell.ts')).toBe('ring();\r\n');
    expect(await read('big.bin')).toBe('y'.repeat(100));
  });

  it('drops snapshots after the days kept, and the turn offers no Restore', async () => {
    await twoTurns();
    now += 31 * dayMs;
    await server.snapshots.expire();
    expect(topicTurns().map((turn) => turn.restorable)).toEqual([false, false]);
    expect(await preview({ turnId: 't1:turn:0' })).toMatchObject({
      status: 'noSnapshot',
      message: expect.stringContaining('dropped'),
    });
    expect(git(storeOf(), 'for-each-ref')).toBe('');
  });

  it('waits for an end snapshot in flight when the server stops and starts no work after it', async () => {
    await twoTurns();
    // The snapshot and the expiry that follows it would drop every ref, if they were let run.
    now += 31 * dayMs;
    let settled = false;
    const inFlight = server.snapshots.take('t1', 't1:turn:1', 'end').then(() => {
      settled = true;
    });
    await server.stop();
    expect(settled).toBe(true);
    await inFlight;
    const refs = git(storeOf(), 'for-each-ref', '--format=%(refname)').split('\n');
    expect(refs).toHaveLength(4);
    // Nothing starts once stopped: no snapshot, no expiry, no record in the closed database.
    await server.snapshots.take('t1', 't1:turn:1', 'end');
    await server.snapshots.expire();
    expect(git(storeOf(), 'for-each-ref', '--format=%(refname)').split('\n')).toEqual(refs);
  });

  it('offers no Restore on a turn stored before snapshots', async () => {
    await twoTurns();
    server.database.db.update(turns).set({ startSnapshot: null, endSnapshot: null }).run();
    expect(topicTurns().map((turn) => turn.restorable)).toEqual([false, false]);
  });

  it('refuses the command sent to the engine alone, as the assistant would', () => {
    expect(() =>
      dispatch({
        type: 'thread.restoreFiles',
        threadId: 't1',
        turnId: 't1:turn:0',
        confirmed: { outside: [], notRestorable: [] },
      }),
    ).toThrow(/after its confirm/);
  });
});

describe('Edit with "Conversation and files" (spec 21)', () => {
  it('puts the files back before the provider gets the new message', async () => {
    await twoTurns();
    const shown = await preview({ turnId: 't1:turn:1' });
    let seen: { notes: boolean; old: boolean } | undefined;
    agent = (cwd, prompt) => {
      if (prompt === 'Add the notes, shorter') {
        seen = {
          notes: existsSync(path.join(cwd, 'docs', 'notes.md')),
          old: existsSync(path.join(cwd, 'docs', 'old.md')),
        };
      }
    };
    const answer = await rpc('dispatch', {
      commandId: 'edit-1',
      command: {
        type: 'thread.editLast',
        threadId: 't1',
        turnId: 't1:turn:1',
        text: 'Add the notes, shorter',
        restoreFiles: { confirmed: confirmedOf(shown) },
      },
    });
    expect(errorOf(answer)).toBeUndefined();
    await turnEnds(2);
    expect(seen).toEqual({ notes: false, old: true });
    const [line] = restoreLines();
    expect(line?.turnId).toBe('t1:turn:2');
    expect(line?.payload).toMatchObject({ toTurnId: 't1:turn:1', edit: true });
  });

  it('sends nothing when the restore fails', async () => {
    await twoTurns();
    const sent = startTurns().length;
    // The lists differ from what the server finds: the turn fails with the reason.
    dispatch({
      type: 'thread.editLast',
      threadId: 't1',
      turnId: 't1:turn:1',
      text: 'Add the notes, shorter',
      restoreFiles: { confirmed: { outside: ['src/bell.ts'], notRestorable: [] } },
    });
    await turnEnds(2);
    expect(startTurns()).toHaveLength(sent);
    const failed = (
      snapshot(server.database.db, { topic: 'threadItems', threadId: 't1' }) as ThreadItem[]
    ).filter((item) => item.kind === 'error');
    expect(JSON.stringify(failed.at(-1)?.payload)).toContain('The files were not put back');
    expect(existsSync(file('docs/notes.md'))).toBe(true);
  });

  it('sends nothing when wow cannot read the snapshot', async () => {
    await twoTurns();
    const sent = startTurns().length;
    await rm(path.join(home, 'snapshots'), { recursive: true, force: true });
    dispatch({
      type: 'thread.editLast',
      threadId: 't1',
      turnId: 't1:turn:1',
      text: 'Once more',
      restoreFiles: { confirmed: { outside: [], notRestorable: [] } },
    });
    await turnEnds(2);
    expect(startTurns()).toHaveLength(sent);
    expect(turnRows()[2]?.state).toBe('failed');
  });

  it('checks the lists before the turn is decided and answers conflict', async () => {
    await twoTurns();
    await writeFile(file('src/bell.ts'), 'mine\n');
    const answer = await rpc('dispatch', {
      commandId: 'edit-2',
      command: {
        type: 'thread.editLast',
        threadId: 't1',
        turnId: 't1:turn:1',
        text: 'Again',
        restoreFiles: { confirmed: { outside: [], notRestorable: [] } },
      },
    });
    expect(errorOf(answer)).toMatchObject({ code: 'conflict' });
    expect(turnRows()).toHaveLength(2);
  });
});

describe('path rules', () => {
  it('refuses names that climb out or that Windows does not take', () => {
    expect(unsafeSnapshotPath('src/bell.ts', 'win32')).toBeUndefined();
    expect(unsafeSnapshotPath('../bell.ts', 'linux')).toMatch(/climbs out/);
    expect(unsafeSnapshotPath('a/./b', 'linux')).toMatch(/climbs out/);
    expect(unsafeSnapshotPath('/etc/passwd', 'linux')).toMatch(/full path/);
    expect(unsafeSnapshotPath('C:/x', 'win32')).toMatch(/full path/);
    expect(unsafeSnapshotPath('sub/.git/config', 'linux')).toMatch(/Git's own/);
    expect(unsafeSnapshotPath('docs/con.md', 'win32')).toMatch(/Windows/);
    expect(unsafeSnapshotPath('docs/con.md', 'linux')).toBeUndefined();
    expect(unsafeSnapshotPath('docs/a:b', 'win32')).toMatch(/Windows/);
    expect(unsafeSnapshotPath('docs/trailing.', 'win32')).toMatch(/Windows/);
    expect(unsafeSnapshotPath('a\\b', 'win32')).toMatch(/Windows/);
  });

  it('keeps one store per folder however Windows spells it', () => {
    const windows = new FolderSnapshots({
      db: server.database.db,
      engine: server.engine,
      settings: server.settings,
      logger: {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
      },
      home: 'C:\\Users\\tea\\.wow',
      platform: 'win32',
      clock: () => new Date(now),
    });
    expect(windows.storeOf('C:\\Code\\Tea')).toBe(windows.storeOf('c:/code/tea/'));
  });
});
