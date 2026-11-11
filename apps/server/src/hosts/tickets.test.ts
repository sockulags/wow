import type { ProviderInstance, ServerCommand, TicketRead } from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '../core/subscriptions.js';
import { providerInstances } from '../db/schema.js';
import { startServer, type RunningServer } from '../server.js';
import { MockGitHub } from './mock-github.js';
import { MockJira, type MockIssue } from './mock-jira.js';

// U11 ground truth: the Jira ticket beside a run (review loop spec 33), what happens when Jira
// refuses or does not answer (spec 31 and 32), and which tickets a poll asks about (spec 29).
// Everything is invented: an Enterprise GitHub and a Jira Server that live in this file. Nothing
// sleeps: a round runs when the test calls it, and the clock is the test's.

const api = 'https://ghe.example.invalid/api/v3';
const jiraUrl = 'https://jira.example.invalid';
const GITHUB_TOKEN = 'ghp-invented-token-for-tests';
const JIRA_TOKEN = 'jira-invented-token-for-tests';

let root: string;
let server: RunningServer;
let github: MockGitHub;
let jira: MockJira;
let now: Date;
let logged: string[];
let ids = 0;

const dispatch = (command: ServerCommand) => server.engine.dispatch(`t${++ids}`, command);
const set = (key: string, value: unknown, scope = 'global') =>
  dispatch({ type: 'setting.set', key, scope, value });
const ticketRead = (runId = 'r1') =>
  (snapshot(server.database.db, { topic: 'ticketReads' }) as TicketRead[]).find(
    (row) => row.runId === runId,
  );
const jiraAsked = () => jira.requests.map((request) => request.path);

const issue: MockIssue = {
  key: 'ABC-12',
  summary: 'Fix the kettle whistle',
  status: 'In Progress',
  assignee: 'Mira Invented',
  type: 'Bug',
  description: 'h2. Steps\n# Fill the kettle\n# Wait for the *whistle*\n\nSee {{whistle.ts}}.',
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
async function startRun(runId = 'r1', backlogItemId?: string): Promise<void> {
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
  dispatch({
    type: 'workflowRun.start',
    runId,
    workflowId: 'gated',
    projectId: 'tea',
    ...(backlogItemId ? { backlogItemId } : {}),
  });
  await server.hosts.idle();
}

// The project folder as a repository on this branch, without a commit.
function onBranch(branch: string): void {
  execFileSync('git', ['-C', path.join(root, 'tea'), 'init', '--quiet', '-b', branch], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'none'), GIT_CONFIG_NOSYSTEM: '1' },
  });
}

// A backlog item published to Jira as `key`.
function publishedItem(key: string, id = 'b1'): string {
  dispatch({ type: 'backlog.create', backlogItemId: id, title: 'Whistle', body: '', tags: [] });
  dispatch({
    type: 'backlog.published',
    backlogItemId: id,
    remote: { service: 'jira', key, url: `${jiraUrl}/browse/${key}` },
  });
  return id;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-tickets-'));
  await mkdir(path.join(root, 'tea'), { recursive: true });
  await writeFile(path.join(root, 'tea', 'README.md'), 'Invented.\n');
  now = new Date('2026-11-03T09:00:00.000Z');
  logged = [];
  github = new MockGitHub({ owner: 'acme', repo: 'tea', webUrl: 'https://ghe.example.invalid' });
  github.token = GITHUB_TOKEN;
  jira = new MockJira();
  jira.authorization = `Bearer ${JIRA_TOKEN}`;
  jira.issues = [issue];
  const askGitHub = github.fetch(api);
  const askJira = jira.fetch(jiraUrl);
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
    hostTimers: { setTimeout: () => undefined, clearTimeout: () => undefined },
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.startsWith(jiraUrl) ? askJira(input, init) : askGitHub(input, init);
    },
  });
  dispatch({ type: 'project.create', projectId: 'tea', name: 'Tea', cwd: path.join(root, 'tea') });
  set('advanced.logLevel', 'debug');
  set('trackers.github.baseUrl', api);
  set('trackers.github.owner', 'acme');
  set('trackers.github.repo', 'tea');
  set(
    'trackers.github.token',
    await server.secrets.set('setting:trackers.github.token', GITHUB_TOKEN),
  );
  set('trackers.jira.baseUrl', jiraUrl);
  set('trackers.jira.authMode', 'pat');
  set('trackers.jira.token', await server.secrets.set('setting:trackers.jira.token', JIRA_TOKEN));
  set('trackers.jira.projectKey', 'ABC');
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('the Jira ticket beside a run (spec 33)', () => {
  it('shows the issue the run’s backlog item was published as', async () => {
    jira.issues = [{ ...issue, key: 'ABC-7', summary: 'From the backlog' }];
    await startRun('r1', publishedItem('ABC-7'));
    const read = ticketRead();
    expect(read).toMatchObject({
      id: 'run:r1',
      projectId: 'tea',
      host: 'jira',
      hostName: 'jira.example.invalid',
      key: 'ABC-7',
      source: 'backlog',
      fetchedAt: now.toISOString(),
      error: null,
    });
    expect(read?.ticket).toEqual({
      key: 'ABC-7',
      summary: 'From the backlog',
      status: 'In Progress',
      assignee: 'Mira Invented',
      type: 'Bug',
      description: '## Steps\n1. Fill the kettle\n1. Wait for the **whistle**\n\nSee `whistle.ts`.',
      url: `${jiraUrl}/browse/ABC-7`,
    });
    expect(jiraAsked()).toEqual([
      '/rest/api/2/issue/ABC-7?fields=summary,status,assignee,issuetype,description',
    ]);
  });

  it('prefers the backlog item’s issue over a key in the pull request title', async () => {
    onBranch('agent/whistle');
    github.pulls = [
      {
        number: 3,
        title: 'ABC-12 Fix it',
        body: '',
        state: 'open',
        branch: 'agent/whistle',
        sha: 'c3',
      },
    ];
    jira.issues = [issue, { ...issue, key: 'ABC-7' }];
    await startRun('r1', publishedItem('ABC-7'));
    expect(ticketRead()).toMatchObject({ key: 'ABC-7', source: 'backlog' });
  });

  it('finds the key in the title of the run’s pull request', async () => {
    onBranch('agent/whistle');
    github.pulls = [
      {
        number: 3,
        title: 'ABC-12 Fix it',
        body: '',
        state: 'open',
        branch: 'agent/whistle',
        sha: 'c3',
      },
    ];
    await startRun();
    expect(ticketRead()).toMatchObject({ key: 'ABC-12', source: 'pullRequest' });
    expect(ticketRead()?.ticket?.summary).toBe('Fix the kettle whistle');
  });

  it('finds the key in the name of the run’s branch, in any case', async () => {
    onBranch('abc-12-fix');
    await startRun();
    expect(ticketRead()).toMatchObject({ key: 'ABC-12', source: 'branch' });
    expect(ticketRead()?.ticket?.key).toBe('ABC-12');
  });

  it('does not take a key of another Jira project or inside a longer word', async () => {
    onBranch('xabc-12-and-def-4');
    await startRun();
    expect(ticketRead()).toMatchObject({ key: null, source: null, ticket: null });
  });

  it('says there is no ticket when nothing names one, without asking Jira', async () => {
    onBranch('agent/whistle');
    await startRun();
    expect(ticketRead()).toMatchObject({
      key: null,
      source: null,
      ticket: null,
      fetchedAt: now.toISOString(),
      error: null,
    });
    expect(jiraAsked()).toEqual([]);
  });

  it('shows wiki markup as readable markdown and runs none of it', async () => {
    jira.issues = [
      {
        ...issue,
        description:
          '{html}<script>alert(1)</script>{html}\n[click|javascript:alert(1)]\n<img src=x onerror=alert(1)>\n{code:js}\nlet a = 1;\n{code}',
      },
    ];
    onBranch('abc-12-fix');
    await startRun();
    const description = ticketRead()?.ticket?.description ?? '';
    expect(description).toContain('```js\nlet a = 1;\n```');
    // The javascript: link loses its target and keeps its words; HTML stays text for the
    // renderer, which never runs it.
    expect(description).toContain('click');
    expect(description).not.toContain('javascript:');
    expect(description).toContain('<img src=x onerror=alert(1)>');
  });

  it('says which settings are missing when Jira is not set up', async () => {
    dispatch({ type: 'setting.reset', key: 'trackers.jira.baseUrl', scope: 'global' });
    onBranch('abc-12-fix');
    await startRun();
    expect(ticketRead()?.error).toMatchObject({
      kind: 'notSetUp',
      setting: 'trackers.jira.baseUrl',
    });
    expect(ticketRead()?.error?.message).toContain('Jira URL');
    expect(jiraAsked()).toEqual([]);
  });
});

describe('when Jira refuses or does not answer (spec 31, 32)', () => {
  beforeEach(async () => {
    onBranch('abc-12-fix');
    await startRun();
    now = new Date('2026-11-03T09:10:00.000Z');
  });

  const lastFetched = '2026-11-03T09:00:00.000Z';

  it('keeps the last ticket and points to the token setting on 401, never showing the token', async () => {
    jira.authorization = 'Bearer another-token';
    await server.hosts.poll();
    const read = ticketRead();
    expect(read?.ticket?.summary).toBe('Fix the kettle whistle');
    expect(read?.fetchedAt).toBe(lastFetched);
    expect(read?.error).toMatchObject({ kind: 'refused', setting: 'trackers.jira.token' });
    expect(read?.error?.message).toContain('jira.example.invalid refused the Jira token');
    expect(JSON.stringify(read)).not.toContain(JIRA_TOKEN);
    expect(logged.join('\n')).not.toContain(JIRA_TOKEN);
  });

  it('keeps the last ticket and names the token setting on 404', async () => {
    jira.issues = [];
    await server.hosts.poll();
    expect(ticketRead()).toMatchObject({ fetchedAt: lastFetched, ticket: { key: 'ABC-12' } });
    expect(ticketRead()?.error).toMatchObject({ kind: 'refused', setting: 'trackers.jira.token' });
    expect(ticketRead()?.error?.message).toContain('shows no issue ABC-12');
  });

  it('keeps the last ticket on a timeout and tries again at the next interval', async () => {
    jira.slow = true;
    await server.hosts.poll();
    expect(ticketRead()).toMatchObject({ fetchedAt: lastFetched, ticket: { key: 'ABC-12' } });
    expect(ticketRead()?.error).toMatchObject({ kind: 'failed', at: now.toISOString() });
    expect(ticketRead()?.error?.message).toContain('no answer within');

    jira.slow = false;
    jira.issues = [{ ...issue, status: 'Done' }];
    now = new Date('2026-11-03T09:20:00.000Z');
    await server.hosts.poll();
    expect(ticketRead()).toMatchObject({
      fetchedAt: now.toISOString(),
      error: null,
      ticket: { status: 'Done' },
    });
  });

  it('keeps the time an error was first seen while it repeats', async () => {
    jira.failure = { status: 500, message: 'Invented outage' };
    await server.hosts.poll();
    const first = ticketRead()?.error?.at;
    now = new Date('2026-11-03T09:30:00.000Z');
    await server.hosts.poll();
    expect(ticketRead()?.error?.at).toBe(first);
    expect(ticketRead()?.error?.message).toContain('Invented outage');
  });
});

describe('which tickets a poll asks about (spec 29, 30)', () => {
  it('asks only about the tickets of live runs, once each', async () => {
    onBranch('abc-12-fix');
    await startRun('r1');
    await startRun('r2');
    jira.requests.length = 0;
    await server.hosts.poll();
    // Both runs are on the same branch: one ticket, one request.
    expect(jiraAsked()).toHaveLength(1);
    expect(ticketRead('r2')?.ticket?.key).toBe('ABC-12');

    dispatch({ type: 'workflowRun.stop', runId: 'r1' });
    dispatch({ type: 'workflowRun.stop', runId: 'r2' });
    await server.hosts.idle();
    jira.requests.length = 0;
    await server.hosts.poll();
    expect(jiraAsked()).toEqual([]);
    // A finished run keeps its last read.
    expect(ticketRead('r1')?.ticket?.key).toBe('ABC-12');
  });

  it('asks nothing while polling is off, and once on Refresh now', async () => {
    onBranch('abc-12-fix');
    set('hosts.polling', false);
    await startRun();
    expect(jiraAsked()).toEqual([]);
    await server.hosts.poll();
    expect(jiraAsked()).toEqual([]);
    await server.hosts.refresh({ runId: 'r1' });
    expect(jiraAsked()).toHaveLength(1);
    expect(ticketRead()?.ticket?.key).toBe('ABC-12');
  });

  it('sends the Jira token only to the Jira site', async () => {
    onBranch('abc-12-fix');
    await startRun();
    expect(jira.requests.every((request) => request.authorization === `Bearer ${JIRA_TOKEN}`)).toBe(
      true,
    );
    expect(github.requests.some((request) => request.authorization?.includes(JIRA_TOKEN))).toBe(
      false,
    );
  });
});
