import {
  type AppNotification,
  type ProviderInstance,
  type ServerCommand,
  type StepRule,
  type WorkflowRun,
  type WorkflowStep,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandRejected } from '../core/orchestrator.js';
import {
  notifications,
  projects,
  providerInstances,
  threads,
  workflowRuns,
  workflows,
} from '../db/schema.js';
import { MockProviderAdapter } from '../hooks/index.js';
import { MockGitHub, type MockCheckRun, type MockPullRequest } from '../hosts/mock-github.js';
import { MockGitLab } from '../hosts/mock-gitlab.js';
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
let options: Parameters<typeof startServer>[0];
let host: MockGitHub;
let now: Date;
// What the invented agent answers, by the skill its prompt starts with.
let answers: Record<string, string>;
let prompts: string[];
// Runs as a turn starts, before it is answered.
let onTurn: () => void;
let timers: { callback: () => void; delayMs: number }[];
// Threads whose turn is the message that is never answered.
const hanging = new Set<string>();
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
  // The commit the project folder is on: a gate counts checks only for the commit its step left.
  sha: git(project, 'rev-parse', 'HEAD').trim(),
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
  onTurn = () => undefined;
  timers = [];
  hanging.clear();
  host = new MockGitHub({ owner: 'acme', repo: 'tea', webUrl: 'https://ghe.example.invalid' });
  host.token = TOKEN;
  host.pulls = [checks(passed('test'))];
  options = {
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
            // Only the message that hangs is ever interrupted here; it ends as interrupted.
            if (command.type === 'interrupt' && hanging.delete(command.threadId)) {
              return [{ type: 'turnInterrupted', threadId: command.threadId }];
            }
            if (command.type !== 'startTurn') return [];
            const { threadId, prompt } = command;
            prompts.push(prompt);
            onTurn();
            const skill = Object.keys(answers).find((name) => prompt.startsWith(`/${name}`));
            // A message the test sends beside the run and that is never answered.
            if (prompt === 'hang') {
              hanging.add(threadId);
              return [];
            }
            const failure = /^fails: (.*)$/.exec(answers[skill ?? ''] ?? '');
            if (failure) return [{ type: 'turnFailed', threadId, error: failure[1] ?? '' }];
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
  };
  server = await startServer(options);
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

  it('does not hold when the project row is gone at the step end, so nothing could be looked at', async () => {
    await mkdir(path.join(project, 'docs'));
    await writeFile(path.join(project, 'docs', 'bell.md'), '# Invented notes\n');
    // The row goes while the step's turn is answered, before the runner looks for the files.
    answers['check-work'] = 'Looked.';
    onTurn = () => db().delete(projects).where(eq(projects.id, 'tea')).run();
    createWorkflow(expecting);
    await start();
    expect(run().state).toBe('waiting');
    expect(gate()).toMatchObject({
      state: 'waitingForUser',
      parts: [
        { part: 'artifacts', state: 'failed', detail: 'Nothing found for docs/*.md, readme.md' },
      ],
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

  it('names a GitLab merge request as one in the failing check', async () => {
    const site = 'https://gitlab.example.invalid';
    const gitlab = new MockGitLab({ projectPath: 'acme/tea', webUrl: site });
    gitlab.token = 'glpat-invented-token-for-tests';
    gitlab.mergeRequests = [
      {
        iid: 14,
        title: 'Ring the bell at zero',
        description: 'Invented for the tests.',
        state: 'opened',
        branch: bellBranch,
        sha: git(project, 'rev-parse', 'HEAD').trim(),
        pipeline: { id: 7, status: 'failed', jobs: [{ name: 'test', status: 'failed' }] },
      },
    ];
    git(project, 'remote', 'set-url', 'origin', `${site}/acme/tea.git`);
    await server.stop();
    server = await startServer({ ...options, fetch: gitlab.fetch(site) });
    set('trackers.gitlab.baseUrl', site);
    set(
      'trackers.gitlab.token',
      await server.secrets.set('setting:trackers.gitlab.token', gitlab.token),
    );
    createWorkflow({ gateAfterCondition: ['checks'] });
    await start();
    expect(gate()).toMatchObject({
      state: 'waitingForUser',
      parts: [
        { part: 'checks', state: 'failed', detail: 'Merge request !14 has failing checks: test' },
      ],
    });
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

  it('does not take successful checks of another commit as its answer', async () => {
    // The host still shows the commit before the one the step left.
    host.pulls = [{ ...checks(passed('test')), sha: 'a1a1a1a' }];
    createWorkflow({ gateAfterCondition: ['checks'] });
    await start();
    expect(run().state).toBe('waiting');
    expect(gate()).toMatchObject({
      state: 'waitingForChecks',
      parts: [{ part: 'checks', state: 'pending' }],
    });
    // Once the host shows the step's commit with its checks green, the gate passes.
    host.pulls = [checks(passed('test'))];
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

  it('ends at start a wait that ran out while the server was stopped, even when no read is stored', async () => {
    host.pulls = [checks(going('test'))];
    createWorkflow({ gateAfterCondition: ['checks'] });
    await start();
    expect(gate()?.state).toBe('waitingForChecks');
    // Its project's row is gone, so the read at start stores nothing for the run.
    db().delete(projects).where(eq(projects.id, 'tea')).run();
    await server.stop();

    minutes(45);
    server = await startServer(options);
    await server.hosts.idle();
    await settle();
    expect(run().state).toBe('waiting');
    expect(gate()).toMatchObject({
      state: 'waitingForUser',
      parts: [{ part: 'checks', state: 'failed' }],
    });
    expect(waitingNotices()).toHaveLength(1);
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

// Workflow branches spec 1 to 17 on the server: rules followed through the runner, the wait for
// checks a rule asks for, what saving refuses, and a run from before paths were kept.
const goTo = (when: StepRule['when'], stepId: string): StepRule => ({
  when,
  goTo: { type: 'step', stepId },
});
const changesRequested: StepRule['when'] = { fact: 'verdict', is: 'changesRequested' };
const checksFailed: StepRule['when'] = { fact: 'checks', is: 'failed' };
const createRules = (steps: WorkflowStep[], maxStepVisits?: number) =>
  dispatch({
    type: 'workflow.create',
    workflowId: 'review',
    name: 'Build and review',
    steps,
    ...(maxStepVisits === undefined ? {} : { maxStepVisits }),
  });
const states = () => run().steps.map((entry) => entry.state);
const visits = () =>
  (run().path ?? []).map((visit) => `${visit.stepId}#${visit.attempt}: ${visit.reason}`);
const skills = () => prompts.map((prompt) => prompt.split(/\s/)[0]);

const storedLimit = () =>
  db()
    .select()
    .from(workflows)
    .all()
    .find((row) => row.id === 'review')?.maxStepVisits;

describe('rules on a step (workflow branches)', () => {
  it('tells the user each time a run waits before a step it was sent back to', async () => {
    answers = { build: 'Built.', 'check-work': 'Still rings twice.\n\nCHANGES_REQUESTED' };
    createRules([
      step('build', { gateBefore: true }),
      step('check-work', { rules: [goTo(changesRequested, 'build')] }),
    ]);
    await start();
    expect(run()).toMatchObject({ state: 'waiting', currentStep: 0 });
    expect(waitingNotices()).toHaveLength(1);
    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    await settle();
    // Review sent the work back: the run waits before build again, and says so again.
    expect(run()).toMatchObject({ state: 'waiting', currentStep: 0 });
    expect(waitingNotices()).toHaveLength(2);
  });

  it('sends the work back to build until the limit, then waits for the user, in two threads', async () => {
    answers = { build: 'Built.', 'check-work': 'Still rings twice.\n\nCHANGES_REQUESTED' };
    createRules([
      step('build'),
      step('check-work', { rules: [goTo(changesRequested, 'build')] }),
      step('wrap'),
    ]);
    await start();

    expect(run()).toMatchObject({ state: 'waiting', currentStep: 0 });
    expect(run().steps[0]).toMatchObject({
      state: 'waiting',
      attempt: 3,
      gate: { state: 'waitingAtLimit', detail: 'build has run 3 times: the limit' },
    });
    expect(run().steps[1]).toMatchObject({ state: 'done', attempt: 3 });
    // Each step ran three times in its one thread.
    expect(
      db()
        .select()
        .from(threads)
        .all()
        .map((thread) => thread.id)
        .toSorted(),
    ).toEqual(['r1.build', 'r1.check-work']);
    expect(prompts).toHaveLength(6);
    expect(prompts[2]).toBe(
      [
        'The step check-work sent the work back to this step: verdict changes requested.',
        '',
        'What check-work ended with:',
        '',
        'Still rings twice.',
        '',
        'CHANGES_REQUESTED',
        '',
        'Do the step (build) again in this conversation with that taken into account, and end with your result as before.',
      ].join('\n'),
    );
    // A rule of check-work reads the verdict, so it gets wow-verdict (wow skills spec 12).
    expect(prompts[3]).toBe(
      [
        '/check-work',
        '',
        '<skill name="wow-verdict">',
        'End your final message with exactly one of these lines, alone on the last line and with nothing after it:',
        '',
        'APPROVED when the work is done and acceptable as it is.',
        'CHANGES_REQUESTED when it needs changes before it can go on.',
        "BLOCKED when it cannot go on without someone's help.",
        '</skill>',
        '',
        'The previous step (build) ended with:',
        '',
        'Done',
      ].join('\n'),
    );
    expect(waitingNotices()).toHaveLength(1);
    expect(visits().at(-1)).toBe('check-work#3: verdict changes requested → build');
    expect(run().path?.at(-1)?.limit).toBe('build has run 3 times: the limit');

    // Approve lets build run once more; the review approves this time and the run finishes.
    answers['check-work'] = 'One ring.\n\nAPPROVED';
    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    await settle();
    expect(run()).toMatchObject({ state: 'waiting', currentStep: 1 });
    expect(run().steps[1]?.gate?.detail).toBe('check-work has run 3 times: the limit');
    expect(waitingNotices()).toHaveLength(2);
    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    await settle();
    expect(run().state).toBe('done');
    expect(states()).toEqual(['done', 'done', 'done']);
    expect(skills().at(-1)).toBe('/wrap');
  });

  it("stops at the workflow's own limit, and Stop ends the run there", async () => {
    answers = { build: 'Built.', 'check-work': 'CHANGES_REQUESTED' };
    createRules(
      [step('build'), step('check-work', { rules: [goTo(changesRequested, 'build')] })],
      1,
    );
    await start();
    expect(run().steps[0]?.gate?.detail).toBe('build has run 1 time: the limit');
    expect(prompts).toHaveLength(2);
    dispatch({ type: 'workflowRun.stop', runId: 'r1' });
    await settle();
    expect(run().state).toBe('stopped');
    expect(states()).toEqual(['done', 'done']);
  });

  it('waits for checks a rule asks about and follows the "failed" rule when a read shows a failure', async () => {
    host.pulls = [checks(going('test'))];
    createRules([
      step('check-work', { rules: [goTo(checksFailed, 'fix')] }),
      step('wrap'),
      step('fix'),
    ]);
    await start();
    expect(run().state).toBe('waiting');
    expect(gate()).toMatchObject({
      state: 'waitingForChecks',
      forRules: true,
      parts: [{ part: 'checks', state: 'pending' }],
    });
    expect(waitingNotices()).toEqual([]);

    host.pulls = [checks(failed('test'))];
    await poll();
    expect(run().state).toBe('done');
    expect(states()).toEqual(['done', 'skipped', 'done']);
    expect(skills()).toEqual(['/check-work', '/fix']);
    expect(run().steps[0]?.facts?.checks).toBe('failed');
    expect(visits()[0]).toBe('check-work#1: checks failed → fix');
  });

  it('does not take a failure of another commit as the answer to a rule on checks', async () => {
    host.pulls = [{ ...checks(failed('test')), sha: 'a1a1a1a' }];
    createRules([
      step('check-work', { rules: [goTo(checksFailed, 'fix')] }),
      step('wrap'),
      step('fix'),
    ]);
    await start();
    expect(gate()?.state).toBe('waitingForChecks');
    host.pulls = [checks(passed('test'))];
    await poll();
    expect(skills()).toEqual(['/check-work', '/wrap', '/fix']);
    expect(visits()[0]).toBe('check-work#1: no rule held → next step');
  });

  it('waits for the user after the wait for checks ran out, and Approve then follows the list', async () => {
    host.pulls = [checks(going('test'))];
    createRules([
      step('check-work', { rules: [goTo(checksFailed, 'fix')] }),
      step('wrap'),
      step('fix'),
    ]);
    await start();
    const timer = timers.findLast((entry) => entry.delayMs === 30 * 60_000);
    expect(timer).toBeDefined();
    minutes(30);
    timer?.callback();
    await settle();
    expect(run().state).toBe('waiting');
    expect(gate()?.state).toBe('waitingForUser');
    expect(gate()?.parts[0]?.detail).toContain('Checks were not successful within 30 minutes');
    expect(waitingNotices()).toHaveLength(1);

    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    await settle();
    expect(skills()).toEqual(['/check-work', '/wrap', '/fix']);
    expect(run().steps[0]?.facts?.checks).toBe('undecided');
  });

  it('follows a rule on artifacts with what the runner found per glob', async () => {
    createRules([
      step('check-work', {
        expectedArtifacts: ['docs/*.md', 'readme.md'],
        rules: [{ when: { fact: 'artifacts', is: 'missing' }, goTo: { type: 'end' } }],
      }),
      step('wrap'),
    ]);
    await start();
    expect(run().state).toBe('done');
    expect(states()).toEqual(['done', 'not_started']);
    expect(visits()).toEqual(['check-work#1: artifacts missing → End']);
  });

  it("starts the step a failed turn's rule names, with the error in its handover", async () => {
    answers = { build: 'fails: out of tea', diagnose: 'It was the kettle.' };
    createRules([
      step('build', { rules: [goTo({ fact: 'stepFailed' }, 'diagnose')] }),
      step('diagnose'),
    ]);
    await start();
    expect(run().state).toBe('done');
    expect(states()).toEqual(['failed', 'done']);
    expect(prompts[1]).toBe('/diagnose\n\nThe previous step (build) failed with:\n\nout of tea');
    expect(notices().filter((notice) => notice.kind === 'failed')).toEqual([]);
  });

  it('fails the run on a failed turn without such a rule', async () => {
    answers = { build: 'fails: out of tea' };
    createRules([step('build'), step('diagnose')]);
    await start();
    expect(run().state).toBe('failed');
    expect(states()).toEqual(['failed', 'not_started']);
  });

  it('refuses Approve while the thread of the step to go back to is answering, and holds the rerun until that turn ends when nobody asked', async () => {
    answers = { build: 'Built.', 'check-work': 'CHANGES_REQUESTED' };
    host.pulls = [checks(going('test'))];
    createRules([
      step('build'),
      step('check-work', {
        gateAfter: true,
        gateAfterCondition: ['checks'],
        rules: [goTo(changesRequested, 'build')],
      }),
    ]);
    await start();
    expect(run().steps[1]?.gate?.state).toBe('waitingForChecks');
    dispatch({ type: 'thread.sendMessage', threadId: 'r1.build', text: 'hang' });

    expect(() => dispatch({ type: 'workflowRun.continue', runId: 'r1' })).toThrow(
      "The step's thread is still answering a message",
    );
    expect(run().state).toBe('waiting');

    // The checks pass, so the gate passes by itself and the rule sends the run back to build,
    // whose thread is still answering the user: build's turn waits for that one.
    host.pulls = [checks(passed('test'))];
    now = new Date(now.getTime() + server.settings.get('hosts.pollSeconds') * 1000);
    await server.hosts.poll();
    await server.hosts.idle();
    await server.workflows.settled();
    expect(run().state).toBe('running');
    expect(run().steps[0]).toMatchObject({ state: 'running', attempt: 2 });
    expect(run().steps[0]?.heldPrompt).toContain('sent the work back');
    expect(prompts.at(-1)).toBe('hang');
    expect(notices().filter((notice) => notice.kind === 'failed')).toHaveLength(0);

    // The user's turn ends; build's turn starts in its thread, and the run goes on.
    answers['check-work'] = 'APPROVED';
    dispatch({ type: 'thread.interrupt', threadId: 'r1.build' });
    await server.workflows.settled();
    await settle();
    expect(prompts.filter((prompt) => prompt.includes('sent the work back'))).toHaveLength(1);
    expect(run().steps[0]?.heldPrompt).toBeUndefined();
    expect(run().steps[0]).toMatchObject({ state: 'done', attempt: 2, finalMessage: 'Done' });
    expect(visits().slice(0, 3)).toEqual([
      'build#1: next step',
      'check-work#1: verdict changes requested → build',
      'build#2: next step',
    ]);
  });

  it('refuses a workflow whose rule names a missing step, with the reason', () => {
    const missing = [step('build', { rules: [goTo(changesRequested, 'gone')] })];
    expect(() => createRules(missing)).toThrow(
      'Step build, rule 1: The rule "verdict changes requested" goes to a step that no longer exists',
    );
    createRules([step('build'), step('wrap')]);
    expect(() =>
      dispatch({ type: 'workflow.update', workflowId: 'review', steps: missing }),
    ).toThrow(CommandRejected);
  });

  it('refuses a rule on artifacts for a step without expected artifacts', () => {
    const rules: StepRule[] = [
      { when: { fact: 'artifacts', is: 'missing' }, goTo: { type: 'end' } },
    ];
    expect(() => createRules([step('build', { rules })])).toThrow(
      'Step build, rule 1: The rule "artifacts missing" needs expected artifacts, and this step names none',
    );
    createRules([step('build', { rules, expectedArtifacts: ['docs/*.md'] })]);
    expect(() =>
      dispatch({
        type: 'workflow.update',
        workflowId: 'review',
        steps: [step('build', { rules })],
      }),
    ).toThrow('needs expected artifacts');
  });

  it('refuses two rules with one condition on a step', () => {
    const twice = [
      step('build'),
      step('check-work', {
        rules: [goTo(changesRequested, 'build'), goTo(changesRequested, 'check-work')],
      }),
    ];
    expect(() => createRules(twice)).toThrow(
      'Step check-work, rule 2: The step already has a rule for "verdict changes requested"',
    );
    createRules([step('build'), step('check-work')]);
    expect(() => dispatch({ type: 'workflow.update', workflowId: 'review', steps: twice })).toThrow(
      'already has a rule',
    );
  });

  it('continues and finishes a run stored before paths were kept, in a workflow without rules', async () => {
    createWorkflow({});
    await start();
    expect(run().state).toBe('waiting');
    // As the store held such a run before this change: no path.
    db().update(workflowRuns).set({ path: null }).run();
    dispatch({ type: 'workflowRun.continue', runId: 'r1' });
    await settle();
    expect(run().state).toBe('done');
    expect(states()).toEqual(['done', 'done']);
    expect(run().path).toBeNull();
    expect(skills()).toEqual(['/check-work', '/wrap']);
    expect(
      run().steps.every((entry) => entry.facts === undefined && entry.attempt === undefined),
    ).toBe(true);
  });

  it("stores a workflow's own limit and takes it away again", () => {
    createRules([step('build')], 2);
    expect(storedLimit()).toBe(2);
    dispatch({ type: 'workflow.update', workflowId: 'review', maxStepVisits: 5 });
    expect(storedLimit()).toBe(5);
    dispatch({ type: 'workflow.update', workflowId: 'review', maxStepVisits: null });
    expect(storedLimit()).toBeNull();
  });
});
