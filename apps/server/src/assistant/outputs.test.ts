import {
  hiddenText,
  type AssistantChange,
  type ServerCommand,
  type SettingRow,
  type SubscriptionTopic,
  type WorkflowRun,
  type WorkflowStep,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '../core/subscriptions.js';
import { threadItems } from '../db/schema.js';
import { startServer, type RunningServer } from '../server.js';
import { instructionsWithNotes } from './memory.js';

// Chief of staff plan U1: the readers of what agents produced, free slots, and the notes.

const lookalike = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
const now = '2026-11-10T08:00:00.000Z'; // a Tuesday

let root: string;
let server: RunningServer;
let ids = 0;

const asUser = (command: ServerCommand) => server.engine.dispatch(`u${++ids}`, command);
const rows = <T>(topic: SubscriptionTopic) => snapshot(server.database.db, { topic }) as T[];
const setting = (key: string) =>
  rows<SettingRow>('settings').find((row) => row.key === key && row.scope === 'global')?.value;

interface Called {
  readonly isError: boolean;
  readonly text: string;
  readonly content: Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Called> {
  const result = await server.assistant.tools.call(name, args);
  return { ...result, content: JSON.parse(result.text) as Record<string, unknown> };
}

const step = (id: string, extra: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  skillName: 'deliver-work',
  providerInstanceId: 'claude-work',
  model: 'mock-model',
  effort: 'high',
  gateBefore: false,
  gateAfter: true,
  expectedArtifacts: [],
  ...extra,
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-outputs-'));
  await mkdir(path.join(root, 'tea', 'intents'), { recursive: true });
  await writeFile(path.join(root, 'tea', 'intents', 'spec.md'), '# Spec\n\nThe kettle sings.\n');
  await writeFile(path.join(root, 'tea', 'private.md'), 'not an artifact\n');
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
    defaultModel: 'opus',
    defaultEffort: 'high',
    defaultPermissionMode: 'default',
  });
  asUser({ type: 'project.create', projectId: 'tea', name: 'Tea', cwd: path.join(root, 'tea') });
  asUser({
    type: 'workflow.create',
    workflowId: 'delivery',
    name: 'Delivery',
    steps: [step('s1', { expectedArtifacts: ['intents/*.md'] }), step('s2')],
  });
  asUser({ type: 'setting.set', key: 'calendar.zone', scope: 'global', value: 'UTC' });
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

function completedRun(finalMessage: string): WorkflowRun {
  asUser({ type: 'workflowRun.start', runId: 'run-1', workflowId: 'delivery', projectId: 'tea' });
  const run = rows<WorkflowRun>('workflowRuns')[0];
  asUser({
    type: 'workflowRun.stepCompleted',
    runId: 'run-1',
    stepId: run?.steps[0]?.stepId ?? '',
    finalMessage,
    artifactsFound: ['intents/spec.md'],
  });
  const done = rows<WorkflowRun>('workflowRuns')[0];
  if (!done) throw new Error('no run');
  return done;
}

describe('read_run (chief of staff spec 1, 2)', () => {
  it("returns a step's final message, verdict and its artifacts' text, and no other file", async () => {
    completedRun('Wrote the spec.\n\nAPPROVED');
    const { isError, content, text } = await call('read_run', { runId: 'run-1' });
    expect(isError).toBe(false);
    const [first] = content['steps'] as Record<string, unknown>[];
    expect(first).toMatchObject({
      stepId: 's1',
      skill: 'deliver-work',
      finalMessage: { text: 'Wrote the spec.\n\nAPPROVED', cut: false },
      artifacts: [{ path: 'intents/spec.md', read: true, text: '# Spec\n\nThe kettle sings.\n' }],
    });
    expect(text).not.toContain('not an artifact');
    expect(content['changes']).toHaveProperty('status');
  });

  it('cuts long text at assistant.readMaxBytes and says so', async () => {
    asUser({ type: 'setting.set', key: 'assistant.readMaxBytes', scope: 'global', value: 1000 });
    completedRun('x'.repeat(1500));
    const { content } = await call('read_run', { runId: 'run-1' });
    const [first] = content['steps'] as { finalMessage: { text: string; cut: boolean } }[];
    expect(first?.finalMessage.cut).toBe(true);
    expect(first?.finalMessage.text).toHaveLength(1000);
  });

  it('hides what looks like a secret in what the agent wrote', async () => {
    completedRun(`The token is ${lookalike}`);
    const { text } = await call('read_run', { runId: 'run-1' });
    expect(text).not.toContain(lookalike);
    expect(text).toContain(hiddenText);
  });

  it('refuses a run in a project the person excluded', async () => {
    completedRun('Done.');
    asUser({
      type: 'setting.set',
      key: 'assistant.excludedProjects',
      scope: 'global',
      value: ['tea'],
    });
    const { isError, text } = await call('read_run', { runId: 'run-1' });
    expect(isError).toBe(true);
    expect(text).toContain('may not read');
    expect(text).not.toContain('Done.');
  });

  it('takes no path, so no other file can be asked for', () => {
    const tool = server.assistant.tools.list().find((entry) => entry.name === 'read_run');
    expect(Object.keys(tool?.inputSchema['properties'] as object)).toEqual(['runId']);
  });
});

const item = (index: number, text: string) => ({
  id: `item-${index}`,
  threadId: 'thread-1',
  turnId: 'turn-1',
  index,
  kind: 'assistant_text' as const,
  payload: { text },
  streaming: false,
});

describe('read_thread (chief of staff spec 1)', () => {
  beforeEach(() => {
    asUser({
      type: 'thread.create',
      threadId: 'thread-1',
      providerInstanceId: 'claude-work',
      projectId: 'tea',
      cwd: path.join(root, 'tea'),
      title: 'About the kettle',
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
    });
    server.database.db
      .insert(threadItems)
      .values([item(1, 'First answer'), item(2, 'Second answer'), item(3, `Key ${lookalike}`)])
      .run();
  });

  it('returns the latest agent messages, newest last, up to assistant.readMaxMessages', async () => {
    asUser({ type: 'setting.set', key: 'assistant.readMaxMessages', scope: 'global', value: 2 });
    const { isError, content, text } = await call('read_thread', { threadId: 'thread-1' });
    expect(isError).toBe(false);
    expect(content).toMatchObject({ title: 'About the kettle', projectId: 'tea' });
    const messages = content['messages'] as { text: string }[];
    expect(messages.map((message) => message.text)).toEqual(['Second answer', `Key ${hiddenText}`]);
    expect(text).not.toContain(lookalike);
  });

  it("refuses the assistant's own conversation and threads in excluded projects", async () => {
    expect((await call('read_thread', { threadId: 'assistant' })).isError).toBe(true);
    asUser({
      type: 'setting.set',
      key: 'assistant.excludedProjects',
      scope: 'global',
      value: ['tea'],
    });
    const refused = await call('read_thread', { threadId: 'thread-1' });
    expect(refused.isError).toBe(true);
    expect(refused.text).not.toContain('First answer');
  });

  it('cannot take a project off the excluded list without a yes', async () => {
    asUser({
      type: 'setting.set',
      key: 'assistant.excludedProjects',
      scope: 'global',
      value: ['tea'],
    });
    const { content } = await call('set_setting', {
      key: 'assistant.excludedProjects',
      scope: 'global',
      value: [],
    });
    expect(content['outcome']).toBe('proposed');
    expect(setting('assistant.excludedProjects')).toEqual(['tea']);
  });
});

describe('read_free_slots', () => {
  it('lists gaps inside work hours around cards, earliest first', async () => {
    asUser({
      type: 'setting.set',
      key: 'calendar.workHours',
      scope: 'global',
      value: { start: '08:00', end: '12:00', days: ['tuesday', 'wednesday'] },
    });
    asUser({
      type: 'card.create',
      cardId: 'standup',
      title: 'Standup',
      start: '2026-11-10T09:00:00.000Z',
      end: '2026-11-10T10:30:00.000Z',
      zone: 'UTC',
    });
    const { content } = await call('read_free_slots', { minutes: 60, days: 2 });
    expect(content['slots']).toEqual([
      { start: '2026-11-10T08:00:00.000Z', end: '2026-11-10T09:00:00.000Z' },
      { start: '2026-11-10T10:30:00.000Z', end: '2026-11-10T12:00:00.000Z' },
      { start: '2026-11-11T08:00:00.000Z', end: '2026-11-11T12:00:00.000Z' },
    ]);
  });
});

const depsOn = (today: string) => ({
  db: server.database.db,
  settings: server.settings,
  clock: () => new Date(`${today}T12:00:00.000Z`),
});

describe('notes (chief of staff spec 29, 30)', () => {
  it('remember keeps a note as an ordinary change with Undo, and forget removes it', async () => {
    const kept = await call('remember', { text: 'Never plan anything before nine.' });
    expect(kept.content['outcome']).toBe('changed');
    const [note] = setting('assistant.notes') as { id: string; text: string; by: string }[];
    expect(note).toMatchObject({ text: 'Never plan anything before nine.', by: 'assistant' });
    const read = await call('read_notes');
    expect(read.content['notes']).toHaveLength(1);

    const [change] = rows<AssistantChange>('assistantChanges');
    expect(change).toMatchObject({
      what: 'Memory',
      from: 'None (default)',
      to: 'Never plan anything before nine.',
    });
    asUser({ type: 'assistant.undo', changeId: change?.id ?? '' });
    expect(setting('assistant.notes') ?? []).toEqual([]);

    await call('remember', { text: 'Tea matters most this week.', until: '2026-11-14' });
    const [again] = setting('assistant.notes') as { id: string }[];
    expect((await call('forget', { noteId: again?.id ?? '' })).content['outcome']).toBe('changed');
    expect(setting('assistant.notes')).toEqual([]);
    expect((await call('forget', { noteId: 'nope' })).isError).toBe(true);
  });

  it('adds the notes that still apply to the instructions', () => {
    asUser({
      type: 'setting.set',
      key: 'assistant.notes',
      scope: 'global',
      value: [
        { id: 'a', text: 'Tea first.', addedAt: now, until: '2026-11-14', by: 'you' },
        { id: 'b', text: 'Never before nine.', addedAt: now, by: 'assistant' },
      ],
    });
    const during = instructionsWithNotes(depsOn('2026-11-14'), 'Base.');
    expect(during).toContain('- Tea first. (until 2026-11-14)');
    expect(during).toContain('- Never before nine.');
    const after = instructionsWithNotes(depsOn('2026-11-15'), 'Base.');
    expect(after).not.toContain('Tea first.');
    expect(after.startsWith('Base.')).toBe(true);
  });
});
