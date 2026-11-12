import type {
  Approval,
  ApprovalItemPayload,
  Command,
  DomainEventKind,
  ProviderAdapter,
  ProviderCommand,
  ProviderEvent,
  ProviderKind,
  ThreadDiff,
  ThreadItem,
  Turn,
} from '@wow/contracts';
import { SecretStore, plainProtector } from '@wow/secrets';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../core/engine.js';
import { snapshot } from '../core/subscriptions.js';
import { openDatabase, type Database } from '../db/database.js';
import { threads, turns } from '../db/schema.js';
import { ProviderAdapters } from '../hooks/providers.js';
import { createLogger } from '../logger.js';
import { SettingsService } from '../settings/service.js';
import {
  changesOptions,
  readRunBase,
  readThreadDiff,
  snapshotChanges,
} from '../workflows/changes.js';
import { eq, desc } from 'drizzle-orm';
import { ProviderService } from './service.js';

// Agent workbench U6 on the server: approvals in wow's words, a denial's note, "always allow"
// rules per project answered by wow itself, plan approvals, and a chat thread's changes from the
// base of its first turn. Adapters are driven by the test; folders and files are invented.

class DrivenAdapter implements ProviderAdapter {
  readonly requiresModel = false;
  readonly sent: ProviderCommand[] = [];
  readonly #listeners = new Set<(event: ProviderEvent) => void>();
  constructor(readonly kind: ProviderKind) {}

  send(command: ProviderCommand): Promise<unknown> {
    this.sent.push(command);
    return Promise.resolve({ ok: true });
  }

  emit(...events: ProviderEvent[]): void {
    for (const event of events) for (const listener of this.#listeners) listener(event);
  }

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

let dir: string;
let repo: string;
let database: Database;
let engine: Engine;
let settings: SettingsService;
let adapters: Record<ProviderKind, DrivenAdapter>;
let service: ProviderService;
let next = 0;
let tick = 0;

const clock = () => new Date(Date.UTC(2026, 10, 2, 8, 0, (tick += 1)));
const dispatch = (command: Command) => engine.dispatch(`c${(next += 1)}`, command);
const ceiling = process.env['GIT_CEILING_DIRECTORIES'];

const git = (folder: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-C',
      folder,
      '-c',
      'user.name=Invented',
      '-c',
      'user.email=invented@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    { stdio: 'pipe', encoding: 'utf8' },
  );

const committed = (kind: DomainEventKind) =>
  new Promise<void>((resolve) => {
    const off = engine.onCommit((commit) => {
      if (commit.events.some(({ event }) => event.kind === kind)) {
        off();
        resolve();
      }
    });
  });

const approvals = (threadId: string) =>
  snapshot(database.db, { topic: 'approvals', threadId }) as Approval[];
const approvalItem = (threadId: string) => {
  const found = (
    snapshot(database.db, { topic: 'threadItems', threadId }) as ThreadItem[]
  ).findLast((item) => item.kind === 'approval');
  return found?.payload as ApprovalItemPayload | undefined;
};
const threadState = (threadId: string) =>
  database.db.select({ state: threads.state }).from(threads).where(eq(threads.id, threadId)).get()
    ?.state;
const answers = (kind: ProviderKind) =>
  adapters[kind].sent.filter((command) => command.type === 'answerApproval');

const createThread = (threadId: string, kind: ProviderKind, projectId: string | null = 'p1') =>
  dispatch({
    type: 'thread.create',
    threadId,
    providerInstanceId: kind,
    cwd: repo,
    ...(projectId === null ? {} : { projectId }),
    model: 'mock-model',
    effort: 'high',
    permissionMode: kind === 'claude' ? 'default' : 'auto',
  });

// A thread with a running turn, its first turn's folder read and sent.
async function running(threadId: string, kind: ProviderKind, projectId: string | null = 'p1') {
  createThread(threadId, kind, projectId);
  dispatch({ type: 'thread.sendMessage', threadId, text: 'Work on the kettle' });
  await service.idle();
}

async function ask(
  kind: ProviderKind,
  event: Extract<ProviderEvent, { type: 'approvalRequested' }>,
) {
  const stored = committed('approval.requested');
  adapters[kind].emit(event);
  await stored;
}

const command = (threadId: string, approvalId: string, line: string, hint?: string) =>
  ({
    type: 'approvalRequested',
    threadId,
    approvalId,
    kind: 'command',
    summary: line,
    request: { command: line },
    facts: { kind: 'command', command: line, cwd: repo, ...(hint ? { ruleHint: hint } : {}) },
  }) as const;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wow-approvals-'));
  process.env['GIT_CEILING_DIRECTORIES'] = dir;
  repo = path.join(dir, 'kettle');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'src', 'timer.ts'), 'export const minutes = 3;\n');
  await writeFile(path.join(repo, 'README.md'), '# Kettle\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Invented start');
  database = openDatabase(path.join(dir, 'wow.sqlite'));
  engine = new Engine(database.db, { clock });
  settings = new SettingsService(database.db, engine);
  adapters = { claude: new DrivenAdapter('claude'), codex: new DrivenAdapter('codex') };
  service = new ProviderService({
    db: database.db,
    engine,
    adapters: new ProviderAdapters(
      { claude: () => adapters.claude, codex: () => adapters.codex },
      {},
    ),
    settings,
    secrets: new SecretStore({ dir, protector: plainProtector }),
    home: dir,
    assistant: () => undefined,
    logger: createLogger(
      () => 'error',
      () => undefined,
    ),
    changes: {
      base: (folder) => readRunBase(folder, changesOptions(settings)),
      snapshot: (folder, baseSha) => snapshotChanges(folder, baseSha, changesOptions(settings)),
    },
  });
  for (const kind of ['claude', 'codex'] as const) {
    dispatch({
      type: 'providerInstance.create',
      providerInstanceId: kind,
      kind,
      name: kind,
      binaryPath: kind,
      configDir: path.join(dir, kind),
      env: {},
      launchArgs: [],
    });
  }
  dispatch({ type: 'project.create', projectId: 'p1', name: 'Kettle', cwd: repo });
  dispatch({ type: 'project.create', projectId: 'p2', name: 'Teapot', cwd: repo });
});

afterEach(async () => {
  await service.stop();
  database.close();
  if (ceiling === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
  else process.env['GIT_CEILING_DIRECTORIES'] = ceiling;
  await rm(dir, { recursive: true, force: true });
});

describe('approvals in wow words (spec 36)', () => {
  it('keeps the facts of a command, an edit and a tool, and offers a rule for none but edits', async () => {
    await running('t1', 'claude');
    await ask('claude', command('t1', 'a1', 'pnpm test --watch'));
    expect(approvalItem('t1')).toMatchObject({
      kind: 'command',
      facts: { command: 'pnpm test --watch', cwd: repo },
      rule: { kind: 'command', prefix: 'pnpm test' },
    });
    dispatch({ type: 'approval.answer', approvalId: 't1:a1', decision: 'allowOnce' });
    await ask('claude', {
      type: 'approvalRequested',
      threadId: 't1',
      approvalId: 'a2',
      kind: 'fileChange',
      summary: 'Edit src/timer.ts',
      request: {},
      facts: { kind: 'edit', path: 'src/timer.ts', diff: '@@ -1 +1 @@\n-a\n+b' },
    });
    expect(approvalItem('t1')).toEqual({
      approvalId: 't1:a2',
      kind: 'fileChange',
      summary: 'Edit src/timer.ts',
      facts: { kind: 'edit', path: 'src/timer.ts', diff: '@@ -1 +1 @@\n-a\n+b' },
    });
    dispatch({ type: 'approval.answer', approvalId: 't1:a2', decision: 'allowOnce' });
    await ask('claude', {
      type: 'approvalRequested',
      threadId: 't1',
      approvalId: 'a3',
      kind: 'tool',
      summary: 'Create an issue',
      request: {},
      facts: { kind: 'mcp', server: 'github', tool: 'create_issue', arguments: { title: 'Bell' } },
    });
    expect(approvalItem('t1')).toMatchObject({
      facts: { server: 'github', tool: 'create_issue', arguments: { title: 'Bell' } },
      rule: { kind: 'tool', server: 'github', tool: 'create_issue' },
    });
    // An edit is refused a rule: Accept edits is for that (spec 38).
    expect(() =>
      dispatch({ type: 'approval.answer', approvalId: 't1:a2', decision: 'allowAlways' }),
    ).toThrow(/already answered/);
  });

  it('cuts a long edit diff at chat.editDiffMaxLines', async () => {
    dispatch({ type: 'setting.set', key: 'chat.editDiffMaxLines', scope: 'global', value: 20 });
    await running('t1', 'codex');
    const diff = ['@@ -0,0 +1,30 @@', ...Array.from({ length: 30 }, (_, i) => `+line ${i}`)].join(
      '\n',
    );
    await ask('codex', {
      type: 'approvalRequested',
      threadId: 't1',
      approvalId: 'a1',
      kind: 'fileChange',
      summary: 'Add a file',
      request: {},
      facts: { kind: 'edit', path: 'src/new.ts', diff },
    });
    const item = approvalItem('t1');
    expect(item?.diffCut).toBe(true);
    expect(item?.facts?.diff?.split('\n')).toHaveLength(20);
    // A tool row keeps the counts of the whole edit next to its cut diff.
    const row = committed('threadItem.added');
    adapters.codex.emit({
      type: 'toolCallStarted',
      threadId: 't1',
      itemId: 'edit-1',
      name: 'Edit',
      input: {},
      kind: 'edit',
      path: 'src/new.ts',
      diff,
    });
    await row;
    const tool = (
      snapshot(database.db, { topic: 'threadItems', threadId: 't1' }) as ThreadItem[]
    ).findLast((entry) => entry.kind === 'tool_call')?.payload;
    expect(tool).toMatchObject({ diffCut: true, diffCounts: { added: 30, removed: 0 } });
  });

  it('keeps that a write is drawn from its input until its written diff replaces it', async () => {
    await running('t1', 'claude');
    const started = committed('threadItem.added');
    adapters.claude.emit({
      type: 'toolCallStarted',
      threadId: 't1',
      itemId: 'write-1',
      name: 'Write',
      input: {},
      kind: 'edit',
      path: 'src/timer.ts',
      diff: '@@ -0,0 +1 @@\n+export const minutes = 5;',
      diffWithoutFile: true,
    });
    await started;
    const row = () =>
      (snapshot(database.db, { topic: 'threadItems', threadId: 't1' }) as ThreadItem[]).findLast(
        (entry) => entry.kind === 'tool_call',
      )?.payload;
    expect(row()).toMatchObject({ diffWithoutFile: true });
    const ended = committed('threadItem.patched');
    adapters.claude.emit({
      type: 'toolCallCompleted',
      threadId: 't1',
      itemId: 'write-1',
      status: 'ok',
      diff: '@@ -1 +1 @@\n-export const minutes = 3;\n+export const minutes = 5;',
    });
    await ended;
    expect(row()).toMatchObject({ diffWithoutFile: false });
  });
});

describe('a denial with a note (spec 37)', () => {
  it('gives the note to Claude Code as the denial message', async () => {
    await running('t1', 'claude');
    await ask('claude', command('t1', 'a1', 'npm install'));
    const answered = committed('approval.answered');
    dispatch({
      type: 'approval.answer',
      approvalId: 't1:a1',
      decision: 'deny',
      note: '  Use pnpm instead.  ',
    });
    await answered;
    expect(answers('claude')).toEqual([
      { type: 'answerApproval', approvalId: 'a1', decision: 'deny', note: 'Use pnpm instead.' },
    ]);
    expect(approvalItem('t1')?.note).toBe('Use pnpm instead.');
    expect(adapters.claude.sent.some((sent) => sent.type === 'interrupt')).toBe(false);
  });

  it('on Codex declines, stops the turn and sends the note as the next message', async () => {
    await running('t1', 'codex');
    await ask('codex', command('t1', 'a1', 'npm install'));
    dispatch({ type: 'approval.answer', approvalId: 't1:a1', decision: 'deny', note: 'Use pnpm.' });
    await service.idle();
    expect(answers('codex')).toEqual([
      { type: 'answerApproval', approvalId: 'a1', decision: 'deny', note: 'Use pnpm.' },
    ]);
    expect(adapters.codex.sent.at(-1)).toEqual({ type: 'interrupt', threadId: 't1' });
    const sent = committed('turn.started');
    adapters.codex.emit({ type: 'turnInterrupted', threadId: 't1' });
    await sent;
    await service.idle();
    expect(adapters.codex.sent.at(-1)).toMatchObject({ type: 'startTurn', prompt: 'Use pnpm.' });
  });

  it('denies without a note when the note is empty', async () => {
    await running('t1', 'codex');
    await ask('codex', command('t1', 'a1', 'npm install'));
    dispatch({ type: 'approval.answer', approvalId: 't1:a1', decision: 'deny', note: '   ' });
    await service.idle();
    expect(answers('codex')).toEqual([
      { type: 'answerApproval', approvalId: 'a1', decision: 'deny' },
    ]);
    expect(adapters.codex.sent.some((sent) => sent.type === 'interrupt')).toBe(false);
  });
});

describe('always allow in this project (spec 38 to 40)', () => {
  it('stores the rule, allows the request, answers a later one in another thread by itself, and asks again once removed', async () => {
    await running('t1', 'claude');
    await ask('claude', command('t1', 'a1', 'pnpm test --watch'));
    const answered = committed('approval.answered');
    dispatch({ type: 'approval.answer', approvalId: 't1:a1', decision: 'allowAlways' });
    await answered;
    expect(answers('claude')).toEqual([
      { type: 'answerApproval', approvalId: 'a1', decision: 'allowOnce' },
    ]);
    expect(settings.get('approvals.alwaysAllow', { projectId: 'p1' })).toEqual([
      { kind: 'command', prefix: 'pnpm test', addedAt: expect.any(String) },
    ]);

    // Codex, in another thread of the project: wow answers, nobody is asked.
    await running('t2', 'codex');
    const byRule = committed('approval.answered');
    adapters.codex.emit(command('t2', 'b1', 'pnpm test'));
    await byRule;
    await service.idle();
    expect(approvals('t2')[0]?.decision).toBe('allowOnce');
    expect(approvalItem('t2')?.byRule).toEqual({ kind: 'command', prefix: 'pnpm test' });
    expect(threadState('t2')).toBe('working');
    expect(answers('codex')).toEqual([
      { type: 'answerApproval', approvalId: 'b1', decision: 'allowOnce' },
    ]);

    // Neither another project, nor a longer word, nor a chained command is covered.
    await running('t3', 'claude', 'p2');
    await ask('claude', command('t3', 'c1', 'pnpm test'));
    expect(approvals('t3')[0]?.decision).toBeNull();
    await ask('claude', command('t2', 'b2', 'pnpm tests'));
    await ask('claude', command('t2', 'b3', 'pnpm test && rm -rf src'));
    expect(approvals('t2').map((row) => row.decision)).toEqual(['allowOnce', null, null]);
    expect(approvalItem('t2')?.rule).toBeUndefined();

    // Removed in Settings: the next request asks.
    dispatch({ type: 'setting.set', key: 'approvals.alwaysAllow', scope: 'project:p1', value: [] });
    await running('t4', 'claude');
    await ask('claude', command('t4', 'd1', 'pnpm test'));
    expect(approvals('t4')[0]?.decision).toBeNull();
    expect(threadState('t4')).toBe('needs_you');
  });

  it('words the rule from the prefix the provider proposed, and matches a tool by its name', async () => {
    await running('t1', 'codex');
    await ask('codex', command('t1', 'a1', 'cargo build --release', 'cargo build'));
    expect(approvalItem('t1')?.rule).toEqual({ kind: 'command', prefix: 'cargo build' });
    dispatch({ type: 'approval.answer', approvalId: 't1:a1', decision: 'deny' });
    const tool = {
      type: 'approvalRequested',
      threadId: 't1',
      kind: 'tool',
      summary: 'Create an issue',
      request: {},
      facts: { kind: 'mcp', server: 'github', tool: 'create_issue' },
    } as const;
    await ask('codex', { ...tool, approvalId: 'a2' });
    dispatch({ type: 'approval.answer', approvalId: 't1:a2', decision: 'allowAlways' });
    const byRule = committed('approval.answered');
    adapters.codex.emit({ ...tool, approvalId: 'a3' });
    await byRule;
    expect(approvalItem('t1')?.byRule).toEqual({
      kind: 'tool',
      server: 'github',
      tool: 'create_issue',
    });
  });

  it('is not offered in a thread without a project, and refused there', async () => {
    await running('t1', 'claude', null);
    await ask('claude', command('t1', 'a1', 'pnpm test'));
    expect(approvalItem('t1')?.rule).toBeUndefined();
    expect(() =>
      dispatch({ type: 'approval.answer', approvalId: 't1:a1', decision: 'allowAlways' }),
    ).toThrow(/without a project/);
  });
});

describe('a plan approval (spec 42)', () => {
  it('keeps the plan of the request, or the turn’s last text, and starts in the chosen mode', async () => {
    await running('t1', 'claude');
    await ask('claude', {
      type: 'approvalRequested',
      threadId: 't1',
      approvalId: 'p1',
      kind: 'plan',
      summary: 'Exit plan mode',
      request: {},
      facts: { kind: 'other', plan: '1. Read the timer' },
    });
    expect(approvalItem('t1')?.plan).toEqual({ text: '1. Read the timer', from: 'request' });
    expect(approvalItem('t1')?.rule).toBeUndefined();
    const answered = committed('approval.answered');
    dispatch({
      type: 'approval.answer',
      approvalId: 't1:p1',
      decision: 'allowOnce',
      permissionMode: 'acceptEdits',
    });
    await answered;
    expect(answers('claude')).toEqual([
      {
        type: 'answerApproval',
        approvalId: 'p1',
        decision: 'allowOnce',
        permissionMode: 'acceptEdits',
      },
    ]);
    expect(
      database.db
        .select({ mode: threads.permissionMode })
        .from(threads)
        .where(eq(threads.id, 't1'))
        .get()?.mode,
    ).toBe('acceptEdits');

    const text = committed('approval.requested');
    adapters.claude.emit(
      { type: 'textDelta', threadId: 't1', itemId: 'm1', delta: 'Plan: first the bell, ' },
      { type: 'textDelta', threadId: 't1', itemId: 'm1', delta: 'then the timer.' },
      {
        type: 'approvalRequested',
        threadId: 't1',
        approvalId: 'p2',
        kind: 'plan',
        summary: 'Exit plan mode',
        request: {},
        facts: {},
      },
    );
    await text;
    expect(approvalItem('t1')?.plan).toEqual({
      text: 'Plan: first the bell, then the timer.',
      from: 'conversation',
    });
    expect(() =>
      dispatch({
        type: 'approval.answer',
        approvalId: 't1:p2',
        decision: 'allowOnce',
        permissionMode: 'bypassPermissions',
      }),
    ).toThrow(/does not start/);
  });
});

const diffOf = (threadId: string) => {
  const thread = database.db.select().from(threads).where(eq(threads.id, threadId)).get();
  const last = database.db
    .select({ fileMark: turns.fileMark })
    .from(turns)
    .where(eq(turns.threadId, threadId))
    .orderBy(desc(turns.index))
    .get();
  return readThreadDiff({
    folder: thread?.cwd ?? '',
    baseSha: thread?.baseSha ?? null,
    baseFiles: thread?.baseFiles ?? null,
    mark: last?.fileMark ?? null,
    options: changesOptions(settings),
  });
};
const listed = (diff: ThreadDiff) =>
  diff.files.map((file) => [file.path, file.added, file.removed]);

describe('a chat thread’s changes (spec 34, 35)', () => {
  it('measures from the base of the first turn and narrows to the last turn by its mark', async () => {
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    // Edited before the thread began and not touched by it: not the thread's change.
    await writeFile(path.join(repo, 'notes.txt'), 'kept\n');
    git(repo, 'add', 'notes.txt');
    await running('t1', 'claude');
    expect(
      database.db.select({ sha: threads.baseSha }).from(threads).where(eq(threads.id, 't1')).get()
        ?.sha,
    ).toBe(head);
    // The first turn edits the timer.
    await writeFile(path.join(repo, 'src', 'timer.ts'), 'export const minutes = 4;\n');
    adapters.claude.emit({ type: 'turnCompleted', threadId: 't1' });
    await committed('turn.ended');
    // The second turn adds a file and edits the readme.
    const marked = committed('thread.changesMarked');
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Now the bell' });
    await marked;
    await service.idle();
    await writeFile(path.join(repo, 'src', 'bell.ts'), 'ring();\nring();\n');
    await writeFile(path.join(repo, 'README.md'), '# Kettle\n\nIt rings.\n');
    const diff = await diffOf('t1');
    expect(diff.status).toBe('ok');
    expect(listed(diff)).toEqual([
      ['README.md', 2, 0],
      ['src/bell.ts', 2, 0],
      ['src/timer.ts', 1, 1],
    ]);
    expect(diff.turnPaths).toEqual(['README.md', 'src/bell.ts']);
  });

  it('tells the turns topic once the running first turn is marked, so the client reads again', async () => {
    const topics: string[][] = [];
    const off = engine.onCommit((commit) => {
      if (commit.events.some(({ event }) => event.kind === 'thread.changesMarked')) {
        topics.push([...commit.topics]);
      }
    });
    createThread('t1', 'claude');
    const marked = committed('thread.changesMarked');
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Work on the kettle' });
    // The turn has started, but wow has not read the folder for it yet.
    const before = snapshot(database.db, { topic: 'turns', threadId: 't1' }) as Turn[];
    expect(before.map((turn) => [turn.state, turn.marked])).toEqual([['running', false]]);
    expect((await diffOf('t1')).status).toBe('noBase');
    await marked;
    off();
    expect(topics).toEqual([expect.arrayContaining(['turns'])]);
    const after = snapshot(database.db, { topic: 'turns', threadId: 't1' }) as Turn[];
    expect(after.map((turn) => [turn.state, turn.marked])).toEqual([['running', true]]);
    expect((await diffOf('t1')).status).toBe('ok');
    await service.idle();
  });

  it('says why for a folder outside git and for a thread stored before bases were kept', async () => {
    const plain = path.join(dir, 'plain');
    await mkdir(plain);
    dispatch({
      type: 'thread.create',
      threadId: 't1',
      providerInstanceId: 'claude',
      cwd: plain,
      model: 'mock-model',
      effort: 'high',
      permissionMode: 'default',
    });
    dispatch({ type: 'thread.sendMessage', threadId: 't1', text: 'Hello' });
    await service.idle();
    expect((await diffOf('t1')).status).toBe('noRepository');
    // A thread whose turns ran before this change: no base was recorded and none is now.
    createThread('t2', 'claude');
    database.db
      .insert(turns)
      .values({
        id: 't2:turn:0',
        threadId: 't2',
        index: 0,
        state: 'completed',
        startedAt: '2026-11-01T08:00:00.000Z',
        endedAt: '2026-11-01T08:01:00.000Z',
        usage: null,
      })
      .run();
    dispatch({ type: 'thread.sendMessage', threadId: 't2', text: 'Again' });
    await service.idle();
    const old = await diffOf('t2');
    expect(old.status).toBe('noBase');
    expect(old.turnPaths).toBeNull();
  });
});
