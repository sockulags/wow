import {
  hiddenText,
  type ServerCommand,
  type SettingRow,
  type SubscriptionTopic,
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

// Chief of staff plan U1: the readers of what agents produced and free slots.

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
