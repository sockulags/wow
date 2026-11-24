import {
  assistantThreadId,
  type AssistantPermission,
  type AssistantPermissionUse,
  type Question,
  type ServerCommand,
  type SubscriptionTopic,
  type Thread,
  type ThreadItem,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '../core/subscriptions.js';
import { questions, threadItems, turns } from '../db/schema.js';
import { startServer, type RunningServer } from '../server.js';

// Chief of staff plan U3: threads the assistant starts, writes in and answers for.

const now = '2026-11-10T08:00:00.000Z';

let root: string;
let server: RunningServer;
let ids = 0;

const asUser = (command: ServerCommand) => server.engine.dispatch(`u${++ids}`, command);
const rows = <T>(topic: SubscriptionTopic, threadId?: string) =>
  snapshot(server.database.db, threadId ? { topic, threadId } : { topic }) as T[];
// The threads other than the Assistant thread, which is listed as a main thread too.
const threads = () => rows<Thread>('threads').filter((thread) => thread.id !== assistantThreadId);
const uses = () => rows<AssistantPermissionUse>('assistantPermissionUses');

interface Called {
  readonly isError: boolean;
  readonly text: string;
  readonly content: Record<string, unknown> & { outcome?: string; reason?: string };
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Called> {
  const result = await server.assistant.tools.call(name, args);
  return { ...result, content: JSON.parse(result.text) as Called['content'] };
}

const permission = (extra: Partial<AssistantPermission>): AssistantPermission => ({
  id: 'p1',
  kind: 'startThreads',
  projectIds: ['tea'],
  workflowIds: [],
  maxPermissionMode: 'plan',
  paused: false,
  addedAt: now,
  ...extra,
});

const allow = (...permissions: AssistantPermission[]) => {
  asUser({ type: 'setting.set', key: 'assistant.delegation', scope: 'global', value: true });
  asUser({
    type: 'setting.set',
    key: 'assistant.permissions',
    scope: 'global',
    value: permissions,
  });
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-delegation-'));
  await mkdir(path.join(root, 'tea'));
  server = await startServer({
    home: path.join(root, '.wow'),
    env: { WOW_PROVIDERS: 'mock' },
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    userHome: root,
    watchSkills: () => ({ close: () => Promise.resolve() }),
    clock: () => new Date(now),
  });
  asUser({
    type: 'providerInstance.create',
    providerInstanceId: 'claude-work',
    kind: 'claude',
    name: 'Claude at work',
    binaryPath: 'claude',
    configDir: '',
    env: {},
    launchArgs: [],
    defaultModel: 'mock-model',
    defaultEffort: 'high',
    defaultPermissionMode: 'default',
  });
  asUser({
    type: 'project.create',
    projectId: 'tea',
    name: 'Tea',
    cwd: path.join(root, 'tea'),
  });
  asUser({
    type: 'project.update',
    projectId: 'tea',
    defaultProviderInstanceId: 'claude-work',
  });
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

const startTea = () =>
  call('start_thread', {
    projectId: 'tea',
    title: 'Fix the fixture',
    message: 'The kettle fixture fails; find out why and fix it.',
  });

describe('Start threads (chief of staff spec 9, 10, 15)', () => {
  it('is refused without the permission, pointing to the offer', async () => {
    const refused = await startTea();
    expect(refused.isError).toBe(true);
    expect(refused.content.reason).toContain('offer_project_work');
    expect(threads()).toEqual([]);
  });

  it('starts a thread with the brief, marked as the assistant’s, at the permission’s mode', async () => {
    allow(permission({}));
    const started = await startTea();
    expect(started.content).toMatchObject({ outcome: 'done', underPermission: 'Start threads' });
    const [thread] = threads();
    expect(thread).toMatchObject({
      title: 'Fix the fixture',
      projectId: 'tea',
      startedBy: 'assistant',
      permissionMode: 'plan',
    });
    // Not a Git repository: the thread works in the project folder.
    expect(thread?.workingCopy ?? null).toBeNull();
    const sent = rows<ThreadItem>('threadItems', thread?.id).find((item) => item.kind === 'user');
    expect(sent?.payload).toMatchObject({
      text: 'The kettle fixture fails; find out why and fix it.',
    });
    expect(uses()).toMatchObject([
      { kind: 'startThreads', what: 'Started "Fix the fixture" in Tea' },
    ]);
  });

  it('plans instead of starting past assistant.maxDelegatedLive', async () => {
    allow(permission({}));
    asUser({ type: 'setting.set', key: 'assistant.maxDelegatedLive', scope: 'global', value: 1 });
    await startTea();
    const second = await startTea();
    expect(second.isError).toBe(true);
    expect(second.content.reason).toContain('Plan it for a free slot');
  });
});

describe('Drive threads (chief of staff spec 11, 12, 13)', () => {
  it("writes only in the assistant's own threads, under Drive threads", async () => {
    allow(permission({}));
    await startTea();
    const threadId = threads()[0]?.id ?? '';
    expect((await call('write_to_thread', { threadId, text: 'Also check the lid.' })).isError).toBe(
      true,
    );
    allow(permission({}), permission({ id: 'p2', kind: 'driveThreads' }));
    asUser({
      type: 'thread.create',
      threadId: 'mine',
      providerInstanceId: 'claude-work',
      projectId: 'tea',
      cwd: path.join(root, 'tea'),
      model: 'mock-model',
      effort: 'high',
      permissionMode: 'default',
    });
    const theirs = await call('write_to_thread', { threadId: 'mine', text: 'Hello' });
    expect(theirs.isError).toBe(true);
    expect(theirs.content.reason).toContain('threads you started');
  });

  it('answers a question in its thread with the words it comes from', async () => {
    allow(permission({}), permission({ id: 'p2', kind: 'driveThreads' }));
    await startTea();
    const threadId = threads()[0]?.id ?? '';
    // The agent asks while its turn runs: the brief's turn, or one put in its place.
    const running = server.database.db
      .select()
      .from(turns)
      .all()
      .find((turn) => turn.threadId === threadId && turn.state === 'running');
    const turnId = running?.id ?? 'asking-turn';
    if (!running) {
      server.database.db
        .insert(turns)
        .values({ id: turnId, threadId, index: 99, state: 'running', startedAt: now })
        .run();
    }
    server.database.db
      .insert(threadItems)
      .values({
        id: 'q1-item',
        threadId,
        turnId,
        index: 99,
        kind: 'question',
        payload: {},
        streaming: false,
      })
      .run();
    server.database.db
      .insert(questions)
      .values({ id: 'q1', threadId, itemId: 'q1-item', request: { question: 'Which fixture?' } })
      .run();
    const answered = await call('answer_agent_question', {
      threadId,
      questionId: 'q1',
      reply: { picked: [], text: 'kettle.json' },
      because: 'The kettle fixture fails',
    });
    expect(answered.text).not.toContain('refused');
    const [question] = rows<Question>('questions', threadId);
    expect(question).toMatchObject({
      answer: 'kettle.json',
      answeredBecause: 'The kettle fixture fails',
    });
  });

  it('gives the assistant a turn to follow its thread, up to assistant.followTurns', async () => {
    allow(permission({}));
    await server.providerService.test('claude-work');
    asUser({ type: 'thread.openAssistant', fallbackModel: 'mock-model', fallbackEffort: 'high' });
    asUser({ type: 'setting.set', key: 'assistant.followTurns', scope: 'global', value: 1 });
    await startTea();
    const threadId = threads()[0]?.id ?? '';
    asUser({ type: 'assistant.follow', threadId, reason: 'turnEnded' });
    asUser({ type: 'assistant.follow', threadId, reason: 'turnEnded' });
    const notes = rows<ThreadItem>('threadItems', assistantThreadId).filter(
      (item) =>
        item.kind === 'user' &&
        String((item.payload as { text?: string }).text).startsWith('From wow:'),
    );
    expect(notes).toHaveLength(1);
    expect(threads().find((thread) => thread.id === threadId)?.followTurns).toBe(1);
  });

  it('refuses the delegation commands from anyone but the assistant', () => {
    expect(() =>
      asUser({
        type: 'assistant.startThread',
        threadId: 'x',
        projectId: 'tea',
        title: 't',
        message: 'm',
        ownWorkingCopy: false,
      }),
    ).toThrow(/Only the assistant/);
  });
});
