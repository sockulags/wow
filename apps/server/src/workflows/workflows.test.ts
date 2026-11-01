import type {
  Command,
  ProviderCommand,
  ProviderInstance,
  Thread,
  WorkflowRun,
  WorkflowStep,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { eq } from 'drizzle-orm';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { providerInstances, skills, threads, workflowRuns } from '../db/schema.js';
import { MockProviderAdapter, type MockScript } from '../hooks/index.js';
import { startServer, type RunningServer } from '../server.js';
import type { RunNotification } from './runner.js';

let root: string;
let userHome: string;
let projectDir: string;
let server: RunningServer;
let adapters: MockProviderAdapter[];
let notifications: RunNotification[];
let script: MockScript;
let triggerSkillWatch: () => void;

// Echoes the prompt back as the assistant's final message, like the server's default mock.
const echo: MockScript = (command) => {
  if (command.type !== 'startTurn') return [];
  const { threadId } = command;
  return [
    { type: 'textDelta', threadId, itemId: `${threadId}-a`, delta: 'thinking' },
    { type: 'textDelta', threadId, itemId: `${threadId}-b`, delta: 'Done: ' },
    {
      type: 'textDelta',
      threadId,
      itemId: `${threadId}-b`,
      delta: command.prompt.split('\n')[0] ?? '',
    },
    { type: 'turnCompleted', threadId },
  ];
};

const instance = (
  id: string,
  kind: 'claude' | 'codex',
  model: string | null,
): ProviderInstance => ({
  id,
  kind,
  name: id,
  binaryPath: kind,
  configDir: '',
  env: {},
  launchArgs: [],
  defaultModel: model,
  defaultEffort: 'high',
  defaultPermissionMode: 'default',
  status: 'ready',
  account: null,
});

let commandCount = 0;
const dispatch = (command: Command) =>
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

const step = (id: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  skillName: id,
  providerInstanceId: 'claude-work',
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
  ...overrides,
});

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(
    path.join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n`,
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-workflows-'));
  userHome = path.join(root, 'user');
  projectDir = path.join(root, 'project');
  await mkdir(path.join(projectDir, 'intents', 'x'), { recursive: true });
  await writeFile(path.join(projectDir, 'intents', 'x', 'spec.md'), '# Spec\n');
  await writeSkill(path.join(userHome, '.claude', 'skills'), 'capture-intent');
  adapters = [];
  notifications = [];
  script = echo;
  triggerSkillWatch = () => undefined;
  server = await startServer({
    home: path.join(root, '.wow'),
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome,
    watchSkills: (_dirs, onChange) => {
      triggerSkillWatch = onChange;
      return { close: () => Promise.resolve() };
    },
    hooks: {
      providers: {
        claude: (row) => {
          const adapter = new MockProviderAdapter(row.kind, (command) => script(command));
          adapters.push(adapter);
          return adapter;
        },
        codex: (row) => {
          const adapter = new MockProviderAdapter(row.kind, (command) => script(command));
          adapters.push(adapter);
          return adapter;
        },
      },
    },
  });
  server.workflows.onNotify((notification) => notifications.push(notification));
  server.database.db
    .insert(providerInstances)
    .values([instance('claude-work', 'claude', 'opus'), instance('codex-work', 'codex', 'gpt-5')])
    .run();
  dispatch({ type: 'project.create', projectId: 'p1', name: 'wow', cwd: projectDir });
  await server.skills.refresh();
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

const startTurns = () =>
  adapters.flatMap((adapter) =>
    adapter.sent.filter(
      (command): command is Extract<ProviderCommand, { type: 'startTurn' }> =>
        command.type === 'startTurn',
    ),
  );

describe('skills projection', () => {
  it('fills the projection at start and after a project is added', () => {
    const names = server.database.db
      .select()
      .from(skills)
      .all()
      .map((row) => row.name);
    expect(names).toEqual(['capture-intent']);
  });

  it('picks up a new skill when a watched folder changes (behavior 27)', async () => {
    await writeSkill(path.join(projectDir, '.agents', 'skills'), 'plan-work');
    triggerSkillWatch();
    await server.skills.refresh();
    const rows = server.database.db.select().from(skills).all();
    expect(rows.map((row) => [row.name, row.source, row.invocations])).toEqual(
      expect.arrayContaining([
        ['capture-intent', 'user-claude', { claude: '/capture-intent', codex: '$capture-intent' }],
        ['plan-work', 'project-agents', { claude: '/plan-work', codex: '$plan-work' }],
      ]),
    );

    await rm(path.join(projectDir, '.agents'), { recursive: true });
    await server.skills.refresh();
    expect(
      server.database.db
        .select()
        .from(skills)
        .all()
        .map((row) => row.name),
    ).toEqual(['capture-intent']);
  });
});

describe('workflow runs', () => {
  beforeEach(() => {
    dispatch({
      type: 'workflow.create',
      workflowId: 'wf1',
      name: 'Feature',
      templateKind: 'feature',
      steps: [
        step('s1', {
          skillName: 'capture-intent',
          gateAfter: true,
          expectedArtifacts: ['intents/*/spec.md'],
        }),
        step('s2', {
          skillName: 'plan-work',
          providerInstanceId: 'codex-work',
          extraPrompt: 'Go.',
        }),
      ],
    });
  });

  it('starts step one, waits at the gate, and continues into step two (behaviors 9 and 11)', async () => {
    dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'wf1', projectId: 'p1' });
    expect(thread('r1.s1')).toMatchObject({
      projectId: 'p1',
      cwd: projectDir,
      providerInstanceId: 'claude-work',
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
      runId: 'r1',
      stepId: 's1',
      title: 'Feature: capture-intent',
    });

    const waiting = await runBecomes((current) => current.state === 'waiting');
    expect(waiting.steps[0]).toMatchObject({
      state: 'waiting',
      threadId: 'r1.s1',
      finalMessage: 'Done: /capture-intent',
      artifactsFound: ['intents/x/spec.md'],
    });
    expect(thread('r1.s1')?.state).toBe('needs_you');
    expect(notifications).toEqual([
      { type: 'notify', runId: 'r1', stepId: 's1', reason: 'waiting' },
    ]);
    expect(startTurns()).toEqual([
      {
        type: 'startTurn',
        threadId: 'r1.s1',
        cwd: projectDir,
        prompt: '/capture-intent\n\nThis step is expected to produce:\n- intents/*/spec.md',
        model: 'opus',
        effort: 'high',
        permissionMode: 'default',
      },
    ]);

    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    const done = await runBecomes((current) => current.state === 'done');
    expect(done.steps.map((entry) => entry.state)).toEqual(['done', 'done']);
    expect(thread('r1.s1')?.state).toBe('done');
    expect(thread('r1.s2')).toMatchObject({ state: 'done', providerInstanceId: 'codex-work' });
    expect(startTurns()[1]).toMatchObject({
      threadId: 'r1.s2',
      model: 'gpt-5',
      prompt: [
        '$plan-work Go.',
        '',
        'The previous step (capture-intent) ended with:',
        '',
        'Done: /capture-intent',
        '',
        'Artifacts from earlier steps:',
        '- intents/x/spec.md',
      ].join('\n'),
    });
    expect(notifications.at(-1)).toEqual({
      type: 'notify',
      runId: 'r1',
      stepId: null,
      reason: 'done',
    });
  });

  it('waits before a step with a gate before (behavior 10)', async () => {
    dispatch({
      type: 'workflow.create',
      workflowId: 'wf2',
      name: 'Gated',
      steps: [step('a'), step('b', { gateBefore: true })],
    });
    dispatch({ type: 'workflowRun.start', runId: 'r2', workflowId: 'wf2', projectId: 'p1' });
    const waiting = await runBecomes((current) => current.state === 'waiting', 'r2');
    expect(waiting.steps.map((entry) => entry.state)).toEqual(['done', 'waiting']);
    expect(thread('r2.b')).toBeUndefined();
    expect(thread('r2.a')?.state).toBe('needs_you');
    expect(startTurns()).toHaveLength(1);
  });

  it('uses the project handover template', async () => {
    dispatch({
      type: 'setting.set',
      key: 'workflows.handoverTemplate',
      scope: 'project:p1',
      value: 'Handover from {{previousStep}}',
    });
    dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'wf1', projectId: 'p1' });
    await runBecomes((current) => current.state === 'waiting');
    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    await runBecomes((current) => current.state === 'done');
    expect(startTurns()[1]?.prompt).toBe('$plan-work Go.\n\nHandover from capture-intent');
  });

  it('fails the run when the provider reports a failed turn', async () => {
    script = (command) =>
      command.type === 'startTurn'
        ? [{ type: 'turnFailed', threadId: command.threadId, error: 'rate limited' }]
        : [];
    dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'wf1', projectId: 'p1' });
    const failed = await runBecomes((current) => current.state === 'failed');
    expect(failed.steps[0]).toMatchObject({ state: 'failed', error: 'rate limited' });
    expect(thread('r1.s1')?.state).toBe('failed');
    expect(notifications.map((entry) => entry.reason)).toEqual(['failed']);
  });

  it('fails a step that has no model instead of sending an empty one', async () => {
    server.database.db
      .update(providerInstances)
      .set({ defaultModel: null })
      .where(eq(providerInstances.id, 'claude-work'))
      .run();
    dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'wf1', projectId: 'p1' });
    const failed = await runBecomes((current) => current.state === 'failed');
    expect(failed.steps[0]?.error).toMatch(/^No model for this step/);
    expect(startTurns()).toEqual([]);
  });

  it('interrupts the running turn on Stop and keeps the thread (behavior 13)', async () => {
    script = () => [];
    dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'wf1', projectId: 'p1' });
    await server.workflows.settled();
    dispatch({ type: 'workflowRun.stop', runId: 'r1' });
    await server.workflows.settled();
    expect(run().state).toBe('stopped');
    expect(adapters[0]?.sent.map((command) => command.type)).toEqual(['startTurn', 'interrupt']);
    expect(thread('r1.s1')?.state).toBe('failed');
  });

  it('rejects runs that cannot start and step changes under a live run', async () => {
    expect(() =>
      dispatch({ type: 'workflowRun.start', runId: 'r9', workflowId: 'missing', projectId: 'p1' }),
    ).toThrow(/No workflow missing/);
    dispatch({
      type: 'workflow.create',
      workflowId: 'wf3',
      name: 'Orphan',
      steps: [step('a', { providerInstanceId: 'gone' })],
    });
    expect(() =>
      dispatch({ type: 'workflowRun.start', runId: 'r9', workflowId: 'wf3', projectId: 'p1' }),
    ).toThrow(/provider instance gone/);

    script = () => [];
    dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'wf1', projectId: 'p1' });
    expect(() =>
      dispatch({ type: 'workflow.update', workflowId: 'wf1', steps: [step('only')] }),
    ).toThrow(/run in progress/);
    expect(() => dispatch({ type: 'workflow.delete', workflowId: 'wf1' })).toThrow(
      /run in progress/,
    );
    expect(() => dispatch({ type: 'workflowRun.continue', runId: 'r1' })).toThrow(
      /not waiting for you/,
    );
    dispatch({ type: 'workflow.update', workflowId: 'wf1', name: 'Renamed' });
    await server.workflows.settled();
  });

  it('finds artifacts again when asked (run view open)', async () => {
    dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'wf1', projectId: 'p1' });
    await runBecomes((current) => current.state === 'waiting');
    await writeFile(path.join(projectDir, 'intents', 'x', 'extra.md'), '');
    await mkdir(path.join(projectDir, 'intents', 'y'), { recursive: true });
    await writeFile(path.join(projectDir, 'intents', 'y', 'spec.md'), '');
    await server.workflows.detectArtifacts('r1');
    expect(run().steps[0]?.artifactsFound).toEqual(['intents/x/spec.md', 'intents/y/spec.md']);
  });
});
