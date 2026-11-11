import type {
  ChangeRequest,
  HostRead,
  PlanIntent,
  ProviderInstance,
  ServerCommand,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '../core/subscriptions.js';
import { providerInstances } from '../db/schema.js';
import { gitLabProjectOf, parseRemoteUrl } from '../projects/git.js';
import { startServer, type RunningServer } from '../server.js';
import { gitLabWhoAmI } from '../trackers/whoami.js';
import { HostFailure } from './adapter.js';
import { createGitLabHost } from './gitlab.js';
import { MockGitHub } from './mock-github.js';
import { MockGitLab, type MockMergeRequest } from './mock-gitlab.js';

// U12 ground truth: a project whose remote is on a GitLab host reads unit status, its run's merge
// request, pipelines as checks and notes as review comments from it (review loop spec 34), with
// spec 31 and 32 for GitLab. Everything is invented: a GitLab with nested groups that lives in
// this file. Nothing sleeps: a round runs when the test calls it, and the clock is the test's.

const site = 'https://gitlab.example.test';
const remote = 'git@gitlab.example.test:group/sub/app.git';
const projectPath = 'group/sub/app';
const encoded = 'group%2Fsub%2Fapp';
const TOKEN = 'glpat-invented-token-for-tests';
const GITHUB_TOKEN = 'ghp-invented-token-for-tests';
const intentId = '2026-01-tea-timer';
const planId = `tea:${intentId}`;

let root: string;
let server: RunningServer;
let gitlab: MockGitLab;
let github: MockGitHub;
let now: Date;
let logged: string[];
let timers: { callback: () => void; delayMs: number }[];
let reachable: boolean;
let ids = 0;

const dispatch = (command: ServerCommand) => server.engine.dispatch(`t${++ids}`, command);
const set = (key: string, value: unknown, scope = 'global') =>
  dispatch({ type: 'setting.set', key, scope, value });
const rows = <T>(topic: 'planIntents' | 'changeRequests' | 'hostReads') =>
  snapshot(server.database.db, { topic }) as T[];
const plan = () => rows<PlanIntent>('planIntents').find((row) => row.id === planId);
const read = (id = `plan:${planId}`) => rows<HostRead>('hostReads').find((row) => row.id === id);
const requests = () => rows<ChangeRequest>('changeRequests');
const statuses = () =>
  Object.fromEntries((plan()?.units ?? []).map((unit) => [unit.key, unit.status]));
const asked = () => gitlab.requests.map((request) => request.path);

const git = (...args: string[]) =>
  execFileSync('git', ['-C', path.join(root, 'tea'), ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'none'), GIT_CONFIG_NOSYSTEM: '1' },
  });

const planMd = [
  `---\nintent: ${intentId}\nrev: 1\nbuilt_on: spec@1\nstatus: accepted\nsource: files\n---\n`,
  '# Plan\n\n## Units\n',
  '- [U1] Count down',
  '- [U2] Ring the bell -- depends on U1',
  '- [U3] Show the time left -- depends on U1',
  '- [U4] Remember the last teas -- depends on U2',
  '- [U5] Pour by itself -- blocked: the pump is on order',
  '',
  ...['U1', 'U2', 'U3', 'U4', 'U5'].flatMap((key) => [`### ${key} Unit`, '', 'Outcome: done.', '']),
].join('\n');

const description = (...keys: string[]) =>
  ['Invented for the tests.', '', ...keys.map((key) => `Intent-Unit: ${intentId}/${key}`)].join(
    '\n',
  );

const merged: MockMergeRequest = {
  iid: 12,
  title: 'Count down from a chosen time',
  description: description('U1'),
  state: 'merged',
  mergedAt: '2026-11-01T10:00:00Z',
  branch: 'agent/U1-count-down',
  sha: 'a1a1a1a',
  pipeline: { id: 501, status: 'success', jobs: [{ name: 'test', status: 'success' }] },
};
const open: MockMergeRequest = {
  iid: 14,
  title: 'Ring the bell at zero',
  description: description('U2'),
  state: 'opened',
  draft: true,
  branch: 'agent/U2-bell',
  sha: 'b2b2b2b',
  pipeline: {
    id: 502,
    status: 'failed',
    jobs: [
      { name: 'lint', status: 'success' },
      { name: 'test:windows', status: 'failed' },
      { name: 'test:flaky', status: 'failed', allowFailure: true },
      { name: 'deploy:review', status: 'manual' },
      { name: 'e2e', status: 'running' },
    ],
  },
  notes: [
    { id: 8001, author: 'gitlab-bot', body: 'added 1 commit', system: true },
    { id: 8002, author: 'mira', body: 'The bell rings twice here.', path: 'bell/ring.ts' },
    { id: 8005, author: 'jon', body: 'Name the unit.' },
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
async function startRun(runId = 'r1'): Promise<void> {
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
  dispatch({ type: 'workflowRun.start', runId, workflowId: 'gated', projectId: 'tea' });
  await server.hosts.idle();
}

const follow = async () => {
  dispatch({ type: 'plan.follow', planId, followed: true });
  await server.hosts.idle();
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-gitlab-'));
  const folder = path.join(root, 'tea', 'intents', intentId);
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, 'intent.md'),
    `---\nid: ${intentId}\nstatus: accepted\nrev: 1\nsupersedes: null\n---\n\n# A tea timer\n`,
  );
  await writeFile(
    path.join(folder, 'spec.md'),
    `---\nintent: ${intentId}\nrev: 1\nbuilt_on: intent@1\nstatus: accepted\n---\n\n# Spec\n`,
  );
  await writeFile(path.join(folder, 'plan.md'), planMd);
  git('init', '--quiet', '-b', 'agent/U2-bell');
  git('remote', 'add', 'origin', remote);
  now = new Date('2026-11-03T09:00:00.000Z');
  logged = [];
  timers = [];
  reachable = true;
  gitlab = new MockGitLab({ projectPath, webUrl: site });
  gitlab.token = TOKEN;
  gitlab.mergeRequests = [merged, open];
  // A GitHub with the shared token set up too: a project on the GitLab host must not ask it.
  github = new MockGitHub({ owner: 'acme', repo: 'tea', webUrl: 'https://ghe.example.invalid' });
  const askGitLab = gitlab.fetch(site);
  const askGitHub = github.fetch('https://ghe.example.invalid/api/v3');
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
    fetch: (input, init) => {
      if (!reachable) {
        return Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
      }
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.startsWith(site) ? askGitLab(input, init) : askGitHub(input, init);
    },
  });
  dispatch({ type: 'project.create', projectId: 'tea', name: 'Tea', cwd: path.join(root, 'tea') });
  set('advanced.logLevel', 'debug');
  set('trackers.github.baseUrl', 'https://ghe.example.invalid/api/v3');
  set(
    'trackers.github.token',
    await server.secrets.set('setting:trackers.github.token', GITHUB_TOKEN),
  );
  set('trackers.gitlab.baseUrl', site);
  set('trackers.gitlab.token', await server.secrets.set('setting:trackers.gitlab.token', TOKEN));
  await server.plans.refresh();
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('a project on a GitLab host (spec 34)', () => {
  it('resolves a remote on the GitLab host to that host and the whole project path', async () => {
    expect(gitLabProjectOf(parseRemoteUrl('origin', remote), site)).toEqual({
      host: 'gitlab.example.test',
      path: projectPath,
    });
    expect(
      gitLabProjectOf(
        parseRemoteUrl('origin', 'ssh://git@gitlab.example.test:2222/group/sub/app.git'),
        site,
      ),
    ).toEqual({ host: 'gitlab.example.test', path: projectPath });
    // A site under a sub-path: its https remotes carry the prefix, which is not the project's.
    expect(
      gitLabProjectOf(
        parseRemoteUrl('origin', 'https://example.test/gitlab/group/app.git'),
        'https://example.test/gitlab',
      ),
    ).toEqual({ host: 'example.test', path: 'group/app' });
    // Paths on the site compare without case, like its host name.
    expect(
      gitLabProjectOf(
        parseRemoteUrl('origin', 'https://example.test/GitLab/group/app.git'),
        'https://example.test/gitlab',
      ),
    ).toEqual({ host: 'example.test', path: 'group/app' });
    // Another host, or no GitLab site stored: not GitLab, whatever the remote looks like.
    expect(gitLabProjectOf(parseRemoteUrl('origin', remote), 'https://gitlab.other.test')).toBe(
      null,
    );
    expect(gitLabProjectOf(parseRemoteUrl('origin', remote), '')).toBe(null);
    expect(gitLabProjectOf(parseRemoteUrl('origin', 'git@gitlab.example.test:app.git'), site)).toBe(
      null,
    );

    const trackers = await server.trackers.projectTrackers('tea');
    expect(trackers.gitlab).toEqual({ host: 'gitlab.example.test', path: projectPath });
    expect(trackers.settings.find((entry) => entry.key === 'trackers.gitlab.baseUrl')).toEqual({
      key: 'trackers.gitlab.baseUrl',
      value: site,
      source: 'global',
    });
    // The remote is GitLab's, so it names no GitHub repository.
    expect(
      trackers.settings.filter((entry) => entry.source === 'gitRemote').map((entry) => entry.key),
    ).toEqual([]);
    expect(await server.trackers.gitlabHost('tea')).toEqual({
      gitlab: { config: { baseUrl: site, token: TOKEN, projectPath }, missing: [] },
      name: 'gitlab.example.test',
      branch: 'agent/U2-bell',
    });
  });

  it('shows unit status from merged and open merge requests carrying Intent-Unit lines', async () => {
    await follow();
    expect(statuses()).toEqual({
      U1: 'delivered',
      U2: 'claimed',
      U3: 'ready',
      U4: 'waiting',
      U5: 'blocked',
    });
    expect(plan()?.units.map((unit) => unit.statusReason)).toEqual([
      'Merge request !12 is merged',
      'Merge request !14 is open',
      'Every dependency is delivered',
      'Waits for U2',
      'the pump is on order',
    ]);
    expect(read()).toMatchObject({
      host: 'gitlab',
      hostName: 'gitlab.example.test',
      changeRequestIds: ['tea:14', 'tea:12'],
      error: null,
    });
    // One search, the nested path as one encoded id, and GitHub never asked.
    const searches = asked().filter((request) => request.includes('search='));
    expect(searches).toEqual([
      `/projects/${encoded}/merge_requests?state=all&search=${encodeURIComponent(`${intentId}/`)}&in=description&order_by=created_at&sort=desc&per_page=100`,
    ]);
    expect(asked().every((request) => request.startsWith(`/projects/${encoded}/`))).toBe(true);
    expect(github.requests).toEqual([]);
    expect(gitlab.requests.every((request) => request.token === TOKEN)).toBe(true);
  });

  it('finds a merge request whose line is in bold, underscores or quote marks', async () => {
    gitlab.mergeRequests = [
      { ...merged, description: `**Intent-Unit:** ${intentId}/U1` },
      { ...open, description: `__Intent-Unit__: \`${intentId}/U2\`.` },
      { ...open, iid: 16, branch: 'agent/U3-time', description: `Intent-Unit: "${intentId}/U3"` },
      {
        ...open,
        iid: 18,
        branch: 'agent/notes',
        description: `Notes on ${intentId}/U4, no claim.`,
      },
    ];
    await follow();
    expect(asked().some((request) => request.includes('search='))).toBe(true);
    expect(statuses()).toEqual({
      U1: 'delivered',
      U2: 'claimed',
      U3: 'claimed',
      U4: 'waiting',
      U5: 'blocked',
    });
  });

  it('reads the newest merge requests when the host turns the search down', async () => {
    gitlab.search = false;
    set('hosts.listFallbackCount', 5);
    await follow();
    expect(statuses()).toMatchObject({ U1: 'delivered', U2: 'claimed' });
    expect(asked()).toContain(
      `/projects/${encoded}/merge_requests?state=all&order_by=created_at&sort=desc&per_page=5`,
    );
  });

  it('shows the run’s merge request with the failing job names and the notes', async () => {
    await startRun();
    expect(read('run:r1')).toMatchObject({
      host: 'gitlab',
      branch: 'agent/U2-bell',
      changeRequestIds: ['tea:14'],
      error: null,
    });
    const request = requests().find((row) => row.id === 'tea:14');
    expect(request).toMatchObject({
      host: 'gitlab',
      number: 14,
      url: `${site}/${projectPath}/-/merge_requests/14`,
      state: 'open',
      draft: true,
      headBranch: 'agent/U2-bell',
      headSha: 'b2b2b2b',
      checkState: 'failure',
      newestCommentId: '8005',
    });
    // The manual job did not run and the allowed failure fails nothing.
    expect(request?.checks).toEqual([
      { name: 'lint', state: 'success', url: `${site}/${projectPath}/-/jobs/50200` },
      { name: 'test:windows', state: 'failure', url: `${site}/${projectPath}/-/jobs/50201` },
      { name: 'test:flaky', state: 'success', url: `${site}/${projectPath}/-/jobs/50202` },
      { name: 'e2e', state: 'pending', url: `${site}/${projectPath}/-/jobs/50204` },
    ]);
    // GitLab's own system note is not a review comment.
    expect(request?.comments).toEqual([
      {
        id: '8005',
        author: 'jon',
        body: 'Name the unit.',
        path: null,
        url: `${site}/${projectPath}/-/merge_requests/14#note_8005`,
        createdAt: '2026-11-03T08:15:00.000Z',
      },
      {
        id: '8002',
        author: 'mira',
        body: 'The bell rings twice here.',
        path: 'bell/ring.ts',
        url: `${site}/${projectPath}/-/merge_requests/14#note_8002`,
        createdAt: '2026-11-03T08:15:00.000Z',
      },
    ]);
    expect(asked()).toContain(
      `/projects/${encoded}/merge_requests?state=all&source_branch=agent%2FU2-bell&order_by=created_at&sort=desc&per_page=1`,
    );
  });

  it('says GitLab is not set up and which setting is missing, and asks nothing', async () => {
    dispatch({ type: 'setting.reset', key: 'trackers.gitlab.token', scope: 'global' });
    await follow();
    expect(read()?.error).toMatchObject({
      kind: 'notSetUp',
      setting: 'trackers.gitlab.token',
      message:
        "GitLab is not set up for this project: fill in GitLab token in Settings → Trackers or in the project's own trackers",
    });
    expect(asked()).toEqual([]);
    expect(github.requests).toEqual([]);
  });

  it('reads from GitHub as before when the remote is not on the GitLab site', async () => {
    set('trackers.gitlab.baseUrl', 'https://gitlab.other.test');
    expect(await server.trackers.gitlabHost('tea')).toBeUndefined();
    await follow();
    expect(read()?.host).toBe('github');
    expect(asked()).toEqual([]);
  });
});

describe('GitLab refusing or not answering (spec 31, 32)', () => {
  it('names the GitLab token on 401 and never shows or logs the token', async () => {
    gitlab.token = 'glpat-another-token';
    await follow();
    expect(read()?.error).toMatchObject({
      kind: 'refused',
      setting: 'trackers.gitlab.token',
      message:
        'gitlab.example.test refused the GitLab token (401: 401 Unauthorized). Check the GitLab token in Settings → Trackers.',
    });
    expect(JSON.stringify(rows('hostReads'))).not.toContain(TOKEN);
    expect(logged.join('\n')).not.toContain(TOKEN);
    expect(logged.some((line) => line.includes('host read failed'))).toBe(true);
  });

  it('names the GitLab token when the project is not visible to it', async () => {
    gitlab.failure = { status: 404, message: '404 Project Not Found' };
    await follow();
    expect(read()?.error).toMatchObject({
      kind: 'refused',
      setting: 'trackers.gitlab.token',
      message: expect.stringContaining(`does not show ${projectPath} to the GitLab token`),
    });
  });

  it('keeps the last data and its time beside a timeout, and tries again at the next interval', async () => {
    await follow();
    const fetched = read()?.fetchedAt;
    reachable = false;
    now = new Date('2026-11-03T09:05:00.000Z');
    await server.hosts.poll();
    expect(read()).toMatchObject({
      fetchedAt: fetched,
      changeRequestIds: ['tea:14', 'tea:12'],
      error: {
        kind: 'failed',
        message: 'gitlab.example.test could not be reached: no answer within 30000 ms',
      },
    });
    expect(statuses()).toMatchObject({ U1: 'delivered', U2: 'claimed' });
    reachable = true;
    now = new Date('2026-11-03T09:10:00.000Z');
    await server.hosts.poll();
    expect(read()).toMatchObject({ fetchedAt: '2026-11-03T09:10:00.000Z', error: null });
  });

  it('leaves the host alone after a 429 with Retry-After until the wait is over', async () => {
    await follow();
    gitlab.failure = { status: 429, message: 'Retry later' };
    gitlab.retryAfter = '600';
    now = new Date('2026-11-03T09:05:00.000Z');
    await server.hosts.poll();
    expect(read()?.error?.message).toContain('request limit is used up');
    gitlab.failure = undefined;
    gitlab.retryAfter = undefined;
    const before = gitlab.requests.length;
    now = new Date('2026-11-03T09:10:00.000Z');
    await server.hosts.poll();
    expect(gitlab.requests.length).toBe(before);
    now = new Date('2026-11-03T09:16:00.000Z');
    await server.hosts.poll();
    expect(read()?.error).toBeNull();
  });
});

describe('Test connection to GitLab', () => {
  it('shows the account and the host version with a good token', async () => {
    expect(await server.trackers.test('gitlab', 'tea')).toEqual({
      service: 'gitlab',
      ok: true,
      account: 'Mira Invented @mira',
      version: '17.5.2',
      message: 'Signed in as Mira Invented @mira on GitLab 17.5.2.',
      missing: [],
    });
    // It also asks for the project, so a token that cannot read it fails here and not later.
    expect(asked()).toEqual(['/user', '/version', `/projects/${encoded}`]);
  });

  it('shows the host’s message with a bad token', async () => {
    gitlab.token = 'glpat-another-token';
    expect(await server.trackers.test('gitlab')).toMatchObject({
      ok: false,
      account: null,
      version: null,
      message: 'GitLab answered 401: 401 Unauthorized',
    });
  });

  it('names what is missing before it sends anything', async () => {
    dispatch({ type: 'setting.reset', key: 'trackers.gitlab.baseUrl', scope: 'global' });
    expect(await server.trackers.test('gitlab')).toMatchObject({
      ok: false,
      missing: ['trackers.gitlab.baseUrl'],
      message: 'Fill in GitLab URL first.',
    });
    expect(asked()).toEqual([]);
  });
});

describe('the pipeline’s own status (spec 34)', () => {
  const host = (pipeline: MockMergeRequest['pipeline']) => {
    const mock = new MockGitLab({ projectPath, webUrl: site });
    mock.mergeRequests = [{ ...open, ...(pipeline ? { pipeline } : {}) }];
    return createGitLabHost({ baseUrl: site, token: TOKEN, projectPath }, 'gitlab.example.test', {
      timeoutMs: 1000,
      listFallbackCount: 5,
      fetch: mock.fetch(site),
    });
  };
  const checksOf = async (pipeline: MockMergeRequest['pipeline']) => {
    const adapter = host(pipeline);
    const found = await adapter.findForBranch('agent/U2-bell');
    if (!found) throw new Error('no merge request');
    const { checkState, checks } = await adapter.read(found);
    return { checkState, checks };
  };
  const pipelineUrl = `${site}/${projectPath}/-/pipelines/503`;

  it('fails when the pipeline failed outside the listed jobs (a child pipeline)', async () => {
    expect(
      await checksOf({ id: 503, status: 'failed', jobs: [{ name: 'lint', status: 'success' }] }),
    ).toEqual({
      checkState: 'failure',
      checks: [
        { name: 'lint', state: 'success', url: `${site}/${projectPath}/-/jobs/50300` },
        { name: 'pipeline 503', state: 'failure', url: pipelineUrl },
      ],
    });
  });

  it('stays pending while the pipeline still runs', async () => {
    const { checkState, checks } = await checksOf({
      id: 503,
      status: 'running',
      jobs: [{ name: 'lint', status: 'success' }],
    });
    expect(checkState).toBe('pending');
    expect(checks.at(-1)).toEqual({ name: 'pipeline 503', state: 'pending', url: pipelineUrl });
  });
});

describe('a GitLab site that redirects', () => {
  let servers: Server[];
  let elsewhere: IncomingHttpHeaders[];

  const listen = async (listener: Server) => {
    servers.push(listener);
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    return `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  };

  beforeEach(() => {
    servers = [];
    elsewhere = [];
  });
  afterEach(async () => {
    await Promise.all(
      servers.map((each) => new Promise((resolve) => each.close(() => resolve(undefined)))),
    );
  });

  it('sends the token to no other address and says to check the URL', async () => {
    const other = await listen(
      createServer((request, response) => {
        elsewhere.push(request.headers);
        response.writeHead(200, { 'content-type': 'application/json' }).end('[]');
      }),
    );
    const gitlabSite = await listen(
      createServer((request, response) => {
        response.writeHead(302, { location: `${other}${request.url ?? '/'}` }).end();
      }),
    );
    const config = { baseUrl: gitlabSite, token: TOKEN, projectPath };
    const adapter = createGitLabHost(config, 'gitlab.example.test', {
      timeoutMs: 5000,
      listFallbackCount: 5,
    });
    const failed = await adapter.findForBranch('agent/U2-bell').catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(HostFailure);
    expect(failed).toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('gitlab.example.test redirected to another address (302)'),
    });
    await expect(gitLabWhoAmI(config, { timeoutMs: 5000 })).rejects.toThrow(
      'GitLab redirected to another address (302)',
    );
    expect(elsewhere).toEqual([]);
  });
});
