import {
  type AppNotification,
  type ProviderInstance,
  type ServerCommand,
  type WorkflowRun,
  type WorkflowStep,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandRejected } from '../core/orchestrator.js';
import { notifications, providerInstances, workflowRuns } from '../db/schema.js';
import { MockProviderAdapter } from '../hooks/index.js';
import { MockGitHub, type MockCheckRun, type MockPullRequest } from '../hosts/mock-github.js';
import { startServer, type RunningServer } from '../server.js';

// Review loop spec 54 to 57 on the server: a gate whose condition passes or holds the run,
// against an invented GitHub Enterprise host and a temporary repository. Nothing sleeps: the
// test moves the clock and asks for a poll or runs the poller's timer itself.

const api = 'https://ghe.example.invalid/api/v3';
const TOKEN = 'ghp-invented-token-for-tests';
const bellBranch = 'agent/U2-bell';

let root: string;
let project: string;
let server: RunningServer;
let host: MockGitHub;
let now: Date;
// What the invented agent answers, by the skill its prompt starts with.
let answers: Record<string, string>;
let prompts: string[];
let timers: { callback: () => void; delayMs: number }[];
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

const instance: ProviderInstance = {
  id: 'claude-work',
  kind: 'claude',
  name: 'Work',
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
  providerInstanceId: instance.id,
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
  ...overrides,
});

let commandCount = 0;
const dispatch = (command: ServerCommand) =>
  server.engine.dispatch(`test-${(commandCount += 1)}`, command);
const set = (key: string, value: unknown, scope = 'global') =>
  dispatch({ type: 'setting.set', key, scope, value });

const db = () => server.database.db;
const run = (id = 'r1') =>
  db()
    .select()
    .from(workflowRuns)
    .all()
    .find((row) => row.id === id) as WorkflowRun;
const gate = (id = 'r1') => run(id).steps[0]?.gate;
const notices = (): AppNotification[] => db().select().from(notifications).all();
const waitingNotices = () => notices().filter((notice) => notice.kind === 'waiting');

const checks = (...runs: MockCheckRun[]): MockPullRequest => ({
  number: 14,
  title: 'Ring the bell at zero',
  body: 'Invented for the tests.',
  state: 'open',
  branch: bellBranch,
  sha: 'b2b2b2b',
  checkRuns: runs,
});
const passed = (name: string): MockCheckRun => ({
  name,
  status: 'completed',
  conclusion: 'success',
});
const failed = (name: string): MockCheckRun => ({
  name,
  status: 'completed',
  conclusion: 'failure',
});
const going = (name: string): MockCheckRun => ({ name, status: 'in_progress', conclusion: null });

// Resolves on the commit after which the run is not running a step.
function rests(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (run().state === 'running') return;
      unsubscribe();
      resolve();
    };
    const unsubscribe = server.engine.onCommit(check);
    check();
  });
}

// The run has come to rest: it waits or has ended, and the host read that its last change set
// going has been stored without starting a step again.
async function settle(): Promise<void> {
  do {
    await rests();
    await server.hosts.idle();
    await server.workflows.settled();
  } while (run().state === 'running');
}

const minutes = (count: number) => {
  now = new Date(now.getTime() + count * 60_000);
};

// The clock moves one poll interval on and the hosts are asked, as the poller's timer does.
async function poll(): Promise<void> {
  now = new Date(now.getTime() + server.settings.get('hosts.pollSeconds') * 1000);
  await server.hosts.poll();
  await settle();
}

// A review step with a gate after it and the condition, then a step that wraps up.
function createWorkflow(overrides: Partial<WorkflowStep>): void {
  dispatch({
    type: 'workflow.create',
    workflowId: 'review',
    name: 'Review and wrap',
    steps: [step('check-work', { gateAfter: true, ...overrides }), step('wrap')],
  });
}

async function start(): Promise<void> {
  dispatch({ type: 'workflowRun.start', runId: 'r1', workflowId: 'review', projectId: 'tea' });
  await settle();
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'wow gates ')));
  process.env['GIT_CEILING_DIRECTORIES'] = root;
  const remote = path.join(root, 'the remote.git');
  project = path.join(root, 'tea timer');
  const seed = path.join(root, 'seed');
  await mkdir(seed);
  git(seed, 'init', '-q', '-b', 'main');
  await writeFile(path.join(seed, 'readme.md'), '# Invented tea timer\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'Invented start');
  git(seed, 'checkout', '-q', '-b', bellBranch);
  await writeFile(path.join(seed, 'bell.md'), 'Ring\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'Invented bell');
  git(root, 'clone', '-q', '--bare', seed, remote);
  // The project folder is on the pull request's branch, so the run's pull request is #14.
  git(root, 'clone', '-q', '-c', 'core.autocrlf=false', '-b', bellBranch, remote, project);

  now = new Date('2026-11-03T09:00:00.000Z');
  answers = { 'check-work': 'Looked at the bell.\n\nAPPROVED', wrap: 'Wrapped up.' };
  prompts = [];
  timers = [];
  host = new MockGitHub({ owner: 'acme', repo: 'tea', webUrl: 'https://ghe.example.invalid' });
  host.token = TOKEN;
  host.pulls = [checks(passed('test'))];
  server = await startServer({
    home: path.join(root, 'wow home'),
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: path.join(root, 'user'),
    watchSkills: () => ({ close: () => Promise.resolve() }),
    watchPlans: () => ({ close: () => Promise.resolve() }),
    clock: () => now,
    schedulerTimers: { setTimeout: () => undefined, clearTimeout: () => undefined },
    hostTimers: {
      setTimeout: (callback, delayMs) => timers.push({ callback, delayMs }),
      clearTimeout: () => undefined,
    },
    fetch: host.fetch(api),
    hooks: {
      providers: {
        claude: (row) =>
          new MockProviderAdapter(row.kind, (command) => {
            if (command.type !== 'startTurn') return [];
            const { threadId, prompt } = command;
            prompts.push(prompt);
            const skill = Object.keys(answers).find((name) => prompt.startsWith(`/${name}`));
            return [
              {
                type: 'textDelta',
                threadId,
                itemId: `${threadId}-a${prompts.length}`,
                delta: answers[skill ?? ''] ?? 'Done',
              },
              { type: 'turnCompleted', threadId },
            ];
          }),
      },
    },
  });
  db().insert(providerInstances).values(instance).run();
  dispatch({ type: 'project.create', projectId: 'tea', name: 'Tea timer', cwd: project });
  set('trackers.github.baseUrl', api);
  set('trackers.github.owner', 'acme');
  set('trackers.github.repo', 'tea');
  set('trackers.github.token', await server.secrets.set('setting:trackers.github.token', TOKEN));
});

afterEach(async () => {
  await server.stop();
  if (ceiling === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
  else process.env['GIT_CEILING_DIRECTORIES'] = ceiling;
  await rm(root, { recursive: true, force: true });
});

describe('the verdict part through the runner (spec 54, 55)', () => {
  it('passes by itself on a final message ending in APPROVED, starts the next step and tells nobody', async () => {
    createWorkflow({ gateAfterCondition: ['verdict'] });
    await start();
    expect(run().state).toBe('done');
    expect(run().steps.map((entry) => entry.state)).toEqual(['done', 'done']);
    expect(gate()).toMatchObject({
      state: 'passedByItself',
      parts: [{ part: 'verdict', state: 'held', detail: 'The final message ends with APPROVED' }],
    });
    expect(prompts.map((prompt) => prompt.split(/\s/)[0])).toEqual(['/check-work', '/wrap']);
    expect(waitingNotices()).toEqual([]);
  });

  it('waits for the user and names the verdict on CHANGES_REQUESTED', async () => {
    answers['check-work'] = 'The bell rings twice.\n\nCHANGES_REQUESTED';
    createWorkflow({ gateAfterCondition: ['verdict'] });
    await start();
    expect(run().state).toBe('waiting');
    expect(gate()).toMatchObject({
      state: 'waitingForUser',
      parts: [{ part: 'verdict', state: 'failed' }],
    });
    expect(waitingNotices()).toHaveLength(1);
    // Approve passes it as at any gate, and the step says who passed it.
    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    await settle();
    expect(run().state).toBe('done');
    expect(gate()?.state).toBe('passedByUser');
  });

  it('reads the approved line of the project', async () => {
    answers['check-work'] = 'Fine.\nLGTM';
    set('workflows.verdictApprovedLine', 'LGTM', 'project:tea');
    createWorkflow({ gateAfterCondition: ['verdict'] });
    await start();
    expect(gate()?.state).toBe('passedByItself');
  });
});

describe('the artifacts part through the runner (spec 54, 55)', () => {
  const expecting = {
    gateAfterCondition: ['artifacts' as const],
    expectedArtifacts: ['docs/*.md', 'readme.md'],
  };

  it('waits and names the glob that found nothing', async () => {
    createWorkflow(expecting);
    await start();
    expect(run().state).toBe('waiting');
    expect(gate()).toMatchObject({
      state: 'waitingForUser',
      parts: [{ part: 'artifacts', state: 'failed', detail: 'Nothing found for docs/*.md' }],
    });
  });

  it('passes when every glob found a file', async () => {
    await mkdir(path.join(project, 'docs'));
    await writeFile(path.join(project, 'docs', 'bell.md'), '# Invented notes\n');
    createWorkflow(expecting);
    await start();
    expect(run().state).toBe('done');
    expect(gate()).toMatchObject({
      state: 'passedByItself',
      parts: [{ part: 'artifacts', state: 'held' }],
    });
  });
});

describe('the checks part (spec 54 to 56)', () => {
  it('passes when the read made as the step ends shows every check successful, even with polling off', async () => {
    set('hosts.polling', false);
    host.pulls = [checks(passed('test'), passed('lint'))];
    createWorkflow({ gateAfterCondition: ['checks'] });
    await start();
    expect(run().state).toBe('done');
    expect(gate()).toMatchObject({
      state: 'passedByItself',
      parts: [
        {
          part: 'checks',
          state: 'held',
          detail: 'Every check of pull request #14 is successful (test, lint)',
        },
      ],
    });
    expect(waitingNotices()).toEqual([]);
  });

  it('waits for the user and names the failing check', async () => {
    host.pulls = [checks(passed('lint'), failed('test'))];
    createWorkflow({ gateAfterCondition: ['checks'] });
    await start();
    expect(run().state).toBe('waiting');
    expect(gate()).toMatchObject({
      state: 'waitingForUser',
      parts: [
        { part: 'checks', state: 'failed', detail: 'Pull request #14 has failing checks: test' },
      ],
    });
    expect(waitingNotices()).toHaveLength(1);
  });

  it('waits for checks while they run and passes when a poll shows success', async () => {
    host.pulls = [checks(passed('lint'), going('test'))];
    createWorkflow({ gateAfterCondition: ['verdict', 'checks'] });
    await start();
    expect(run().state).toBe('waiting');
    expect(gate()).toMatchObject({
      state: 'waitingForChecks',
      parts: [
        { part: 'verdict', state: 'held' },
        {
          part: 'checks',
          state: 'pending',
          detail: 'Checks of pull request #14 are still running: test',
        },
      ],
    });
    // Nobody is asked while the run waits for the host.
    expect(waitingNotices()).toEqual([]);
    expect(prompts).toHaveLength(1);

    await poll();
    expect(gate()?.state).toBe('waitingForChecks');

    host.pulls = [checks(passed('lint'), passed('test'))];
    await poll();
    expect(run().state).toBe('done');
    expect(gate()).toMatchObject({
      state: 'passedByItself',
      parts: [
        { part: 'verdict', state: 'held' },
        { part: 'checks', state: 'held' },
      ],
    });
    expect(prompts.map((prompt) => prompt.split(/\s/)[0])).toEqual(['/check-work', '/wrap']);
    expect(waitingNotices()).toEqual([]);
  });

  it('does not take checks read before the step ended as its answer', async () => {
    // The step waits before it starts, so the run is read while the checks are still green.
    createWorkflow({ gateBefore: true, gateAfterCondition: ['checks'] });
    await start();
    await poll();
    host.failure = { status: 503, message: 'Invented outage' };
    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    await settle();
    expect(run().state).toBe('waiting');
    expect(gate()).toMatchObject({
      state: 'waitingForChecks',
      parts: [{ part: 'checks', state: 'pending' }],
    });
    host.failure = undefined;
    await poll();
    expect(gate()?.state).toBe('passedByItself');
  });

  it('waits for the user once workflows.gateChecksTimeoutMinutes has passed, on the timer', async () => {
    host.pulls = [checks(going('test'))];
    createWorkflow({ gateAfterCondition: ['checks'] });
    await start();
    expect(gate()?.state).toBe('waitingForChecks');
    // The poller set its timer to the end of the wait: 30 minutes after the step ended.
    const timer = timers.findLast((entry) => entry.delayMs === 30 * 60_000);
    expect(timer).toBeDefined();

    minutes(29);
    server.hosts.checkGates();
    expect(gate()?.state).toBe('waitingForChecks');
    expect(waitingNotices()).toEqual([]);

    minutes(1);
    timer?.callback();
    await settle();
    expect(run().state).toBe('waiting');
    expect(gate()).toMatchObject({
      state: 'waitingForUser',
      parts: [
        {
          part: 'checks',
          state: 'failed',
          detail:
            'Checks were not successful within 30 minutes. Checks of pull request #14 are still running: test',
        },
      ],
    });
    expect(waitingNotices()).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    // The user answers it from here: a later green poll does not pass it behind their back.
    host.pulls = [checks(passed('test'))];
    await poll();
    expect(gate()?.state).toBe('waitingForUser');
  });

  it("uses the project's own wait, and a poll after it also ends the wait", async () => {
    set('workflows.gateChecksTimeoutMinutes', 2, 'project:tea');
    host.pulls = [checks(going('test'))];
    createWorkflow({ gateAfterCondition: ['checks'] });
    await start();
    expect(timers.at(-1)?.delayMs).toBe(2 * 60_000);
    minutes(2);
    await poll();
    expect(gate()).toMatchObject({
      state: 'waitingForUser',
      parts: [{ part: 'checks', state: 'failed' }],
    });
  });

  it('waits for the user at once when the host is not set up', async () => {
    dispatch({ type: 'setting.reset', key: 'trackers.github.token', scope: 'global' });
    createWorkflow({ gateAfterCondition: ['checks'] });
    await start();
    expect(gate()).toMatchObject({
      state: 'waitingForUser',
      parts: [{ part: 'checks', state: 'failed' }],
    });
    expect(gate()?.parts[0]?.detail).toContain('is not set up for this project');
  });

  it('never merges: the host was only read', async () => {
    createWorkflow({ gateAfterCondition: ['checks'] });
    await start();
    expect(gate()?.state).toBe('passedByItself');
    expect(host.requests.every((request) => request.method === 'GET')).toBe(true);
  });
});

const create = (skillName: string, more: Partial<WorkflowStep> = {}) =>
  dispatch({
    type: 'workflow.create',
    workflowId: `wf-${skillName}`,
    name: skillName,
    steps: [
      step('first', { skillName, gateAfter: true, gateAfterCondition: ['verdict'], ...more }),
    ],
  });
const refused = (act: () => unknown): string => {
  try {
    act();
  } catch (error) {
    if (error instanceof CommandRejected) return error.message;
    throw error;
  }
  return '';
};

describe('skills that always stop (spec 57)', () => {
  it.each(['capture-intent', 'plan-work', 'design-work', 'shape-work', 'agent-os-core:plan-work'])(
    'refuses workflow.create with a condition on %s',
    (skillName) => {
      expect(refused(() => create(skillName))).toBe(
        `The gate after ${skillName} always waits for you: skills that plan or specify cannot get a condition (workflows.alwaysStopSkills)`,
      );
    },
  );

  it('refuses workflow.update and workflow.restore with one', () => {
    dispatch({
      type: 'workflow.create',
      workflowId: 'plan',
      name: 'Plan',
      steps: [step('plan-work', { gateAfter: true })],
    });
    const steps = [step('plan-work', { gateAfter: true, gateAfterCondition: ['checks' as const] })];
    expect(refused(() => dispatch({ type: 'workflow.update', workflowId: 'plan', steps }))).toMatch(
      /always waits for you/,
    );
    expect(
      refused(() =>
        dispatch({
          type: 'workflow.restore',
          workflow: {
            id: 'plan-2',
            name: 'Plan again',
            templateKind: null,
            steps,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
        }),
      ),
    ).toMatch(/always waits for you/);
  });

  it('still refuses the four defaults when they are removed from the setting, and the run still stops', async () => {
    set('workflows.alwaysStopSkills', []);
    expect(refused(() => create('plan-work'))).toMatch(/always waits for you/);
    // A project cannot take one away either: the engine applies the defaults when the step ends.
    set('workflows.alwaysStopSkills', [], 'project:tea');
    answers['plan-work'] = 'The plan.\n\nAPPROVED';
    dispatch({
      type: 'workflow.create',
      workflowId: 'review',
      name: 'Plan',
      steps: [step('plan-work', { gateAfter: true }), step('wrap')],
    });
    await start();
    expect(run().state).toBe('waiting');
    expect(gate()).toBeUndefined();
    expect(waitingNotices()).toHaveLength(1);
  });

  it('refuses a skill the setting adds and takes other skills', () => {
    set('workflows.alwaysStopSkills', ['write-spec']);
    expect(refused(() => create('write-spec'))).toMatch(/always waits for you/);
    expect(refused(() => create('check-work'))).toBe('');
  });

  it('refuses a condition on a step without a gate after it', () => {
    expect(refused(() => create('check-work', { gateAfter: false }))).toMatch(
      /has a condition but no gate after it/,
    );
  });

  it('a gate without a condition waits as before', async () => {
    createWorkflow({});
    await start();
    expect(run().state).toBe('waiting');
    expect(gate()).toBeUndefined();
  });
});
