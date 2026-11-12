import {
  bareHostRefs,
  type HostItemRead,
  type HostLookupParams,
  type ProviderCommand,
  type ProviderInstance,
  type ServerCommand,
} from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '../core/subscriptions.js';
import { providerInstances } from '../db/schema.js';
import { MockProviderAdapter } from '../hooks/index.js';
import { startServer, type RunningServer } from '../server.js';
import { MockConfluence } from './mock-confluence.js';
import { MockGitHub } from './mock-github.js';
import { MockGitLab } from './mock-gitlab.js';
import { MockJira } from './mock-jira.js';

// U7 ground truth (agent workbench spec 20 to 26): links in a chat to the user's own hosts,
// looked up and read through `hosts.lookup` against the mock GitHub, GitLab, Jira and
// Confluence that live in this file. Everything is invented. Nothing sleeps: a read happens when
// the test asks for it.

const api = 'https://ghe.example.invalid/api/v3';
const web = 'https://ghe.example.invalid';
const gitlabUrl = 'https://gitlab.example.invalid';
const jiraUrl = 'https://jira.example.invalid';
const wikiUrl = 'https://wiki.example.invalid';
const GITHUB_TOKEN = 'ghp-invented-token-for-links';
const GITLAB_TOKEN = 'glpat-invented-token-for-links';
const JIRA_TOKEN = 'jira-invented-token-for-links';
const WIKI_TOKEN = 'wiki-invented-token-for-links';

let root: string;
let server: RunningServer;
let github: MockGitHub;
let gitlab: MockGitLab;
let jira: MockJira;
let wiki: MockConfluence;
let elsewhere: string[];
let now: Date;
let ids = 0;
let started: (command: Extract<ProviderCommand, { type: 'startTurn' }>) => void;

const dispatch = (command: ServerCommand) => server.engine.dispatch(`l${++ids}`, command);
const set = (key: string, value: unknown, scope = 'global') =>
  dispatch({ type: 'setting.set', key, scope, value });
const lookup = (params: HostLookupParams) => server.hostLookup.lookup(params);
const stored = (threadId: string) =>
  snapshot(server.database.db, { topic: 'hostItemReads', threadId }) as HostItemRead[];

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

const thread = (threadId: string, projectId: string | null, cwd: string) =>
  dispatch({
    type: 'thread.create',
    threadId,
    providerInstanceId: instance.id,
    ...(projectId ? { projectId } : {}),
    cwd,
    model: 'opus',
    effort: 'high',
    permissionMode: 'default',
  });

function gitRepo(folder: string, remote?: string): void {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: path.join(root, 'none'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  execFileSync('git', ['-C', folder, 'init', '--quiet', '-b', 'main'], { env });
  if (remote) execFileSync('git', ['-C', folder, 'remote', 'add', 'origin', remote], { env });
}

const sentWith = (asked: { authorization?: string | null; token?: string | null }[]) =>
  new Set(asked.map((request) => request.authorization ?? request.token ?? null));

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-links-'));
  for (const name of ['tea', 'field', 'loose']) {
    await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, name, 'README.md'), 'Invented.\n');
  }
  gitRepo(path.join(root, 'field'), 'git@gitlab.example.invalid:tea/field.git');
  now = new Date('2026-11-12T09:00:00.000Z');
  elsewhere = [];
  started = () => undefined;

  github = new MockGitHub({ owner: 'acme', repo: 'tea', webUrl: web });
  github.token = GITHUB_TOKEN;
  github.pulls = [
    {
      number: 14,
      title: 'Water the beds every morning',
      body: 'Invented.',
      state: 'open',
      draft: true,
      branch: 'agent/water',
      sha: 'b2b2b2',
      checkRuns: [
        { name: 'test', status: 'completed', conclusion: 'failure' },
        { name: 'lint', status: 'completed', conclusion: 'failure' },
      ],
      comments: [{ id: 9001, user: 'mira', body: 'The beds flood.', path: 'src/water.ts' }],
    },
  ];
  github.issues = [
    {
      number: 3,
      title: 'The kettle whistles too early',
      body: 'Steps: fill it, wait for the **whistle**.',
      state: 'open',
      user: 'jon',
      labels: ['bug'],
      comments: [{ id: 51, user: 'mira', body: 'Seen it twice.' }],
    },
  ];
  gitlab = new MockGitLab({ projectPath: 'tea/field', webUrl: gitlabUrl });
  gitlab.token = GITLAB_TOKEN;
  gitlab.mergeRequests = [
    {
      iid: 7,
      title: 'Plough the field',
      description: 'Invented.',
      state: 'opened',
      branch: 'agent/plough',
      sha: 'c3c3c3',
      pipeline: { id: 301, status: 'success', jobs: [{ name: 'test', status: 'success' }] },
    },
  ];
  gitlab.issues = [
    {
      iid: 4,
      title: 'Weeds grow back',
      description: 'By *Friday*.',
      state: 'closed',
      author: 'mira',
      notes: [{ id: 801, author: 'jon', body: 'Pulled them again.' }],
    },
  ];
  jira = new MockJira();
  jira.authorization = `Bearer ${JIRA_TOKEN}`;
  jira.issues = [
    {
      key: 'ABC-42',
      summary: 'Water on a schedule',
      status: 'To Do',
      assignee: null,
      type: 'Story',
      description: 'h2. Why\nThe beds dry out.',
    },
  ];
  wiki = new MockConfluence();
  wiki.authorization = `Bearer ${WIKI_TOKEN}`;
  wiki.pages = [
    { id: '123', title: 'Watering schedule', space: 'ENG', version: 3, body: '<p>At five.</p>' },
  ];
  const routes: [string, typeof fetch][] = [
    [api, github.fetch(api)],
    [gitlabUrl, gitlab.fetch(gitlabUrl)],
    [jiraUrl, jira.fetch(jiraUrl)],
    [wikiUrl, wiki.fetch(wikiUrl)],
  ];
  server = await startServer({
    home: path.join(root, '.wow'),
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: root,
    watchSkills: () => ({ close: () => Promise.resolve() }),
    watchPlans: () => ({ close: () => Promise.resolve() }),
    clock: () => now,
    schedulerTimers: { setTimeout: () => undefined, clearTimeout: () => undefined },
    hostTimers: { setTimeout: () => undefined, clearTimeout: () => undefined },
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const route = routes.find(([base]) => url.startsWith(`${base}/`));
      if (route) return route[1](input, init);
      elsewhere.push(url);
      return Promise.reject(new TypeError('fetch failed'));
    },
    hooks: {
      providers: {
        claude: (row) =>
          new MockProviderAdapter(row.kind, (command) => {
            if (command.type !== 'startTurn') return [];
            started(command);
            return [{ type: 'turnCompleted', threadId: command.threadId }];
          }),
      },
    },
  });
  server.database.db.insert(providerInstances).values(instance).run();
  dispatch({ type: 'project.create', projectId: 'tea', name: 'Tea', cwd: path.join(root, 'tea') });
  dispatch({
    type: 'project.create',
    projectId: 'field',
    name: 'Field',
    cwd: path.join(root, 'field'),
  });
  set('trackers.github.baseUrl', api);
  set('trackers.github.owner', 'acme', 'project:tea');
  set('trackers.github.repo', 'tea', 'project:tea');
  set(
    'trackers.github.token',
    await server.secrets.set('setting:trackers.github.token', GITHUB_TOKEN),
  );
  set('trackers.gitlab.baseUrl', gitlabUrl);
  set(
    'trackers.gitlab.token',
    await server.secrets.set('setting:trackers.gitlab.token', GITLAB_TOKEN),
  );
  set('trackers.jira.baseUrl', jiraUrl);
  set('trackers.jira.authMode', 'pat');
  set('trackers.jira.token', await server.secrets.set('setting:trackers.jira.token', JIRA_TOKEN));
  set('trackers.jira.projectKey', 'ABC');
  set('trackers.confluence.baseUrl', wikiUrl);
  set('trackers.confluence.authMode', 'pat');
  set(
    'trackers.confluence.token',
    await server.secrets.set('setting:trackers.confluence.token', WIKI_TOKEN),
  );
  thread('t-tea', 'tea', path.join(root, 'tea'));
  thread('t-field', 'field', path.join(root, 'field'));
  thread('t-loose', null, path.join(root, 'loose'));
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

const readData = async (threadId: string, ref: string) =>
  (await lookup({ threadId, ref, read: 'open' })).read?.data;

const asked = () =>
  github.requests.length + gitlab.requests.length + jira.requests.length + wiki.requests.length;

describe('host links in chat (agent workbench spec 20 to 26)', () => {
  it('recognises a link to each host with a token, and asks none of them while doing so (spec 20)', async () => {
    const links = [
      [`${web}/acme/tea/pull/14`, 'github', 'changeRequest', '14'],
      [`${web}/acme/tea/issues/3`, 'github', 'issue', '3'],
      [`${gitlabUrl}/tea/field/-/merge_requests/7`, 'gitlab', 'changeRequest', '7'],
      [`${gitlabUrl}/tea/field/-/issues/4`, 'gitlab', 'issue', '4'],
      [`${jiraUrl}/browse/ABC-42`, 'jira', 'ticket', 'ABC-42'],
      [`${wikiUrl}/pages/viewpage.action?pageId=123`, 'confluence', 'page', 'id:123'],
    ] as const;
    for (const [ref, host, kind, id] of links) {
      const { item, read } = await lookup({ threadId: 't-tea', ref });
      expect({ ref, ...item }).toMatchObject({ ref, host, kind, id });
      expect(read).toBeNull();
    }
    const { rules } = await lookup({ threadId: 't-tea' });
    expect(rules.sites.map((site) => [site.host, site.base])).toEqual([
      ['github', web],
      ['gitlab', gitlabUrl],
      ['jira', jiraUrl],
      ['confluence', wikiUrl],
    ]);
    expect(asked()).toBe(0);
  });

  it('reads a pull request when its tab opens, once, and again only on Refresh now; nothing polls it (spec 21, 22)', async () => {
    const ref = `${web}/acme/tea/pull/14`;
    const first = await lookup({ threadId: 't-tea', ref, read: 'open' });
    expect(first.read).toMatchObject({
      id: expect.stringMatching(/^thread:t-tea:/),
      scope: 'thread',
      threadId: 't-tea',
      hostName: 'ghe.example.invalid',
      fetchedAt: now.toISOString(),
      error: null,
    });
    const data = first.read?.data;
    expect(data?.kind).toBe('changeRequest');
    if (data?.kind !== 'changeRequest') return;
    expect(data.changeRequest).toMatchObject({
      number: 14,
      draft: true,
      state: 'open',
      checkState: 'failure',
    });
    expect(data.changeRequest.checks).toHaveLength(2);
    expect(data.changeRequest.comments.map((comment) => comment.body)).toEqual(['The beds flood.']);
    const once = github.requests.length;
    expect(once).toBeGreaterThan(0);

    // Opened again (another chip, a reload, a restart): the stored read, the host not asked.
    now = new Date('2026-11-12T10:00:00.000Z');
    const again = await lookup({ threadId: 't-tea', ref, read: 'open' });
    expect(again.read?.fetchedAt).toBe('2026-11-12T09:00:00.000Z');
    expect(github.requests.length).toBe(once);
    expect(stored('t-tea')).toEqual([again.read]);

    // The poller has nothing of the thread's to read.
    await server.hosts.poll();
    expect(github.requests.length).toBe(once);

    const refreshed = await lookup({ threadId: 't-tea', ref, read: 'refresh' });
    expect(github.requests.length).toBe(once * 2);
    expect(refreshed.read?.fetchedAt).toBe(now.toISOString());
    expect(stored('t-tea')).toHaveLength(1);
  });

  it('reads issues on GitHub and GitLab, a merge request, a Jira ticket and a Confluence page (spec 21)', async () => {
    expect(await readData('t-tea', `${web}/acme/tea/issues/3`)).toEqual({
      kind: 'issue',
      issue: {
        host: 'github',
        number: 3,
        title: 'The kettle whistles too early',
        state: 'open',
        author: 'jon',
        labels: ['bug'],
        body: 'Steps: fill it, wait for the **whistle**.',
        url: `${web}/acme/tea/issues/3`,
        comments: [
          {
            id: '51',
            author: 'mira',
            body: 'Seen it twice.',
            path: null,
            url: `${web}/acme/tea/issues/3#issuecomment-51`,
            createdAt: '2026-11-03T08:20:00.000Z',
          },
        ],
      },
    });
    // A bare #14 on GitHub turns out to be the pull request.
    expect((await readData('t-tea', '#14'))?.kind).toBe('changeRequest');
    expect(await readData('t-field', '!7')).toMatchObject({
      kind: 'changeRequest',
      changeRequest: { host: 'gitlab', number: 7, checkState: 'success' },
    });
    expect(await readData('t-field', '#4')).toMatchObject({
      kind: 'issue',
      issue: {
        host: 'gitlab',
        number: 4,
        state: 'closed',
        body: 'By *Friday*.',
        comments: [{ author: 'jon', body: 'Pulled them again.' }],
      },
    });
    expect(await readData('t-tea', 'ABC-42')).toMatchObject({
      kind: 'ticket',
      ticket: { key: 'ABC-42', status: 'To Do', description: '## Why\nThe beds dry out.' },
    });
    expect(await readData('t-tea', `${wikiUrl}/pages/viewpage.action?pageId=123`)).toMatchObject({
      kind: 'page',
      page: { id: '123', title: 'Watering schedule', body: '<p>At five.</p>' },
    });
    expect(gitlab.requests.map((request) => request.path)).toContain(
      '/projects/tea%2Ffield/issues/4/notes?sort=desc&order_by=created_at&per_page=100',
    );
  });

  it('leaves a link to a host without a token or of another site plain, and sends each token only to its own host (spec 23)', async () => {
    const plain = [
      'https://github.com/acme/tea/pull/14',
      'https://gitlab.com/tea/field/-/merge_requests/7',
      `${web}/acme/tea/commit/b2b2b2`,
      `https://me:secret@ghe.example.invalid/acme/tea/pull/14`,
      `${jiraUrl}.evil.invalid/browse/ABC-42`,
      'javascript:alert(1)',
    ];
    for (const ref of plain) {
      const result = await lookup({ threadId: 't-tea', ref, read: 'open' });
      expect({ ref, item: result.item }).toEqual({ ref, item: null });
    }
    expect(asked()).toBe(0);
    expect(elsewhere).toEqual([]);

    // Without its token GitLab is no site of the thread's: its links stay plain.
    dispatch({ type: 'setting.reset', key: 'trackers.gitlab.token', scope: 'global' });
    const gone = await lookup({
      threadId: 't-field',
      ref: `${gitlabUrl}/tea/field/-/merge_requests/7`,
      read: 'open',
    });
    expect(gone.item).toBeNull();
    expect(gone.rules.sites.map((site) => site.host)).not.toContain('gitlab');
    expect(gitlab.requests).toEqual([]);

    await lookup({ threadId: 't-tea', ref: `${web}/acme/tea/pull/14`, read: 'open' });
    await lookup({ threadId: 't-tea', ref: 'ABC-42', read: 'open' });
    await lookup({
      threadId: 't-tea',
      ref: `${wikiUrl}/display/ENG/Watering+schedule`,
      read: 'open',
    });
    expect(sentWith(github.requests)).toEqual(new Set([`Bearer ${GITHUB_TOKEN}`]));
    expect(sentWith(jira.requests)).toEqual(new Set([`Bearer ${JIRA_TOKEN}`]));
    expect(sentWith(wiki.requests)).toEqual(new Set([`Bearer ${WIKI_TOKEN}`]));
    expect(elsewhere).toEqual([]);
  });

  it('shows a refused read with the host’s reason and keeps the last data and its time (spec 23)', async () => {
    const ref = `${web}/acme/tea/issues/3`;
    await lookup({ threadId: 't-tea', ref, read: 'open' });
    github.failure = { status: 401, message: 'Bad credentials' };
    now = new Date('2026-11-12T11:00:00.000Z');
    const { read } = await lookup({ threadId: 't-tea', ref, read: 'refresh' });
    expect(read?.error).toMatchObject({ kind: 'refused', setting: 'trackers.github.token' });
    expect(read?.error?.message).toContain('refused the GitHub token');
    expect(read?.fetchedAt).toBe('2026-11-12T09:00:00.000Z');
    expect(read?.data?.kind).toBe('issue');
  });

  it('asks the host again on the next open when the first read failed', async () => {
    const ref = `${web}/acme/tea/issues/3`;
    github.failure = { status: 401, message: 'Bad credentials' };
    const first = await lookup({ threadId: 't-tea', ref, read: 'open' });
    expect(first.read).toMatchObject({ fetchedAt: null, data: null, error: { kind: 'refused' } });
    const before = github.requests.length;
    github.failure = undefined;
    const second = await lookup({ threadId: 't-tea', ref, read: 'open' });
    expect(github.requests.length).toBeGreaterThan(before);
    expect(second.read).toMatchObject({ fetchedAt: now.toISOString(), error: null });
    expect(second.read?.data?.kind).toBe('issue');
  });

  it('makes bare references chips for the project’s Jira key and repository only (spec 24)', async () => {
    const tea = (await lookup({ threadId: 't-tea' })).rules;
    expect(tea.jiraKey).toBe('ABC');
    expect(tea.repository).toEqual({ host: 'github', base: web, path: 'acme/tea' });
    expect(
      bareHostRefs('ABC-42 and #14, not !7, XYZ-1, v1#2 or abc-42.', tea).map((m) => m.text),
    ).toEqual(['ABC-42', '#14']);

    const field = (await lookup({ threadId: 't-field' })).rules;
    expect(field.repository).toEqual({ host: 'gitlab', base: gitlabUrl, path: 'tea/field' });
    expect(bareHostRefs('!7 and #4', field).map((m) => [m.text, m.item.kind])).toEqual([
      ['!7', 'changeRequest'],
      ['#4', 'issue'],
    ]);

    // A thread without a project has no repository or key: its bare references stay text, its
    // links still resolve against Settings → Trackers.
    const loose = await lookup({ threadId: 't-loose', ref: '#14' });
    expect(loose.rules).toMatchObject({ repository: null, jiraKey: null });
    expect(loose.item).toBeNull();
    expect(
      (await lookup({ threadId: 't-loose', ref: `${jiraUrl}/browse/ABC-42` })).item?.kind,
    ).toBe('ticket');
  });

  it('puts nothing it read from a host into a prompt (spec 26)', async () => {
    await lookup({ threadId: 't-tea', ref: `${web}/acme/tea/issues/3`, read: 'open' });
    await lookup({ threadId: 't-tea', ref: 'ABC-42', read: 'open' });
    const turn = new Promise<Extract<ProviderCommand, { type: 'startTurn' }>>((resolve) => {
      started = resolve;
    });
    dispatch({ type: 'thread.sendMessage', threadId: 't-tea', text: 'Fix #3 and ABC-42 please' });
    const { prompt } = await turn;
    expect(prompt).toContain('Fix #3 and ABC-42 please');
    for (const read of [
      'The kettle whistles too early',
      'whistle**',
      'Seen it twice',
      'Water on a schedule',
      'The beds dry out',
    ]) {
      expect(prompt).not.toContain(read);
    }
  });
});
