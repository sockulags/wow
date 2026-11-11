import type {
  ServerCommand,
  ProviderCommand,
  ProviderInstance,
  Thread,
  WorkflowRun,
  WorkflowStep,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { invocationsFor } from '@wow/skills';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  notifications as notificationRows,
  providerInstances,
  questions,
  skills,
  threadItems,
  threads,
  turns,
  workflowRuns,
  workflows,
} from '../db/schema.js';
import { MockProviderAdapter, type MockScript } from '../hooks/index.js';
import { startServer, type RunningServer } from '../server.js';
import { changesOptions, readRunDiff } from './changes.js';
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
  version: null,
  statusMessage: null,
  update: null,
  updateRun: null,
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
  server = await launch();
  server.database.db
    .insert(providerInstances)
    .values([instance('claude-work', 'claude', 'opus'), instance('codex-work', 'codex', 'gpt-5')])
    .run();
  dispatch({ type: 'project.create', projectId: 'p1', name: 'wow', cwd: projectDir });
  await server.skills.refresh();
});

// A server on the test's home folder; a second launch after stop() is a restart.
async function launch(): Promise<RunningServer> {
  const started = await startServer({
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
  started.workflows.onNotify((notification) => notifications.push(notification));
  return started;
}

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
    // A finished step's thread can be reopened like any other.
    dispatch({ type: 'thread.setDone', threadId: 'r1.s1', done: false });
    expect(thread('r1.s1')?.state).toBe('idle');
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
    // The gate's thread is where the run waits for the user, so it cannot be put away.
    expect(() => dispatch({ type: 'thread.setDone', threadId: 'r2.a', done: true })).toThrow(
      /waiting for you/,
    );
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

  it('lists the run as running while its step waits for an answer, and the answer resumes the step (questions spec 7)', async () => {
    dispatch({
      type: 'workflow.create',
      workflowId: 'wf-ask',
      name: 'Asking',
      steps: [step('a')],
    });
    script = (command) => {
      if (command.type === 'startTurn') {
        return [
          {
            type: 'questionAsked',
            threadId: command.threadId,
            questionId: 'ask-1:0',
            askId: 'ask-1',
            header: 'Kettle',
            question: 'Which kettle should the tea timer start?',
            options: [{ label: 'Glass kettle' }, { label: 'Steel kettle' }],
            multiSelect: false,
          },
        ];
      }
      if (command.type === 'answerQuestion') {
        return [
          { type: 'textDelta', threadId: 'r9.a', itemId: 'r9.a-b', delta: 'Glass it is.' },
          { type: 'turnCompleted', threadId: 'r9.a' },
        ];
      }
      return [];
    };
    const asked = new Promise<void>((resolve) => {
      const check = () => {
        if (thread('r9.a')?.state !== 'needs_you') return;
        off();
        resolve();
      };
      const off = server.engine.onCommit(check);
    });
    dispatch({ type: 'workflowRun.start', runId: 'r9', workflowId: 'wf-ask', projectId: 'p1' });
    await asked;
    // Where runs are listed the run is running, as with any step that waits for its thread; the
    // step's thread is listed as needing you.
    expect(run('r9')).toMatchObject({ state: 'running' });
    expect(run('r9').steps[0]).toMatchObject({ state: 'running', threadId: 'r9.a' });
    const [question] = server.database.db
      .select()
      .from(questions)
      .where(eq(questions.threadId, 'r9.a'))
      .all();
    if (!question) throw new Error('no question');

    dispatch({
      type: 'question.answer',
      answers: [
        { questionId: question.id, reply: { picked: ['Glass kettle'], text: 'the clean one' } },
      ],
    });
    expect(thread('r9.a')?.state).toBe('working');
    const done = await runBecomes((current) => current.state === 'done', 'r9');
    expect(done.steps[0]).toMatchObject({ state: 'done', finalMessage: 'Glass it is.' });
    expect(
      adapters
        .flatMap((adapter) => adapter.sent)
        .find((command) => command.type === 'answerQuestion'),
    ).toEqual({
      type: 'answerQuestion',
      questionId: 'ask-1:0',
      answer: { picked: ['Glass kettle'], text: 'the clean one' },
    });
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

  it('restores a deleted workflow as it was (Undo)', () => {
    const before = server.database.db.select().from(workflows).where(eq(workflows.id, 'wf1')).get();
    if (!before) throw new Error('no workflow');
    dispatch({ type: 'workflow.delete', workflowId: 'wf1' });
    dispatch({ type: 'workflow.restore', workflow: before });
    expect(
      server.database.db.select().from(workflows).where(eq(workflows.id, 'wf1')).get(),
    ).toEqual(before);
    expect(() => dispatch({ type: 'workflow.restore', workflow: before })).toThrow(
      /already exists/,
    );
  });

  it('sends the step prompt as the first turn of the step thread', async () => {
    dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'wf1', projectId: 'p1' });
    await runBecomes((current) => current.state === 'waiting');
    const rows = server.database.db.select().from(turns).where(eq(turns.threadId, 'r1.s1')).all();
    expect(rows.map((row) => row.state)).toEqual(['completed']);
    const first = server.database.db
      .select()
      .from(threadItems)
      .where(eq(threadItems.threadId, 'r1.s1'))
      .orderBy(threadItems.index)
      .get();
    expect(first).toMatchObject({ kind: 'user', payload: { text: startTurns()[0]?.prompt } });

    // A message the user sends at the gate is not the step's outcome.
    const ended = new Promise<void>((resolve) => {
      const off = server.engine.onCommit((commit) => {
        if (commit.events.some(({ event }) => event.kind === 'turn.ended')) {
          off();
          resolve();
        }
      });
    });
    dispatch({ type: 'thread.sendMessage', threadId: 'r1.s1', text: 'one more thing' });
    await ended;
    await server.workflows.settled();
    expect(run()).toMatchObject({ state: 'waiting', currentStep: 0 });
  });

  it('invokes a Claude plugin skill named plugin:name and matches skills by name', async () => {
    dispatch({
      type: 'skills.sync',
      skills: [
        {
          id: '/plugins/agent-os-dev/skills/deliver-work',
          name: 'deliver-work',
          description: '',
          dir: '/plugins/agent-os-dev/skills/deliver-work',
          source: 'user-claude',
          manualOnly: false,
          invocations: invocationsFor('deliver-work', 'agent-os-dev'),
        },
      ],
    });
    dispatch({
      type: 'workflow.create',
      workflowId: 'wf4',
      name: 'Plugin',
      steps: [
        step('a', { skillName: 'agent-os-dev:deliver-work' }),
        step('b', { skillName: 'deliver-work' }),
        step('c', { skillName: 'deliver-work', providerInstanceId: 'codex-work' }),
      ],
    });
    dispatch({ type: 'workflowRun.start', runId: 'r4', workflowId: 'wf4', projectId: 'p1' });
    await runBecomes((current) => current.state === 'done', 'r4');
    expect(startTurns().map((command) => command.prompt.split('\n')[0])).toEqual([
      '/agent-os-dev:deliver-work',
      '/agent-os-dev:deliver-work',
      '$deliver-work',
    ]);
  });

  it('fails a step whose turn was running when the server stopped', async () => {
    script = () => [];
    dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'wf1', projectId: 'p1' });
    await server.workflows.settled();
    expect(run().steps[0]?.state).toBe('running');
    await server.stop();

    server = await launch();
    await server.workflows.settled();
    expect(run()).toMatchObject({ state: 'failed' });
    expect(run().steps[0]).toMatchObject({
      state: 'failed',
      error: 'The server stopped while this turn was running',
    });
  });

  it('fails a step whose turn never started when the server stopped', async () => {
    script = () => [];
    dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'wf1', projectId: 'p1' });
    await server.workflows.settled();
    // As if the server stopped between storing the run and sending the step's prompt.
    server.database.db.delete(turns).where(eq(turns.threadId, 'r1.s1')).run();
    await server.stop();

    server = await launch();
    await server.workflows.settled();
    expect(run().steps[0]).toMatchObject({
      state: 'failed',
      error: 'The server stopped before this step started',
    });
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

// The mock agent: each step writes the file its prompt names, then ends its turn.
const editing: MockScript = (command) => {
  if (command.type === 'startTurn') {
    const file = /write (\S+)/.exec(command.prompt)?.[1];
    if (file) writeFileSync(path.join(command.cwd, file), `written by ${command.threadId}\n`);
  }
  return echo(command);
};

// Review loop spec 10 and 11: the run's base commit, and what each step changed.
const waitingRun = async (workflowId = 'wf1', runId = 'r1') => {
  dispatch({ type: 'workflowRun.start', runId, workflowId, projectId: 'p1' });
  return runBecomes((current) => current.state === 'waiting', runId);
};

// The run waiting again after the given attempt of a step ended.
const waitsAfterAttempt = (attempt: number, stepIndex = 0, runId = 'r1') =>
  runBecomes(
    (current) => current.state === 'waiting' && current.steps[stepIndex]?.attempt === attempt,
    runId,
  );

const turnsOf = (threadId: string) =>
  server.database.db.select().from(turns).where(eq(turns.threadId, threadId)).all();

const storedNotifications = () =>
  server.database.db
    .select()
    .from(notificationRows)
    .all()
    .map((row) => row.id)
    .toSorted();

const turnEnds = () =>
  new Promise<void>((resolve) => {
    const off = server.engine.onCommit((commit) => {
      if (commit.events.some(({ event }) => event.kind === 'turn.ended')) {
        off();
        resolve();
      }
    });
  });

describe('send back at a gate (review loop spec 16 to 20)', () => {
  const NOTE = 'Name the kettle in the summary.';
  const SENT = 'The reviewer looked at the result of this step and sent it back.';

  beforeEach(() => {
    dispatch({
      type: 'workflow.create',
      workflowId: 'wf1',
      name: 'Feature',
      steps: [
        step('s1', {
          skillName: 'capture-intent',
          gateAfter: true,
          expectedArtifacts: ['intents/*/spec.md'],
        }),
        step('s2', { skillName: 'plan-work' }),
      ],
    });
  });

  it('runs the step again in the same thread as attempt 2 and waits again with the new result (spec 16)', async () => {
    const first = await waitingRun();
    expect(first.steps[0]).toMatchObject({
      finalMessage: 'Done: /capture-intent',
      artifactsFound: ['intents/x/spec.md'],
    });
    expect(first.steps[0]?.attempt).toBeUndefined();

    dispatch({ type: 'workflowRun.sendBack', runId: 'r1', note: NOTE });
    expect(run()).toMatchObject({ state: 'running', currentStep: 0 });
    expect(run().steps[0]).toMatchObject({ state: 'running', attempt: 2, threadId: 'r1.s1' });
    expect(thread('r1.s1')?.state).toBe('working');

    const again = await waitsAfterAttempt(2);
    expect(again.steps.map((entry) => entry.state)).toEqual(['waiting', 'not_started']);
    expect(again.steps[0]).toMatchObject({
      attempt: 2,
      threadId: 'r1.s1',
      finalMessage: `Done: ${SENT}`,
    });
    expect(again.steps[0]?.endedAt).toBeDefined();
    expect(thread('r1.s1')?.state).toBe('needs_you');
    // One thread, two turns: the rerun did not create the thread again.
    expect(server.database.db.select().from(threads).all()).toHaveLength(1);
    expect(turnsOf('r1.s1').map((turn) => [turn.index, turn.state])).toEqual([
      [0, 'completed'],
      [1, 'completed'],
    ]);
    expect(startTurns()).toHaveLength(2);
    expect(startTurns()[1]).toMatchObject({
      threadId: 'r1.s1',
      model: 'opus',
      prompt: [
        SENT,
        '',
        "Reviewer's note:",
        '',
        NOTE,
        '',
        'Do the step (capture-intent) again in this conversation with the note taken into account, and end with your result as before.',
      ].join('\n'),
    });
    expect(notifications.filter((entry) => entry.reason === 'waiting')).toHaveLength(2);

    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    const done = await runBecomes((current) => current.state === 'done');
    expect(done.steps[0]).toMatchObject({ state: 'done', attempt: 2 });
    expect(startTurns()[2]?.prompt).toContain(`Done: ${SENT}`);
  });

  it('finds the artifacts of the new attempt', async () => {
    await waitingRun();
    script = (command) => {
      if (command.type === 'startTurn') {
        mkdirSync(path.join(projectDir, 'intents', 'y'), { recursive: true });
        writeFileSync(path.join(projectDir, 'intents', 'y', 'spec.md'), '# Second spec\n');
      }
      return echo(command);
    };
    dispatch({ type: 'workflowRun.sendBack', runId: 'r1', note: NOTE });
    const again = await waitsAfterAttempt(2);
    expect(again.steps[0]?.artifactsFound).toEqual(['intents/x/spec.md', 'intents/y/spec.md']);
  });

  it('sends back twice on one step and stores a notification for each wait (spec 16, 19)', async () => {
    await waitingRun();
    expect(storedNotifications()).toEqual(['r1:waiting:s1:after']);
    dispatch({ type: 'workflowRun.sendBack', runId: 'r1', note: NOTE });
    await waitsAfterAttempt(2);
    expect(storedNotifications()).toEqual(['r1:waiting:s1:after', 'r1:waiting:s1:after:attempt-2']);
    dispatch({ type: 'workflowRun.sendBack', runId: 'r1', note: 'And the cup.' });
    const third = await waitsAfterAttempt(3);
    expect(third.steps[0]).toMatchObject({ state: 'waiting', attempt: 3, threadId: 'r1.s1' });
    expect(storedNotifications()).toEqual([
      'r1:waiting:s1:after',
      'r1:waiting:s1:after:attempt-2',
      'r1:waiting:s1:after:attempt-3',
    ]);
    expect(turnsOf('r1.s1')).toHaveLength(3);
    expect(startTurns()[2]?.prompt).toContain('And the cup.');
    expect(server.database.db.select().from(threads).all()).toHaveLength(1);
  });

  it('uses the project send back template', async () => {
    dispatch({
      type: 'setting.set',
      key: 'workflows.sendBackTemplate',
      scope: 'project:p1',
      value: 'Again ({{attempt}}), {{skill}}: {{note}}',
    });
    await waitingRun();
    dispatch({ type: 'workflowRun.sendBack', runId: 'r1', note: NOTE });
    await waitsAfterAttempt(2);
    expect(startTurns()[1]?.prompt).toBe(`Again (2), capture-intent: ${NOTE}`);
  });

  it('runs the previous step again when the run waits before a step (spec 17)', async () => {
    dispatch({
      type: 'workflow.create',
      workflowId: 'wf2',
      name: 'Gated',
      steps: [step('a'), step('b', { gateBefore: true })],
    });
    await waitingRun('wf2', 'r2');
    dispatch({ type: 'workflowRun.sendBack', runId: 'r2', note: NOTE });
    expect(run('r2')).toMatchObject({ state: 'running', currentStep: 0 });
    expect(run('r2').steps.map((entry) => entry.state)).toEqual(['running', 'not_started']);
    const again = await waitsAfterAttempt(2, 0, 'r2');
    expect(again.currentStep).toBe(1);
    expect(again.steps.map((entry) => entry.state)).toEqual(['done', 'waiting']);
    expect(again.steps[0]).toMatchObject({ attempt: 2, finalMessage: `Done: ${SENT}` });
    expect(thread('r2.b')).toBeUndefined();
    expect(thread('r2.a')?.state).toBe('needs_you');
    expect(startTurns().map((turn) => turn.threadId)).toEqual(['r2.a', 'r2.a']);
    expect(storedNotifications()).toEqual(['r2:waiting:b:before', 'r2:waiting:b:before:attempt-2']);
  });

  it('refuses an empty note and runs nothing (spec 18)', async () => {
    const before = await waitingRun();
    for (const note of ['', '   \n']) {
      expect(() => dispatch({ type: 'workflowRun.sendBack', runId: 'r1', note })).toThrow(
        /Write what should change/,
      );
    }
    await server.workflows.settled();
    expect(run()).toEqual(before);
    expect(startTurns()).toHaveLength(1);
    expect(turnsOf('r1.s1')).toHaveLength(1);
  });

  it('leaves the run waiting and the result unchanged for an ordinary message at the gate (spec 20)', async () => {
    const before = await waitingRun();
    const ended = turnEnds();
    dispatch({ type: 'thread.sendMessage', threadId: 'r1.s1', text: 'Why a kettle?' });
    await ended;
    await server.workflows.settled();
    expect(run()).toEqual(before);
    expect(run().steps[0]).toMatchObject({
      state: 'waiting',
      finalMessage: 'Done: /capture-intent',
      artifactsFound: ['intents/x/spec.md'],
    });
    expect(run().steps[0]?.attempt).toBeUndefined();
    expect(storedNotifications()).toEqual(['r1:waiting:s1:after']);

    // The side conversation does not get in the way of a send back afterwards.
    dispatch({ type: 'workflowRun.sendBack', runId: 'r1', note: NOTE });
    const again = await waitsAfterAttempt(2);
    expect(again.steps[0]?.finalMessage).toBe(`Done: ${SENT}`);
    expect(turnsOf('r1.s1')).toHaveLength(3);
  });

  it('refuses while a message typed at the gate is still being answered', async () => {
    const before = await waitingRun();
    script = () => [];
    dispatch({ type: 'thread.sendMessage', threadId: 'r1.s1', text: 'Why a kettle?' });
    expect(() => dispatch({ type: 'workflowRun.sendBack', runId: 'r1', note: NOTE })).toThrow(
      /still answering a message/,
    );
    expect(run()).toEqual(before);
    expect(turnsOf('r1.s1')).toHaveLength(2);
  });

  it('refuses a run that is not waiting, with the reason', async () => {
    script = () => [];
    dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'wf1', projectId: 'p1' });
    await server.workflows.settled();
    expect(() => dispatch({ type: 'workflowRun.sendBack', runId: 'r1', note: NOTE })).toThrow(
      'Run r1 is running, not waiting for you, so there is nothing to send back',
    );
    dispatch({ type: 'workflowRun.stop', runId: 'r1' });
    await server.workflows.settled();
    expect(() => dispatch({ type: 'workflowRun.sendBack', runId: 'r1', note: NOTE })).toThrow(
      'Run r1 is stopped, not waiting for you, so there is nothing to send back',
    );
    expect(() => dispatch({ type: 'workflowRun.sendBack', runId: 'nope', note: NOTE })).toThrow(
      /No run nope/,
    );
    expect(startTurns()).toHaveLength(1);
  });

  it('fails the run when the turn of a sent back step fails', async () => {
    await waitingRun();
    script = (command) =>
      command.type === 'startTurn'
        ? [{ type: 'turnFailed', threadId: command.threadId, error: 'out of tea' }]
        : [];
    dispatch({ type: 'workflowRun.sendBack', runId: 'r1', note: NOTE });
    const failed = await runBecomes((current) => current.state === 'failed');
    expect(failed.steps[0]).toMatchObject({ state: 'failed', attempt: 2 });
  });

  it('approves with Continue as before (spec 15)', async () => {
    await waitingRun();
    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    const done = await runBecomes((current) => current.state === 'done');
    expect(done.steps.map((entry) => entry.state)).toEqual(['done', 'done']);
    expect(done.steps[0]?.attempt).toBeUndefined();
  });
});

describe('run base and changes', () => {
  let repo: string;
  const ceiling = process.env['GIT_CEILING_DIRECTORIES'];
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
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

  const changes = (runId = 'r1') =>
    readRunDiff({ folder: repo, run: run(runId), options: changesOptions(server.settings) });

  beforeEach(async () => {
    // The temporary folder must never be read as part of a repository around it.
    process.env['GIT_CEILING_DIRECTORIES'] = root;
    repo = path.join(root, 'repo');
    await mkdir(repo);
    git('init', '-q', '-b', 'main');
    await writeFile(path.join(repo, 'readme.md'), '# Invented\n');
    await writeFile(path.join(repo, 'plan.md'), 'Nothing yet\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'Invented start');
    dispatch({ type: 'project.create', projectId: 'git', name: 'repo', cwd: repo });
    dispatch({
      type: 'workflow.create',
      workflowId: 'edits',
      name: 'Edits',
      steps: [
        step('one', { extraPrompt: 'write plan.md', gateAfter: true }),
        step('two', { extraPrompt: 'write notes.md', gateAfter: true }),
      ],
    });
    script = editing;
  });

  afterEach(() => {
    if (ceiling === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
    else process.env['GIT_CEILING_DIRECTORIES'] = ceiling;
  });

  it('stores the commit the folder was on when the first step began (spec 10)', async () => {
    const head = git('rev-parse', 'HEAD');
    dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'edits', projectId: 'git' });
    const waiting = await runBecomes((current) => current.state === 'waiting');
    expect(waiting.baseSha).toBe(head);
    // Nothing differed before the step; the step's own edit is in its hashes, not in the base's.
    expect(waiting.baseFiles).toEqual([]);
    expect(waiting.steps[0]?.fileHashes?.map((entry) => entry.path)).toEqual(['plan.md']);

    // A commit made during the run moves the folder, not the base.
    git('commit', '-q', '-am', 'Invented commit by the agent');
    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    const again = await runBecomes(
      (current) => current.state === 'waiting' && current.currentStep === 1,
    );
    expect(again.baseSha).toBe(head);
  });

  it('records the base when a gate before the first step is passed, not earlier', async () => {
    dispatch({
      type: 'workflow.create',
      workflowId: 'gated',
      name: 'Gated',
      steps: [step('only', { gateBefore: true })],
    });
    dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'gated', projectId: 'git' });
    await server.workflows.settled();
    expect(run().baseSha).toBeNull();
    await writeFile(path.join(repo, 'readme.md'), '# Committed while waiting\n');
    git('commit', '-q', '-am', 'Invented commit before the step');
    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    const done = await runBecomes((current) => current.state === 'done');
    expect(done.baseSha).toBe(git('rev-parse', 'HEAD'));
  });

  it('marks only the files of the step that waits (spec 11)', async () => {
    dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'edits', projectId: 'git' });
    await runBecomes((current) => current.state === 'waiting');
    expect((await changes()).files.map((file) => [file.path, file.changedBy])).toEqual([
      ['plan.md', ['one']],
    ]);
    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    await runBecomes((current) => current.state === 'waiting' && current.currentStep === 1);
    expect((await changes()).files.map((file) => [file.path, file.status, file.changedBy])).toEqual(
      [
        ['notes.md', 'added', ['two']],
        ['plan.md', 'modified', ['one']],
      ],
    );
  });

  it('starts no turn for a run stopped while its base was being read', async () => {
    dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'edits', projectId: 'git' });
    // Stop arrives before the runner has read the folder's commit.
    dispatch({ type: 'workflowRun.stop', runId: 'r1' });
    await server.workflows.settled();
    expect(run().state).toBe('stopped');
    expect(startTurns()).toEqual([]);
    expect(
      server.database.db.select().from(turns).where(eq(turns.threadId, 'r1.one')).all(),
    ).toEqual([]);
  });

  it('runs without a base in a folder that is not a repository (spec 13)', async () => {
    dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'edits', projectId: 'p1' });
    const waiting = await runBecomes((current) => current.state === 'waiting');
    expect(waiting.baseSha).toBeNull();
    expect(waiting.steps[0]?.fileHashes).toBeUndefined();
    expect(
      await readRunDiff({
        folder: projectDir,
        run: waiting,
        options: changesOptions(server.settings),
      }),
    ).toMatchObject({ status: 'noRepository' });
    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    await runBecomes((current) => current.state === 'waiting' && current.currentStep === 1);
  });
});
