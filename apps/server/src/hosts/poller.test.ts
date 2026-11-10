import type {
  ChangeRequest,
  HostRead,
  PlanIntent,
  ProviderInstance,
  ServerCommand,
  WorkflowRun,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandRejected } from '../core/orchestrator.js';
import { snapshot } from '../core/subscriptions.js';
import { providerInstances } from '../db/schema.js';
import { startServer, type RunningServer } from '../server.js';
import { createGitHubHost } from './github.js';
import { MockGitHub, type MockPullRequest } from './mock-github.js';
import { HostPoller } from './poller.js';

// U6 ground truth: unit status from pull requests, the run's pull request, and what the poller
// asks and when, against an invented GitHub Enterprise host. Nothing sleeps: a round runs when
// the test calls it or fires the poller's timer, and the clock is the test's.

const api = 'https://ghe.example.invalid/api/v3';
const TOKEN = 'ghp-invented-token-for-tests';
const intentId = '2026-01-tea-timer';
const planId = `tea:${intentId}`;

let root: string;
let server: RunningServer;
let host: MockGitHub;
let now: Date;
let logged: string[];
// Every timer the poller set.
let timers: { callback: () => void; delayMs: number }[];
const pollTimer = (delayMs: number) => timers.findLast((timer) => timer.delayMs === delayMs);
let reachable: boolean;
let ids = 0;

const dispatch = (command: ServerCommand) => server.engine.dispatch(`t${++ids}`, command);
const set = (key: string, value: unknown, scope = 'global') =>
  dispatch({ type: 'setting.set', key, scope, value });
const rows = <T>(topic: 'planIntents' | 'changeRequests' | 'hostReads') =>
  snapshot(server.database.db, { topic }) as T[];
const plan = (id = planId) => rows<PlanIntent>('planIntents').find((row) => row.id === id);
const read = (id = `plan:${planId}`) => rows<HostRead>('hostReads').find((row) => row.id === id);
const requests = () => rows<ChangeRequest>('changeRequests');
const statuses = (id = planId) =>
  Object.fromEntries((plan(id)?.units ?? []).map((unit) => [unit.key, unit.status]));
const asked = () => host.requests.map((request) => request.path);

const intentMd = (rev = 1) =>
  `---\nid: ${intentId}\nstatus: accepted\nrev: ${rev}\nsupersedes: null\n---\n\n# A tea timer\n`;
const specMd = (rev = 1) =>
  `---\nintent: ${intentId}\nrev: ${rev}\nbuilt_on: intent@1\nstatus: accepted\n---\n\n# Spec\n`;
const planMd = (id = intentId) =>
  [
    `---\nintent: ${id}\nrev: 1\nbuilt_on: spec@1\nstatus: accepted\nsource: files\n---\n`,
    '# Plan\n\n## Units\n',
    '- [U1] Count down',
    '- [U2] Ring the bell -- depends on U1',
    '- [U3] Show the time left -- depends on U1',
    '- [U4] Remember the last teas -- depends on U2',
    '- [U5] Pour by itself -- blocked: the pump is on order',
    '',
    ...['U1', 'U2', 'U3', 'U4', 'U5'].flatMap((key) => [
      `### ${key} Unit`,
      '',
      'Outcome: done.',
      '',
    ]),
  ].join('\n');

async function writePlan(files: Record<string, string>, id = intentId): Promise<void> {
  const folder = path.join(root, 'tea', 'intents', id);
  await mkdir(folder, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(folder, name), text);
  await server.plans.refresh();
}

const body = (...keys: string[]) =>
  ['Invented for the tests.', '', ...keys.map((key) => `Intent-Unit: ${intentId}/${key}`)].join(
    '\n',
  );

const merged: MockPullRequest = {
  number: 12,
  title: 'Count down from a chosen time',
  body: body('U1'),
  state: 'closed',
  mergedAt: '2026-11-01T10:00:00Z',
  branch: 'agent/U1-count-down',
  sha: 'a1a1a1a',
  checkRuns: [{ name: 'test', status: 'completed', conclusion: 'success' }],
};
const open: MockPullRequest = {
  number: 14,
  title: 'Ring the bell at zero',
  body: body('U2'),
  state: 'open',
  draft: true,
  branch: 'agent/U2-bell',
  sha: 'b2b2b2b',
  checkRuns: [
    { name: 'test (ubuntu-latest)', status: 'completed', conclusion: 'success' },
    { name: 'test (windows-latest)', status: 'completed', conclusion: 'failure' },
    { name: 'lint', status: 'in_progress', conclusion: null },
  ],
  statuses: { 'license/cla': 'success', 'deploy/preview': 'error' },
  comments: [
    { id: 9001, user: 'mira', body: 'The bell rings twice here.', path: 'bell/ring.ts' },
    { id: 9004, user: 'jon', body: 'Name the unit.', path: 'bell/ring.test.ts' },
  ],
};

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

// A run that waits before its only step: live, without a provider turn.
function startRun(runId = 'r1'): void {
  if (!server.database.db.select().from(providerInstances).get()) {
    server.database.db.insert(providerInstances).values(instance).run();
    dispatch({
      type: 'workflow.create',
      workflowId: 'gated',
      name: 'Gated',
      steps: [
        {
          id: 'only',
          skillName: 'deliver-work',
          providerInstanceId: instance.id,
          gateBefore: true,
          gateAfter: false,
          expectedArtifacts: [],
        },
      ],
    });
  }
  dispatch({ type: 'workflowRun.start', runId, workflowId: 'gated', projectId: 'tea' });
}

// Git in a folder, as an invented author.
const git = (folder: string, ...args: string[]) =>
  execFileSync('git', [
    '-C',
    folder,
    '-c',
    'user.name=Invented',
    '-c',
    'user.email=invented@example.invalid',
    '-c',
    'commit.gpgsign=false',
    ...args,
  ]);

// The project folder as a repository on this branch, without a commit.
function onBranch(branch: string): void {
  execFileSync('git', ['-C', path.join(root, 'tea'), 'init', '--quiet', '-b', branch], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'none'), GIT_CONFIG_NOSYSTEM: '1' },
  });
}

const follow = async (id = planId) => {
  dispatch({ type: 'plan.follow', planId: id, followed: true });
  await server.hosts.idle();
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-hosts-'));
  await mkdir(path.join(root, 'tea'), { recursive: true });
  now = new Date('2026-11-03T09:00:00.000Z');
  logged = [];
  timers = [];
  reachable = true;
  host = new MockGitHub({ owner: 'acme', repo: 'tea', webUrl: 'https://ghe.example.invalid' });
  host.token = TOKEN;
  host.pulls = [merged, open];
  const answer = host.fetch(api);
  server = await startServer({
    home: path.join(root, '.wow'),
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: (line) => logged.push(JSON.stringify(line)),
    userHome: root,
    watchSkills: () => ({ close: () => Promise.resolve() }),
    watchPlans: () => ({ close: () => Promise.resolve() }),
    clock: () => now,
    schedulerTimers: { setTimeout: () => undefined, clearTimeout: () => undefined },
    hostTimers: {
      setTimeout: (callback, delayMs) => timers.push({ callback, delayMs }),
      clearTimeout: () => undefined,
    },
    fetch: (input, init) =>
      reachable
        ? answer(input, init)
        : Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
  });
  dispatch({ type: 'project.create', projectId: 'tea', name: 'Tea', cwd: path.join(root, 'tea') });
  set('advanced.logLevel', 'debug');
  set('trackers.github.baseUrl', api);
  set('trackers.github.owner', 'acme');
  set('trackers.github.repo', 'tea');
  set('trackers.github.token', await server.secrets.set('setting:trackers.github.token', TOKEN));
  await writePlan({ 'intent.md': intentMd(), 'spec.md': specMd(), 'plan.md': planMd() });
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('unit status from pull requests (spec 23, 24, 26, 27)', () => {
  it('reads only the plan files until the plan is followed', () => {
    expect(statuses()).toEqual({
      U1: 'unknown',
      U2: 'unknown',
      U3: 'unknown',
      U4: 'unknown',
      U5: 'blocked',
    });
    expect(plan()?.units[0]?.statusReason).toBe(
      'This plan is not followed, so only its files are read',
    );
    expect(asked()).toEqual([]);
  });

  it('shows delivered, claimed, ready, waiting and blocked from pull requests carrying Intent-Unit lines', async () => {
    await follow();
    expect(statuses()).toEqual({
      U1: 'delivered',
      U2: 'claimed',
      U3: 'ready',
      U4: 'waiting',
      U5: 'blocked',
    });
    expect(plan()?.units.map((unit) => unit.statusReason)).toEqual([
      'Pull request #12 is merged',
      'Pull request #14 is open',
      'Every dependency is delivered',
      'Waits for U2',
      'the pump is on order',
    ]);
  });

  it('takes every Intent-Unit line of one pull request', async () => {
    host.pulls = [{ ...merged, body: body('U1', 'U2') }];
    await follow();
    expect(statuses()).toMatchObject({ U1: 'delivered', U2: 'delivered', U4: 'ready' });
    expect(requests()[0]?.units).toEqual([
      { intentId, unitKey: 'U1' },
      { intentId, unitKey: 'U2' },
    ]);
  });

  it('makes no unit of a stale plan ready and names the stale file', async () => {
    await writePlan({ 'spec.md': specMd(2) });
    await follow();
    expect(statuses()).toEqual({
      U1: 'delivered',
      U2: 'claimed',
      U3: 'waiting',
      U4: 'waiting',
      U5: 'blocked',
    });
    expect(plan()?.units[2]?.statusReason).toBe(
      'Not ready: plan.md is stale (built on spec@1, spec.md is at rev 2)',
    );
  });

  it('makes no unit ready when the spec is stale and names it', async () => {
    await follow();
    expect(statuses()['U3']).toBe('ready');
    await writePlan({ 'intent.md': intentMd(3) });
    expect(statuses()['U3']).toBe('waiting');
    expect(plan()?.units[2]?.statusReason).toBe(
      'Not ready: spec.md is stale (built on intent@1, intent.md is at rev 3)',
    );
  });

  it('links a unit to its pull request with state, draft, head, checks and when it was fetched', async () => {
    await follow();
    expect(plan()?.units.map((unit) => unit.changeRequestId)).toEqual([
      'tea:12',
      'tea:14',
      null,
      null,
      null,
    ]);
    expect(requests().find((request) => request.id === 'tea:14')).toMatchObject({
      projectId: 'tea',
      host: 'github',
      number: 14,
      title: 'Ring the bell at zero',
      url: 'https://ghe.example.invalid/acme/tea/pull/14',
      state: 'open',
      draft: true,
      mergedAt: null,
      headBranch: 'agent/U2-bell',
      headSha: 'b2b2b2b',
      checkState: 'failure',
      newestCommentId: '9004',
    });
    expect(requests().find((request) => request.id === 'tea:12')).toMatchObject({
      state: 'merged',
      mergedAt: '2026-11-01T10:00:00.000Z',
      checkState: 'success',
    });
    expect(read()).toEqual({
      id: `plan:${planId}`,
      projectId: 'tea',
      scope: 'plan',
      host: 'github',
      hostName: 'ghe.example.invalid',
      branch: null,
      changeRequestIds: ['tea:12', 'tea:14'],
      fetchedAt: '2026-11-03T09:00:00.000Z',
      error: null,
    });
  });

  it('says that GitHub is not set up and which setting is missing, and guesses nothing', async () => {
    dispatch({ type: 'setting.reset', key: 'trackers.github.token', scope: 'global' });
    await follow();
    expect(statuses()).toMatchObject({ U1: 'unknown', U5: 'blocked' });
    expect(plan()?.units[0]?.statusReason).toBe(
      "GitHub is not set up for this project: fill in GitHub token in Settings → Trackers or in the project's own trackers",
    );
    expect(read()?.error).toMatchObject({ kind: 'notSetUp', setting: 'trackers.github.token' });
    expect(asked()).toEqual([]);
  });

  it('does not send the shared token to a host that only the folder’s git remote names', async () => {
    onBranch('main');
    git(
      path.join(root, 'tea'),
      'remote',
      'add',
      'origin',
      'https://git.other.invalid/acme/tea.git',
    );
    await follow();
    startRun('r1');
    await server.hosts.idle();
    expect(asked()).toEqual([]);
    expect(read()?.error).toMatchObject({ kind: 'notSetUp', setting: 'trackers.github.baseUrl' });
    expect(statuses()).toMatchObject({ U1: 'unknown', U5: 'blocked' });
  });

  it('reads from the remote’s host once the user stored that host as the API URL', async () => {
    onBranch('main');
    // The stored API URL is the mock host; a remote on the same host is the user's own choice.
    git(
      path.join(root, 'tea'),
      'remote',
      'add',
      'origin',
      `https://${new URL(api).host}/acme/tea.git`,
    );
    set('trackers.github.baseUrl', `https://${new URL(api).host}/api/v3`);
    await follow();
    expect(read()?.error).not.toMatchObject({ kind: 'notSetUp' });
  });

  it('forgets what was read when the plan is unfollowed', async () => {
    await follow();
    dispatch({ type: 'plan.follow', planId, followed: false });
    expect(read()).toBeUndefined();
    expect(requests()).toEqual([]);
    expect(statuses()['U1']).toBe('unknown');
  });
});

describe('pull request beside a run (spec 28)', () => {
  it('shows the pull request of the branch the run is on, with failing check names and review comments, each linked', async () => {
    onBranch('agent/U2-bell');
    startRun();
    await server.hosts.idle();
    expect(read('run:r1')).toMatchObject({
      scope: 'run',
      branch: 'agent/U2-bell',
      changeRequestIds: ['tea:14'],
      fetchedAt: '2026-11-03T09:00:00.000Z',
      error: null,
    });
    const [request] = requests();
    expect(request?.checks.filter((check) => check.state === 'failure')).toEqual([
      {
        name: 'test (windows-latest)',
        state: 'failure',
        url: 'https://ghe.example.invalid/acme/tea/pull/14/checks?check_run_id=2',
      },
      {
        name: 'deploy/preview',
        state: 'failure',
        url: 'https://ghe.example.invalid/status/deploy%2Fpreview',
      },
    ]);
    expect(request?.checks.filter((check) => check.state === 'pending')).toHaveLength(1);
    expect(request?.comments).toEqual([
      {
        id: '9001',
        author: 'mira',
        body: 'The bell rings twice here.',
        path: 'bell/ring.ts',
        url: 'https://ghe.example.invalid/acme/tea/pull/14#discussion_r9001',
        createdAt: '2026-11-03T08:15:00.000Z',
      },
      {
        id: '9004',
        author: 'jon',
        body: 'Name the unit.',
        path: 'bell/ring.test.ts',
        url: 'https://ghe.example.invalid/acme/tea/pull/14#discussion_r9004',
        createdAt: '2026-11-03T08:15:00.000Z',
      },
    ]);
  });

  it('says so when the branch has no pull request or the folder is on no branch', async () => {
    startRun('r0');
    await server.hosts.idle();
    expect(read('run:r0')).toMatchObject({ branch: null, changeRequestIds: [], error: null });
    expect(asked()).toEqual([]);
    onBranch('agent/U9-nothing');
    await server.hosts.refresh({ runId: 'r0' });
    expect(read('run:r0')).toMatchObject({ branch: 'agent/U9-nothing', changeRequestIds: [] });
    expect(asked()).toEqual([
      '/repos/acme/tea/pulls?head=acme%3Aagent%2FU9-nothing&state=all&sort=created&direction=desc&per_page=1',
    ]);
  });

  it('takes the branch of the run’s own working copy, not the project folder’s', async () => {
    const tea = path.join(root, 'tea');
    onBranch('main');
    git(tea, 'add', '-A');
    git(tea, 'commit', '--quiet', '-m', 'Invented start');
    startRun('r0');
    dispatch({ type: 'workflow.update', workflowId: 'gated', ownWorkingCopy: true });
    startRun('r1');
    await server.workspaces.settled();
    await server.hosts.idle();
    // Fresh from the default branch the working copy is on no branch, so nothing is asked.
    expect(read('run:r1')).toMatchObject({ branch: null, changeRequestIds: [] });
    expect(asked()).toEqual([expect.stringContaining('head=acme%3Amain')]);

    const [copy] = (snapshot(server.database.db, { topic: 'workflowRuns' }) as WorkflowRun[])
      .filter((run) => run.id === 'r1')
      .map((run) => run.workingCopy);
    expect(copy?.state).toBe('ready');
    git(copy?.path ?? '', 'checkout', '--quiet', '-b', 'agent/U2-bell');
    await server.hosts.refresh({});
    expect(read('run:r1')).toMatchObject({ branch: 'agent/U2-bell', changeRequestIds: ['tea:14'] });
    expect(read('run:r0')).toMatchObject({ branch: 'main', changeRequestIds: [] });
  });
});

describe('what a poll asks (spec 29, 30)', () => {
  it('asks one search for a followed plan and only about its pull requests and the live run’s', async () => {
    host.pulls = [
      merged,
      open,
      {
        number: 20,
        title: 'Someone else’s work',
        body: 'Intent-Unit: 2026-02-kettle/K-1',
        state: 'open',
        branch: 'agent/K-1',
        sha: 'c3c3c3c',
      },
    ];
    onBranch('agent/U2-bell');
    await writePlan(
      { 'intent.md': intentMd(), 'plan.md': planMd('2026-02-kettle') },
      '2026-02-kettle',
    );
    startRun();
    await follow();
    host.requests.length = 0;
    await server.hosts.poll();
    const search = `/search/issues?q=${encodeURIComponent(`"Intent-Unit: ${intentId}/" in:body is:pr repo:acme/tea`)}&per_page=100`;
    // The merged pull request is known and does not change, so it is not read again.
    expect(asked()).toEqual([
      search,
      '/repos/acme/tea/pulls/14',
      '/repos/acme/tea/commits/b2b2b2b/check-runs?per_page=100',
      '/repos/acme/tea/commits/b2b2b2b/status?per_page=100',
      '/repos/acme/tea/pulls/14/comments?sort=created&direction=desc&per_page=100',
      '/repos/acme/tea/pulls?head=acme%3Aagent%2FU2-bell&state=all&sort=created&direction=desc&per_page=1',
    ]);
    expect(asked().filter((url) => url.startsWith('/search/'))).toHaveLength(1);
    expect(asked().some((url) => url.includes('/pulls/20') || url.includes('c3c3c3c'))).toBe(false);
    // The plan that is not followed got no search and no rows.
    expect(read('plan:tea:2026-02-kettle')).toBeUndefined();
    expect(requests().map((request) => request.number)).toEqual([12, 14]);
  });

  it('asks nothing for a project with no followed plan and no live run', async () => {
    await server.hosts.poll();
    expect(asked()).toEqual([]);
  });

  it('polls again every hosts.pollSeconds', async () => {
    await follow();
    expect(pollTimer(60_000)).toBeDefined();
    set('hosts.pollSeconds', 300);
    const waiting = timers.length;
    host.requests.length = 0;
    now = new Date(now.getTime() + 300_000);
    pollTimer(300_000)?.callback();
    await server.hosts.idle();
    expect(asked().filter((url) => url.startsWith('/search/'))).toHaveLength(1);
    expect(read()?.fetchedAt).toBe('2026-11-03T09:05:00.000Z');
    // The next round is set once this one is over.
    expect(timers.slice(waiting).map((timer) => timer.delayMs)).toEqual([300_000]);
  });

  it.each([
    ['scheduler.paused', true],
    ['hosts.polling', false],
  ] as const)(
    'asks nothing on a poll while %s is %s, and Refresh now asks once',
    async (key, value) => {
      set(key, value);
      await follow();
      await server.hosts.poll();
      pollTimer(60_000)?.callback();
      await server.hosts.idle();
      expect(asked()).toEqual([]);
      expect(read()).toBeUndefined();

      const reads = await server.hosts.refresh({ planId });
      expect(asked().filter((url) => url.startsWith('/search/'))).toHaveLength(1);
      expect(reads.map((row) => row.id)).toEqual([`plan:${planId}`]);
      expect(statuses()['U1']).toBe('delivered');
      const count = asked().length;
      await server.hosts.poll();
      expect(asked()).toHaveLength(count);
    },
  );

  it('refuses Refresh now for a plan that is not followed', () => {
    expect(() => server.hosts.refresh({ planId })).toThrow(CommandRejected);
    expect(asked()).toEqual([]);
  });

  it('reads the newest hosts.listFallbackCount pull requests on a host without search', async () => {
    host.search = false;
    set('hosts.listFallbackCount', 2);
    host.pulls = [
      merged,
      open,
      { ...open, number: 15, body: 'No unit line here.', branch: 'fix/typo', sha: 'd4d4d4d' },
    ];
    await follow();
    expect(asked().slice(0, 2)).toEqual([
      expect.stringMatching(/^\/search\/issues\?/),
      '/repos/acme/tea/pulls?state=all&sort=created&direction=desc&per_page=2',
    ]);
    // The two newest are #15 and #14; #12 is older than the count reaches.
    expect(requests().map((request) => request.number)).toEqual([14]);
    expect(statuses()).toMatchObject({ U1: 'ready', U2: 'claimed' });
    expect(asked().some((url) => url.includes('d4d4d4d'))).toBe(false);
  });

  it('treats a host without check runs and commit statuses as no checks', async () => {
    host.checks = false;
    await follow();
    expect(read()?.error).toBeNull();
    expect(requests().map((request) => [request.checkState, request.checks])).toEqual([
      ['none', []],
      ['none', []],
    ]);
  });

  it('leaves a host alone until its request limit starts again, except for Refresh now', async () => {
    const reset = now.getTime() / 1000 + 1800;
    host.limit = { remaining: 3, reset };
    await follow();
    expect(read()?.error).toBeNull();
    host.requests.length = 0;
    await server.hosts.poll();
    now = new Date(now.getTime() + 1799_000);
    await server.hosts.poll();
    expect(asked()).toEqual([]);
    await server.hosts.refresh({ planId });
    expect(asked().length).toBeGreaterThan(0);
    host.requests.length = 0;
    host.limit = { remaining: 4000, reset: reset + 3600 };
    now = new Date(now.getTime() + 2000);
    await server.hosts.poll();
    expect(asked().filter((url) => url.startsWith('/search/'))).toHaveLength(1);
  });
});

describe('a host that fails (spec 31, 32)', () => {
  it('keeps the last data with its time and the error when the host answers 500, and tries again next time', async () => {
    await follow();
    host.failure = { status: 500, message: 'Server Error' };
    now = new Date('2026-11-03T09:01:00.000Z');
    await server.hosts.poll();
    expect(read()).toMatchObject({
      changeRequestIds: ['tea:12', 'tea:14'],
      fetchedAt: '2026-11-03T09:00:00.000Z',
      error: {
        kind: 'failed',
        message: 'ghe.example.invalid answered 500: Server Error',
        setting: null,
        at: '2026-11-03T09:01:00.000Z',
      },
    });
    expect(statuses()).toMatchObject({ U1: 'delivered', U2: 'claimed', U3: 'ready' });
    expect(requests()).toHaveLength(2);

    host.failure = undefined;
    now = new Date('2026-11-03T09:02:00.000Z');
    await server.hosts.poll();
    expect(read()).toMatchObject({ fetchedAt: '2026-11-03T09:02:00.000Z', error: null });
  });

  it('keeps the last data when the host times out', async () => {
    await follow();
    reachable = false;
    now = new Date('2026-11-03T09:01:00.000Z');
    await server.hosts.poll();
    expect(read()).toMatchObject({
      fetchedAt: '2026-11-03T09:00:00.000Z',
      error: {
        kind: 'failed',
        message: 'ghe.example.invalid could not be reached: no answer within 30000 ms',
      },
    });
    expect(statuses()['U1']).toBe('delivered');
  });

  it('shows what the files say with the reason when the host was never reached', async () => {
    reachable = false;
    await follow();
    expect(statuses()).toMatchObject({ U1: 'unknown', U5: 'blocked' });
    expect(plan()?.units[0]?.statusReason).toBe(
      'ghe.example.invalid could not be reached: no answer within 30000 ms',
    );
    expect(read()).toMatchObject({ fetchedAt: null, changeRequestIds: [] });
  });

  it('names the host and the setting on 401, asks once, and never logs the token', async () => {
    onBranch('agent/U2-bell');
    startRun();
    await follow();
    host.token = 'another-token';
    host.requests.length = 0;
    await server.hosts.poll();
    const error = {
      kind: 'refused',
      message:
        'ghe.example.invalid refused the GitHub token (401: Bad credentials). Check the GitHub token in Settings → Trackers.',
      setting: 'trackers.github.token',
    };
    expect(read()?.error).toMatchObject(error);
    expect(read('run:r1')?.error).toMatchObject(error);
    // The first refusal ends the round; the run's pull request is not asked for.
    expect(asked()).toHaveLength(1);
    expect(host.requests.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(
      true,
    );
    expect(logged.some((line) => line.includes('host read failed'))).toBe(true);
    expect(logged.filter((line) => line.includes(TOKEN))).toEqual([]);
    expect(
      JSON.stringify([rows('hostReads'), rows('changeRequests'), rows('planIntents')]),
    ).not.toContain(TOKEN);
  });

  it('shows the refusal itself when the host names a wait that is no date', async () => {
    await follow();
    host.failure = { status: 403, message: 'Slow down' };
    host.retryAfter = '1e30';
    await server.hosts.poll();
    expect(read()?.error).toMatchObject({
      kind: 'refused',
      message: expect.stringContaining('ghe.example.invalid refused the GitHub token (403'),
    });
    // Nothing was learned about a wait, so the next round asks again.
    host.failure = undefined;
    host.retryAfter = undefined;
    await server.hosts.poll();
    expect(read()?.error).toBeNull();
  });

  it('says the repository cannot be seen when the host answers 404 for it', async () => {
    host.search = false;
    set('trackers.github.repo', 'private-tea');
    await follow();
    expect(read()?.error).toMatchObject({
      kind: 'refused',
      message: expect.stringContaining(
        'ghe.example.invalid does not show acme/private-tea to the GitHub token',
      ),
      setting: 'trackers.github.token',
    });
  });
});

describe('a host that answers what it should not', () => {
  const hostile = 'javascript:alert(document.domain)';

  it('leaves out a pull request whose link is not a web address', async () => {
    host.pulls = [merged, { ...open, url: hostile }];
    onBranch('agent/U2-bell');
    startRun();
    await follow();
    expect(requests().map((request) => request.number)).toEqual([12]);
    expect(read()).toMatchObject({ changeRequestIds: ['tea:12'], error: null });
    expect(read('run:r1')).toMatchObject({ changeRequestIds: [], error: null });
    expect(statuses()).toMatchObject({ U1: 'delivered', U2: 'ready' });
    expect(JSON.stringify(rows('changeRequests'))).not.toContain('javascript:');
  });

  it('leaves out a comment whose link is not a web address, is empty, or whose id is empty', async () => {
    const comment = { user: 'mira', body: 'Invented.', path: 'bell/ring.ts' };
    host.pulls = [
      merged,
      {
        ...open,
        comments: [
          { ...comment, id: 9001 },
          { ...comment, id: 9002, url: 'file:///C:/Windows/System32/calc.exe' },
          { ...comment, id: 9003, url: '' },
          { ...comment, id: '' },
          { ...comment, id: 9005, url: hostile },
        ],
      },
    ];
    await follow();
    const request = requests().find((row) => row.number === 14);
    expect(request?.comments.map((row) => row.id)).toEqual(['9001']);
    expect(request?.newestCommentId).toBe('9001');
    expect(read()?.error).toBeNull();
  });

  it('never stores a pull request the contract turns down, and says so for its plan only', async () => {
    onBranch('agent/U1-count-down');
    startRun();
    await follow();
    const github = createGitHubHost(
      { baseUrl: api, owner: 'acme', repo: 'tea', token: TOKEN, labels: [] },
      'ghe.example.invalid',
      { timeoutMs: 1000, listFallbackCount: 30, fetch: host.fetch(api) },
    );
    // An adapter that lets through what the contract does not allow: a comment without a link.
    const careless = new HostPoller({
      db: server.database.db,
      engine: server.engine,
      settings: server.settings,
      logger: server.logger,
      resolve: (projectId) => server.trackers.githubHost(projectId),
      clock: () => now,
      adapter: () => ({
        ...github,
        requests: 0,
        waitUntil: undefined,
        read: async (found) => {
          const row = await github.read(found);
          return {
            ...row,
            comments: row.comments.map((comment) => ({ ...comment, url: '' })),
          };
        },
      }),
    });
    now = new Date('2026-11-03T09:05:00.000Z');
    await careless.refresh();
    expect(requests().find((row) => row.number === 14)?.comments[0]?.url).toBe(
      'https://ghe.example.invalid/acme/tea/pull/14#discussion_r9001',
    );
    expect(read()).toMatchObject({
      changeRequestIds: ['tea:12', 'tea:14'],
      fetchedAt: '2026-11-03T09:00:00.000Z',
      error: {
        kind: 'failed',
        message:
          'ghe.example.invalid answered pull request #14 in a form wow cannot read (comments.0.url)',
        at: '2026-11-03T09:05:00.000Z',
      },
    });
    // The run's own pull request is fine and is read in the same round.
    expect(read('run:r1')).toMatchObject({
      changeRequestIds: ['tea:12'],
      fetchedAt: '2026-11-03T09:05:00.000Z',
      error: null,
    });
    expect(logged.some((line) => line.includes('cannot read'))).toBe(true);
  });
});
