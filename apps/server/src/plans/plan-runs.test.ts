import type {
  HostRead,
  PlanIntent,
  PlanRun,
  ProviderCommand,
  ProviderInstance,
  ServerCommand,
  WorkflowRun,
  WorkflowStep,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandRejected } from '../core/orchestrator.js';
import { snapshot } from '../core/subscriptions.js';
import { providerInstances } from '../db/schema.js';
import { MockGitHub, type MockPullRequest } from '../hosts/mock-github.js';
import { MockProviderAdapter } from '../hooks/index.js';
import { startServer, type RunningServer } from '../server.js';

// U8 ground truth (review loop spec 40 to 47): a plan run over an invented plan, with a mock
// provider as the agent, an invented GitHub host and a temporary repository with a bare remote
// for the working copies. Nothing sleeps: a test waits for the commit that makes a row match,
// and a host round runs when the test fires the poller's timer or a unit's run ends.

const api = 'https://ghe.example.invalid/api/v3';
const TOKEN = 'ghp-invented-token-for-tests';
const intentId = '2026-01-tea-timer';
const planId = `tea:${intentId}`;

let root: string;
let home: string;
let project: string;
let server: RunningServer;
let host: MockGitHub;
let adapters: MockProviderAdapter[];
let timers: { callback: () => void; delayMs: number }[];
// What the invented agent does when a turn starts: answer 'fail' to fail the turn.
let agent: (prompt: string, cwd: string) => 'fail' | undefined;
const ceiling = process.env['GIT_CEILING_DIRECTORIES'];
let ids = 0;

const dispatch = (command: ServerCommand) => server.engine.dispatch(`t${++ids}`, command);
const set = (key: string, value: unknown, scope = 'global') =>
  dispatch({ type: 'setting.set', key, scope, value });
const rows = <T>(topic: 'planIntents' | 'planRuns' | 'workflowRuns' | 'hostReads') =>
  snapshot(server.database.db, { topic }) as T[];
const plan = (id = planId) => rows<PlanIntent>('planIntents').find((row) => row.id === id);
const statuses = () =>
  Object.fromEntries((plan()?.units ?? []).map((unit) => [unit.key, unit.status]));
const planRun = (id = 'pr1') => rows<PlanRun>('planRuns').find((row) => row.id === id);
const runs = () => rows<WorkflowRun>('workflowRuns');
const run = (id: string) => runs().find((row) => row.id === id);
const planRead = () => rows<HostRead>('hostReads').find((row) => row.id === `plan:${planId}`);

// Resolves on the commit that makes the row match.
function becomes<T>(read: () => T | undefined, predicate: (row: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    const check = () => {
      const current = read();
      if (current !== undefined && predicate(current)) {
        unsubscribe();
        resolve(current);
      }
    };
    const unsubscribe = server.engine.onCommit(check);
    check();
  });
}
const planRunBecomes = (predicate: (row: PlanRun) => boolean, id = 'pr1') =>
  becomes(() => planRun(id), predicate);
const runBecomes = (id: string, predicate: (row: WorkflowRun) => boolean) =>
  becomes(() => run(id), predicate);

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

const intentMd = `---\nid: ${intentId}\nstatus: accepted\nrev: 1\nsupersedes: null\n---\n\n# A tea timer\n`;
const specMd = (rev = 1) =>
  `---\nintent: ${intentId}\nrev: ${rev}\nbuilt_on: intent@1\nstatus: accepted\n---\n\n# Spec\n`;
const planMd = (source = 'files') =>
  [
    `---\nintent: ${intentId}\nrev: 1\nbuilt_on: spec@1\nstatus: accepted\nsource: ${source}\n---\n`,
    '# Plan\n\n## Units\n',
    '- [U1] Count down',
    '- [U2] Ring the bell -- depends on U1',
    '- [U3] Show the time left',
    '',
    ...['U1', 'U2', 'U3'].flatMap((key) => [`### ${key} Unit`, '', 'Outcome: done.', '']),
  ].join('\n');

async function writePlan(files: Record<string, string>): Promise<void> {
  const folder = path.join(project, 'intents', intentId);
  await mkdir(folder, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(folder, name), text);
  await server.plans.refresh();
}

let pullNumber = 20;
const pull = (key: string, overrides: Partial<MockPullRequest> = {}): MockPullRequest => ({
  number: ++pullNumber,
  title: `Invented pull request for ${key}`,
  body: `Invented for the tests.\n\nIntent-Unit: ${intentId}/${key}`,
  state: 'open',
  branch: `agent/${key}`,
  sha: `${key}abc`.toLowerCase(),
  ...overrides,
});
const merge = (key: string) => {
  host.pulls = host.pulls.map((entry) =>
    entry.body.endsWith(`/${key}`)
      ? { ...entry, state: 'closed', mergedAt: '2026-11-04T10:00:00Z' }
      : entry,
  );
};
// The agent of a unit's run opens the unit's pull request, as deliver-work does.
const opensPullRequest = (prompt: string) => {
  const key = /^Unit: (\S+)/m.exec(prompt)?.[1];
  if (key && !host.pulls.some((entry) => entry.body.endsWith(`/${key}`))) {
    host.pulls = [...host.pulls, pull(key)];
  }
  return undefined;
};

// The round the poller's timer runs.
const poll = async () => {
  timers.findLast((timer) => timer.delayMs === 86_400_000)?.callback();
  await server.hosts.idle();
};

const follow = async () => {
  dispatch({ type: 'plan.follow', planId, followed: true });
  await server.hosts.idle();
};

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

const step = (id: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep => ({
  id,
  skillName: id,
  providerInstanceId: 'claude-work',
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
  ...overrides,
});

const startTurns = () =>
  adapters.flatMap((adapter) =>
    adapter.sent.filter(
      (command): command is Extract<ProviderCommand, { type: 'startTurn' }> =>
        command.type === 'startTurn',
    ),
  );

const start = (workflowId = 'deliver', planRunId = 'pr1') =>
  dispatch({ type: 'planRun.start', planRunId, planId, workflowId });

const refusal = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    if (error instanceof CommandRejected) return error.message;
    throw error;
  }
  return 'not refused';
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'wow plan runs ')));
  process.env['GIT_CEILING_DIRECTORIES'] = root;
  home = path.join(root, 'wow home');
  project = path.join(root, 'tea timer');
  const remote = path.join(root, 'the remote.git');
  const seed = path.join(root, 'seed');
  await mkdir(seed);
  git(seed, 'init', '-q', '-b', 'main');
  await writeFile(path.join(seed, 'readme.md'), '# Invented tea timer\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'Invented start');
  git(root, 'clone', '-q', '--bare', seed, remote);
  git(root, 'clone', '-q', '-c', 'core.autocrlf=false', remote, project);

  adapters = [];
  timers = [];
  agent = opensPullRequest;
  pullNumber = 20;
  host = new MockGitHub({ owner: 'acme', repo: 'tea', webUrl: 'https://ghe.example.invalid' });
  host.token = TOKEN;
  server = await startServer({
    home,
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: path.join(root, 'user'),
    watchSkills: () => ({ close: () => Promise.resolve() }),
    watchPlans: () => ({ close: () => Promise.resolve() }),
    schedulerTimers: { setTimeout: () => undefined, clearTimeout: () => undefined },
    hostTimers: {
      setTimeout: (callback, delayMs) => timers.push({ callback, delayMs }),
      clearTimeout: () => undefined,
    },
    fetch: host.fetch(api),
    hooks: {
      providers: {
        claude: (row) => {
          const adapter = new MockProviderAdapter(row.kind, (command) => {
            if (command.type !== 'startTurn') return [];
            const { threadId } = command;
            if (agent(command.prompt, command.cwd) === 'fail') {
              return [{ type: 'turnFailed', threadId, error: 'Invented failure' }];
            }
            return [
              { type: 'textDelta', threadId, itemId: `${threadId}-a`, delta: 'Done' },
              { type: 'turnCompleted', threadId },
            ];
          });
          adapters.push(adapter);
          return adapter;
        },
      },
    },
  });
  server.database.db.insert(providerInstances).values([instance]).run();
  dispatch({ type: 'project.create', projectId: 'tea', name: 'Tea timer', cwd: project });
  // The timer only fires when the test says so.
  set('hosts.pollSeconds', 86_400);
  set('trackers.github.baseUrl', api);
  set('trackers.github.owner', 'acme');
  set('trackers.github.repo', 'tea');
  set('trackers.github.token', await server.secrets.set('setting:trackers.github.token', TOKEN));
  dispatch({
    type: 'workflow.create',
    workflowId: 'deliver',
    name: 'Deliver',
    steps: [step('deliver-work')],
    forUnits: true,
  });
  dispatch({
    type: 'workflow.create',
    workflowId: 'gated',
    name: 'Deliver and check',
    steps: [step('deliver-work', { gateAfter: true }), step('check-work')],
    forUnits: true,
  });
  await writePlan({ 'intent.md': intentMd, 'spec.md': specMd(), 'plan.md': planMd() });
});

afterEach(async () => {
  await server.stop();
  if (ceiling === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
  else process.env['GIT_CEILING_DIRECTORIES'] = ceiling;
  await rm(root, { recursive: true, force: true });
});

describe('starting a plan run (spec 40)', () => {
  it('runs the workflow for the first ready unit in its own working copy and tells every step the intent id, unit key and title', async () => {
    await follow();
    expect(statuses()).toEqual({ U1: 'ready', U2: 'waiting', U3: 'ready' });
    const before = git(project, 'status', '--porcelain');

    start('gated');
    expect(planRun()).toMatchObject({
      state: 'running',
      planId,
      workflowId: 'gated',
      units: [{ unitKey: 'U1', title: 'Count down', runId: 'pr1.U1', outcome: 'running' }],
    });
    // One unit at a time: U3 is ready too and has no run.
    expect(runs().map((row) => row.id)).toEqual(['pr1.U1']);

    const waiting = await runBecomes('pr1.U1', (row) => row.state === 'waiting');
    expect(waiting.unit).toEqual({
      planRunId: 'pr1',
      planId,
      intentId,
      unitKey: 'U1',
      title: 'Count down',
    });
    // The workflow's own switch is off; a unit's run gets a working copy all the same.
    expect(waiting.workingCopy).toMatchObject({ state: 'ready' });
    const folder = waiting.workingCopy?.path ?? '';
    expect(path.dirname(folder)).toBe(path.join(home, 'workspaces'));

    dispatch({ type: 'workflowRun.continue', runId: 'pr1.U1' });
    await runBecomes('pr1.U1', (row) => row.state === 'done');
    const turns = startTurns().filter((turn) => turn.threadId.startsWith('pr1.U1.'));
    expect(turns.map((turn) => turn.cwd)).toEqual([folder, folder]);
    for (const turn of turns) {
      expect(turn.prompt).toContain(`Intent: ${intentId}`);
      expect(turn.prompt).toContain('Unit: U1 Count down');
      expect(turn.prompt).toContain(`Intent-Unit: ${intentId}/U1`);
    }
    expect(turns[0]?.prompt.startsWith('/deliver-work\n\nThis run delivers one unit')).toBe(true);
    expect(git(project, 'status', '--porcelain')).toBe(before);
  });

  it('renders workflows.unitPromptTemplate as the project sets it', async () => {
    set(
      'workflows.unitPromptTemplate',
      '{{intentId}} / {{unitKey}} / {{unitTitle}}',
      'project:tea',
    );
    await follow();
    start();
    await runBecomes('pr1.U1', (row) => row.state === 'done');
    expect(startTurns()[0]?.prompt).toBe(`/deliver-work\n\n${intentId} / U1 / Count down`);
  });
});

describe('working through the units (spec 41, 44)', () => {
  it('starts U3 when U1 is done, waits for U1 to merge before U2, starts U2 when a poll shows the merge, and is done when every unit is delivered', async () => {
    await follow();
    start();
    await runBecomes('pr1.U3', (row) => row.state === 'done');
    expect(run('pr1.U1')?.state).toBe('done');
    expect(run('pr1.U2')).toBeUndefined();

    const sentences = [
      'U1 waits for its pull request to merge',
      'U2 waits for U1 to merge',
      'U3 waits for its pull request to merge',
    ];
    const waiting = await planRunBecomes(
      (row) => row.state === 'waiting' && row.waitingFor.join() === sentences.join(),
    );
    expect(waiting.units.map((unit) => [unit.unitKey, unit.outcome])).toEqual([
      ['U1', 'done'],
      ['U3', 'done'],
    ]);
    expect(statuses()).toEqual({ U1: 'claimed', U2: 'waiting', U3: 'claimed' });

    // A poll that shows nothing new starts nothing.
    await poll();
    expect(run('pr1.U2')).toBeUndefined();

    merge('U1');
    await poll();
    expect(statuses()).toMatchObject({ U1: 'delivered' });
    expect(planRun()).toMatchObject({ state: 'running', waitingFor: [] });
    await runBecomes('pr1.U2', (row) => row.state === 'done');
    await planRunBecomes(
      (row) =>
        row.state === 'waiting' &&
        row.waitingFor.join() ===
          [
            'U2 waits for its pull request to merge',
            'U3 waits for its pull request to merge',
          ].join(),
    );

    merge('U2');
    merge('U3');
    await poll();
    expect(planRun()).toMatchObject({ state: 'done', waitingFor: [], message: null });
    expect(planRun()?.endedAt).not.toBeNull();
    expect(runs().map((row) => row.id)).toEqual(['pr1.U1', 'pr1.U3', 'pr1.U2']);
  });

  it('does not start a unit twice when its run ended without a pull request, and says no pull request was found', async () => {
    agent = () => undefined;
    await follow();
    start();
    await runBecomes('pr1.U3', (row) => row.state === 'done');
    await server.hosts.idle();
    expect(planRun()).toMatchObject({
      state: 'waiting',
      waitingFor: [
        'No pull request found for U1',
        'U2 waits for U1 to merge',
        'No pull request found for U3',
      ],
    });
    await poll();
    expect(statuses()).toEqual({ U1: 'ready', U2: 'waiting', U3: 'ready' });
    expect(runs().map((row) => row.id)).toEqual(['pr1.U1', 'pr1.U3']);
  });
});

describe('a unit someone else claims (spec 42)', () => {
  it('skips a unit claimed by a pull request this plan run did not start', async () => {
    host.pulls = [pull('U1')];
    await follow();
    expect(statuses()).toEqual({ U1: 'claimed', U2: 'waiting', U3: 'ready' });
    start();
    await runBecomes('pr1.U3', (row) => row.state === 'done');
    await planRunBecomes((row) => row.state === 'waiting');
    expect(run('pr1.U1')).toBeUndefined();
    expect(planRun()?.units.map((unit) => unit.unitKey)).toEqual(['U3']);
  });

  it('skips a unit someone else claimed on the host while the unit before it was running', async () => {
    agent = (prompt) => {
      if (prompt.includes('Unit: U1 ')) host.pulls = [...host.pulls, pull('U3')];
      return opensPullRequest(prompt);
    };
    await follow();
    expect(statuses()).toEqual({ U1: 'ready', U2: 'waiting', U3: 'ready' });
    start();
    const waiting = await planRunBecomes((row) => row.state === 'waiting');
    expect(waiting.units.map((unit) => [unit.unitKey, unit.outcome])).toEqual([['U1', 'done']]);
    expect(statuses()).toEqual({ U1: 'claimed', U2: 'waiting', U3: 'claimed' });
    expect(runs().map((row) => row.id)).toEqual(['pr1.U1']);
    expect(host.pulls.filter((entry) => entry.body.endsWith('/U3'))).toHaveLength(1);
  });
});

describe('a plan run while the hosts are not polled (spec 30, 41)', () => {
  it('still asks about the plan once when a unit run ends, so it says what it really waits for', async () => {
    await follow();
    set('hosts.polling', false);
    start();
    const waiting = await planRunBecomes(
      (row) => row.state === 'waiting' && row.units.every((unit) => unit.outcome === 'done'),
    );
    expect(waiting.waitingFor).toEqual([
      'U1 waits for its pull request to merge',
      'U2 waits for U1 to merge',
      'U3 waits for its pull request to merge',
    ]);
    expect(runs().map((row) => row.id)).toEqual(['pr1.U1', 'pr1.U3']);

    // The interval still asks nothing while polling is off.
    merge('U1');
    await poll();
    expect(statuses()).toMatchObject({ U1: 'claimed' });
    expect(run('pr1.U2')).toBeUndefined();
  });
});

describe('a unit run that fails (spec 43)', () => {
  beforeEach(() => {
    agent = (prompt) => (prompt.includes('Unit: U1 ') ? 'fail' : opensPullRequest(prompt));
  });

  it('stops the plan run there when workflows.planRunOnFailure is stop', async () => {
    await follow();
    start();
    const failed = await planRunBecomes((row) => row.state === 'failed');
    expect(failed).toMatchObject({
      units: [{ unitKey: 'U1', outcome: 'failed' }],
      message: 'The run for U1 failed, so no further unit was started',
    });
    expect(run('pr1.U1')?.state).toBe('failed');
    await poll();
    expect(runs().map((row) => row.id)).toEqual(['pr1.U1']);
  });

  it('leaves the unit and starts the next ready unit that does not depend on it when it is skip', async () => {
    set('workflows.planRunOnFailure', 'skip', 'project:tea');
    await follow();
    start();
    await runBecomes('pr1.U3', (row) => row.state === 'done');
    const waiting = await planRunBecomes(
      (row) => row.state === 'waiting' && !row.waitingFor.some((s) => s.startsWith('No pull')),
    );
    expect(waiting.units.map((unit) => [unit.unitKey, unit.outcome])).toEqual([
      ['U1', 'failed'],
      ['U3', 'done'],
    ]);
    expect(waiting.waitingFor).toEqual([
      'The run for U1 failed',
      'U2 waits for U1 to merge',
      'U3 waits for its pull request to merge',
    ]);
    // U2 depends on the unit that was left.
    expect(run('pr1.U2')).toBeUndefined();
  });

  it('treats a unit run the user stopped like a failed one', async () => {
    agent = opensPullRequest;
    await follow();
    start('gated');
    await runBecomes('pr1.U1', (row) => row.state === 'waiting');
    dispatch({ type: 'workflowRun.stop', runId: 'pr1.U1' });
    expect(await planRunBecomes((row) => row.state !== 'running')).toMatchObject({
      state: 'failed',
      message: 'The run for U1 was stopped, so no further unit was started',
    });
  });
});

describe('stopping a plan run (spec 45)', () => {
  it('stops the live unit run and starts no further unit', async () => {
    await follow();
    start('gated');
    await runBecomes('pr1.U1', (row) => row.state === 'waiting');
    dispatch({ type: 'planRun.stop', planRunId: 'pr1' });
    expect(run('pr1.U1')?.state).toBe('stopped');
    expect(planRun()).toMatchObject({
      state: 'stopped',
      units: [{ unitKey: 'U1', outcome: 'stopped' }],
      message: null,
    });
    await poll();
    expect(runs().map((row) => row.id)).toEqual(['pr1.U1']);
    expect(refusal(() => dispatch({ type: 'planRun.stop', planRunId: 'pr1' }))).toBe(
      'The plan run is already stopped',
    );
  });

  it('stops a plan run that waits, so a later merge starts nothing', async () => {
    await follow();
    start();
    await runBecomes('pr1.U3', (row) => row.state === 'done');
    await planRunBecomes((row) => row.state === 'waiting');
    await server.hosts.idle();
    dispatch({ type: 'planRun.stop', planRunId: 'pr1' });
    merge('U1');
    await poll();
    expect(statuses()).toMatchObject({ U1: 'delivered', U2: 'ready' });
    expect(run('pr1.U2')).toBeUndefined();
    expect(planRun()?.state).toBe('stopped');
  });
});

describe('refusing a plan run (spec 46, 47)', () => {
  it('refuses a stale plan and names the stale file', async () => {
    await writePlan({ 'spec.md': specMd(2) });
    await follow();
    expect(refusal(() => start())).toBe(
      'Not started: plan.md is stale (built on spec@1, spec.md is at rev 2)',
    );
    expect(planRun()).toBeUndefined();
  });

  it('refuses a plan with source: issues', async () => {
    await writePlan({ 'plan.md': planMd('issues') });
    await follow();
    expect(refusal(() => start())).toBe(
      'This plan keeps its units in issues (source: issues), so wow cannot tell which unit is ready',
    );
  });

  it('refuses a workflow that is not marked for units', async () => {
    dispatch({ type: 'workflow.update', workflowId: 'deliver', forUnits: false });
    await follow();
    expect(refusal(() => start())).toBe(
      'Workflow Deliver is not marked "For units"; turn that on in the builder first',
    );
  });

  it('refuses a second plan run while one is live on the plan, and allows one after it ended', async () => {
    await follow();
    start('gated');
    expect(refusal(() => start('deliver', 'pr2'))).toBe(
      'A plan run is already going on this plan, and a plan runs one unit at a time',
    );
    expect(planRun('pr2')).toBeUndefined();
    dispatch({ type: 'planRun.stop', planRunId: 'pr1' });
    start('gated', 'pr2');
    expect(planRun('pr2')?.state).toBe('running');
  });

  it('refuses a plan that is not followed, and a first unit whose run cannot start', async () => {
    expect(refusal(() => start())).toMatch(/^Follow the plan first/);
    await follow();
    dispatch({
      type: 'workflow.create',
      workflowId: 'broken',
      name: 'Broken',
      steps: [step('deliver-work', { providerInstanceId: 'nobody' })],
      forUnits: true,
    });
    expect(refusal(() => start('broken'))).toMatch(
      /provider instance nobody, which does not exist/,
    );
    expect(planRun()).toBeUndefined();
    expect(runs()).toEqual([]);
  });
});

describe('a plan with a live plan run is open (spec Decisions)', () => {
  it('keeps reading the host after an unfollow while the plan run is live, and forgets what was read when it ends', async () => {
    await follow();
    start();
    await runBecomes('pr1.U3', (row) => row.state === 'done');
    await planRunBecomes((row) => row.state === 'waiting');
    await server.hosts.idle();

    dispatch({ type: 'plan.follow', planId, followed: false });
    expect(plan()?.followed).toBe(false);
    expect(statuses()).toEqual({ U1: 'claimed', U2: 'waiting', U3: 'claimed' });
    merge('U1');
    await poll();
    expect(statuses()).toMatchObject({ U1: 'delivered' });
    await runBecomes('pr1.U2', (row) => row.state === 'done');
    await server.hosts.idle();

    dispatch({ type: 'planRun.stop', planRunId: 'pr1' });
    expect(statuses()).toEqual({ U1: 'unknown', U2: 'unknown', U3: 'unknown' });
    expect(planRead()).toBeUndefined();
    const asked = host.requests.length;
    await poll();
    expect(host.requests.length).toBe(asked);
  });
});

describe('a plan that goes away', () => {
  it('fails the plan run when its plan is gone', async () => {
    await follow();
    start();
    await runBecomes('pr1.U3', (row) => row.state === 'done');
    await planRunBecomes((row) => row.state === 'waiting');
    await server.hosts.idle();
    await rm(path.join(project, 'intents'), { recursive: true });
    await server.plans.refresh();
    expect(planRun()).toMatchObject({ state: 'failed', message: 'The plan is no longer there' });
  });
});
