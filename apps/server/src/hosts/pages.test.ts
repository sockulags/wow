import type { PageRead, ProviderInstance, ServerCommand } from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { snapshot } from '../core/subscriptions.js';
import { providerInstances } from '../db/schema.js';
import { startServer, type RunningServer } from '../server.js';
import { confluenceLinksIn, confluencePageOf } from './confluence.js';
import { MockConfluence, type MockPage } from './mock-confluence.js';
import { MockGitHub } from './mock-github.js';
import { MockJira } from './mock-jira.js';

// U13 ground truth: the Confluence pages a run's ticket description, pull request body and intent
// link to (review loop spec 35), what happens when Confluence refuses or does not answer (spec 31
// and 32), and that nothing else is read. Everything is invented: an Enterprise GitHub, a Jira
// Server and a Confluence Server that live in this file. Nothing sleeps: a round runs when the
// test calls it, and the clock is the test's.

const api = 'https://ghe.example.invalid/api/v3';
const jiraUrl = 'https://jira.example.invalid';
const wiki = 'https://wiki.example.invalid/confluence';
const GITHUB_TOKEN = 'ghp-invented-token-for-tests';
const JIRA_TOKEN = 'jira-invented-token-for-tests';
const WIKI_TOKEN = 'wiki-invented-token-for-tests';

let root: string;
let server: RunningServer;
let github: MockGitHub;
let jira: MockJira;
let confluence: MockConfluence;
let now: Date;
let logged: string[];
let ids = 0;

const dispatch = (command: ServerCommand) => server.engine.dispatch(`t${++ids}`, command);
const set = (key: string, value: unknown, scope = 'global') =>
  dispatch({ type: 'setting.set', key, scope, value });
const pageRead = (runId = 'r1') =>
  (snapshot(server.database.db, { topic: 'pageReads' }) as PageRead[]).find(
    (row) => row.runId === runId,
  );
const wikiAsked = () => confluence.requests.map((request) => request.path);
const expand = 'expand=body.view,version,space';

const design: MockPage = {
  id: '123',
  title: 'Kettle design',
  space: 'ENG',
  version: 4,
  body: '<h1>Kettle design</h1><p>The whistle sounds at 100 °C.</p><script>alert(1)</script>',
};
const notes: MockPage = {
  id: '456',
  title: 'Design notes',
  space: 'ENG',
  version: 2,
  body: '<p>Notes on the <strong>whistle</strong>.</p>',
};
const runbook: MockPage = {
  id: '789',
  title: 'Release runbook',
  space: 'OPS',
  version: 1,
  body: '<p>Ship it.</p>',
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

function onBranch(branch: string): void {
  execFileSync('git', ['-C', path.join(root, 'tea'), 'init', '--quiet', '-b', branch], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'none'), GIT_CONFIG_NOSYSTEM: '1' },
  });
}

// A backlog item published to Jira as ABC-12, whose description is `description` (wiki markup).
function ticketWith(description: string): string {
  jira.issues = [
    {
      key: 'ABC-12',
      summary: 'Fix the kettle whistle',
      status: 'In Progress',
      assignee: null,
      type: 'Bug',
      description,
    },
  ];
  dispatch({ type: 'backlog.create', backlogItemId: 'b1', title: 'Whistle', body: '', tags: [] });
  dispatch({
    type: 'backlog.published',
    backlogItemId: 'b1',
    remote: { service: 'jira', key: 'ABC-12', url: `${jiraUrl}/browse/ABC-12` },
  });
  return 'b1';
}

// The run's pull request, on the branch the project folder is on.
function pullRequestWith(body: string): void {
  onBranch('agent/whistle');
  github.pulls = [
    { number: 3, title: 'Fix it', body, state: 'open', branch: 'agent/whistle', sha: 'c3' },
  ];
}

async function intentWith(intentId: string, text: string): Promise<void> {
  await mkdir(path.join(root, 'tea', 'intents', intentId), { recursive: true });
  await writeFile(path.join(root, 'tea', 'intents', intentId, 'intent.md'), text);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-pages-'));
  await mkdir(path.join(root, 'tea'), { recursive: true });
  await writeFile(path.join(root, 'tea', 'README.md'), 'Invented.\n');
  now = new Date('2026-11-03T09:00:00.000Z');
  logged = [];
  github = new MockGitHub({ owner: 'acme', repo: 'tea', webUrl: 'https://ghe.example.invalid' });
  github.token = GITHUB_TOKEN;
  jira = new MockJira();
  jira.authorization = `Bearer ${JIRA_TOKEN}`;
  confluence = new MockConfluence('/confluence');
  confluence.authorization = `Bearer ${WIKI_TOKEN}`;
  confluence.pages = [design, notes, runbook];
  const askGitHub = github.fetch(api);
  const askJira = jira.fetch(jiraUrl);
  const askWiki = confluence.fetch(wiki);
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
      if (url.startsWith(jiraUrl)) return askJira(input, init);
      if (url.startsWith('https://wiki.example.invalid')) return askWiki(input, init);
      return askGitHub(input, init);
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
  set('trackers.confluence.baseUrl', wiki);
  set('trackers.confluence.authMode', 'pat');
  set(
    'trackers.confluence.token',
    await server.secrets.set('setting:trackers.confluence.token', WIKI_TOKEN),
  );
});

afterEach(async () => {
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('links to pages on the Confluence site', () => {
  it('names a page by id, by Cloud address or by space and title', () => {
    expect(confluencePageOf(`${wiki}/pages/viewpage.action?pageId=123`, wiki)).toEqual({
      kind: 'id',
      id: '123',
    });
    expect(confluencePageOf(`${wiki}/spaces/ENG/pages/456/Design+notes`, wiki)).toEqual({
      kind: 'id',
      id: '456',
    });
    expect(confluencePageOf(`${wiki}/display/ENG/Design+notes%3F`, `${wiki}/`)).toEqual({
      kind: 'title',
      space: 'ENG',
      title: 'Design notes?',
    });
  });

  it('takes no link to another site, another path or something that is not a page', () => {
    for (const link of [
      'https://other.example.invalid/confluence/pages/viewpage.action?pageId=123',
      'http://wiki.example.invalid/confluence/pages/viewpage.action?pageId=123',
      'https://wiki.example.invalid/pages/viewpage.action?pageId=123',
      'https://wiki.example.invalid:8443/confluence/pages/viewpage.action?pageId=123',
      `${wiki}/pages/viewpage.action?pageId=12a`,
      `${wiki}/display/ENG`,
      `${wiki}/dosearchsite.action?queryString=kettle`,
      `${wiki}/download/attachments/123/kettle.png`,
    ]) {
      expect({ link, page: confluencePageOf(link, wiki) }).toEqual({ link, page: undefined });
    }
  });

  it('finds each linked page once, in markdown, wiki markup or plain text', () => {
    const text = [
      `See [the design](${wiki}/pages/viewpage.action?pageId=123).`,
      `Also <${wiki}/display/ENG/Design+notes> and ${wiki}/pages/viewpage.action?pageId=123, again.`,
      `[runbook|${wiki}/spaces/OPS/pages/789]`,
      'And https://other.example.invalid/confluence/pages/viewpage.action?pageId=1.',
    ].join('\n');
    expect(confluenceLinksIn(text, wiki).map((link) => link.ref)).toEqual([
      'id:123',
      'title:ENG/Design notes',
      'id:789',
    ]);
  });
});

describe('the pages a run links to (spec 35)', () => {
  it('lists the pages its ticket description and its intent link to, with title and time', async () => {
    const item = ticketWith(`See [the design|${wiki}/pages/viewpage.action?pageId=123].`);
    pullRequestWith('Fixes the whistle.\n\nIntent-Unit: kettle/U1');
    await intentWith('kettle', `# Kettle\n\nBackground: ${wiki}/display/ENG/Design+notes\n`);
    await startRun('r1', item);
    const read = pageRead();
    expect(read).toMatchObject({
      id: 'run:r1',
      projectId: 'tea',
      host: 'confluence',
      hostName: 'wiki.example.invalid',
      fetchedAt: now.toISOString(),
      error: null,
    });
    expect(
      read?.pages.map(({ ref, source, page, fetchedAt }) => [ref, source, page?.title, fetchedAt]),
    ).toEqual([
      ['id:123', 'ticket', 'Kettle design', now.toISOString()],
      ['title:ENG/Design notes', 'intent', 'Design notes', now.toISOString()],
    ]);
    expect(read?.pages[0]?.page).toEqual({
      id: '123',
      title: 'Kettle design',
      space: 'ENG',
      version: 4,
      // Stored as the host renders it; only the sandboxed viewer frame ever shows it.
      body: design.body,
      url: `${wiki}/spaces/ENG/pages/123`,
    });
    expect(wikiAsked()).toEqual([
      `/rest/api/content/123?${expand}`,
      `/rest/api/content?spaceKey=ENG&title=Design%20notes&${expand}`,
    ]);
  });

  it('lists a page its pull request body links to', async () => {
    pullRequestWith(`Runbook: ${wiki}/spaces/OPS/pages/789/Release+runbook`);
    await startRun();
    expect(pageRead()?.pages).toMatchObject([
      { ref: 'id:789', source: 'pullRequest', page: { title: 'Release runbook' }, error: null },
    ]);
  });

  it('never reads a link to another site', async () => {
    pullRequestWith(
      'https://other.example.invalid/confluence/pages/viewpage.action?pageId=123 and https://ghe.example.invalid/acme/tea',
    );
    await startRun();
    expect(pageRead()).toMatchObject({ pages: [], error: null });
    expect(confluence.requests).toEqual([]);
  });

  it('says there are no pages when nothing links to one, without asking Confluence', async () => {
    pullRequestWith('No links here.');
    await startRun();
    expect(pageRead()).toMatchObject({ pages: [], fetchedAt: now.toISOString(), error: null });
    expect(confluence.requests).toEqual([]);
  });

  it('says which settings are missing when Confluence is not set up', async () => {
    dispatch({ type: 'setting.reset', key: 'trackers.confluence.token', scope: 'global' });
    pullRequestWith(`${wiki}/pages/viewpage.action?pageId=123`);
    await startRun();
    expect(pageRead()?.error).toMatchObject({
      kind: 'notSetUp',
      setting: 'trackers.confluence.token',
    });
    expect(pageRead()?.error?.message).toContain('Confluence token');
    expect(confluence.requests).toEqual([]);

    dispatch({ type: 'setting.reset', key: 'trackers.confluence.baseUrl', scope: 'global' });
    await server.hosts.poll();
    expect(pageRead()?.error).toMatchObject({
      kind: 'notSetUp',
      setting: 'trackers.confluence.baseUrl',
    });
    expect(confluence.requests).toEqual([]);
  });

  it('reads a page once a round however many runs link to it', async () => {
    pullRequestWith(`${wiki}/pages/viewpage.action?pageId=123`);
    await startRun('r1');
    await startRun('r2');
    confluence.requests.length = 0;
    await server.hosts.poll();
    expect(wikiAsked()).toEqual([`/rest/api/content/123?${expand}`]);
    expect(pageRead('r2')?.pages[0]?.page?.title).toBe('Kettle design');
  });

  it('signs in with a bearer token, or with email and token on Cloud, and only on the site', async () => {
    pullRequestWith(`${wiki}/pages/viewpage.action?pageId=123`);
    await startRun();
    expect(confluence.requests.map((request) => request.authorization)).toEqual([
      `Bearer ${WIKI_TOKEN}`,
    ]);
    expect(github.requests.some((request) => request.authorization?.includes(WIKI_TOKEN))).toBe(
      false,
    );

    set('trackers.confluence.authMode', 'cloud-basic');
    set('trackers.confluence.email', 'mira@example.invalid');
    const basic = `Basic ${Buffer.from(`mira@example.invalid:${WIKI_TOKEN}`).toString('base64')}`;
    confluence.authorization = basic;
    await server.hosts.poll();
    expect(confluence.requests.at(-1)?.authorization).toBe(basic);
    expect(pageRead()?.error).toBeNull();
  });
});

describe('when Confluence refuses or does not answer (spec 31, 32)', () => {
  beforeEach(async () => {
    pullRequestWith(`${wiki}/pages/viewpage.action?pageId=123\n${wiki}/display/ENG/Design+notes`);
    await startRun();
    now = new Date('2026-11-03T09:10:00.000Z');
  });

  const lastFetched = '2026-11-03T09:00:00.000Z';

  it('keeps the last pages and points to the token setting on 401, never showing the token', async () => {
    confluence.authorization = 'Bearer another-token';
    await server.hosts.poll();
    const read = pageRead();
    expect(read?.fetchedAt).toBe(lastFetched);
    expect(read?.error).toMatchObject({ kind: 'refused', setting: 'trackers.confluence.token' });
    expect(read?.error?.message).toContain('wiki.example.invalid refused the Confluence token');
    expect(read?.pages.map((page) => [page.page?.title, page.fetchedAt])).toEqual([
      ['Kettle design', lastFetched],
      ['Design notes', lastFetched],
    ]);
    // After the refusal the site is not asked again this round.
    expect(wikiAsked().filter((asked) => asked.includes('123'))).toHaveLength(2);
    expect(wikiAsked()).toHaveLength(3);
    expect(JSON.stringify(read)).not.toContain(WIKI_TOKEN);
    expect(logged.join('\n')).not.toContain(WIKI_TOKEN);
  });

  it('keeps the last page on 404 and points to the link, not the token, reading the other pages', async () => {
    confluence.pages = [notes];
    await server.hosts.poll();
    const [gone, kept] = pageRead()?.pages ?? [];
    expect(gone).toMatchObject({ fetchedAt: lastFetched, page: { title: 'Kettle design' } });
    // The token works, so a deleted page is no reason to send the user to the token setting.
    expect(gone?.error).toMatchObject({ kind: 'refused', setting: null });
    expect(gone?.error?.message).toContain('shows no page 123');
    expect(gone?.error?.message).toContain('may have been deleted or moved');
    expect(kept).toMatchObject({ fetchedAt: now.toISOString(), error: null });
    expect(pageRead()?.error).toBeNull();
  });

  it('keeps the last pages on a timeout and tries again at the next interval', async () => {
    confluence.slow = true;
    await server.hosts.poll();
    expect(pageRead()).toMatchObject({ fetchedAt: lastFetched });
    expect(pageRead()?.error).toMatchObject({ kind: 'failed', at: now.toISOString() });
    expect(pageRead()?.error?.message).toContain('no answer within');
    expect(pageRead()?.pages[0]).toMatchObject({ page: { title: 'Kettle design' } });

    confluence.slow = false;
    confluence.pages = [{ ...design, title: 'Kettle design, take two' }, notes];
    now = new Date('2026-11-03T09:20:00.000Z');
    await server.hosts.poll();
    expect(pageRead()).toMatchObject({ fetchedAt: now.toISOString(), error: null });
    expect(pageRead()?.pages[0]?.page?.title).toBe('Kettle design, take two');
  });

  it('keeps the time an error was first seen while it repeats', async () => {
    confluence.failure = { status: 500, message: 'Invented outage' };
    await server.hosts.poll();
    const first = pageRead()?.error?.at;
    now = new Date('2026-11-03T09:30:00.000Z');
    await server.hosts.poll();
    expect(pageRead()?.error?.at).toBe(first);
    expect(pageRead()?.error?.message).toContain('Invented outage');
  });
});

describe('Test connection to Confluence', () => {
  it('says as whom the token signs in, and that it was refused', async () => {
    expect(await server.trackers.test('confluence')).toMatchObject({
      ok: true,
      account: 'Mira Invented · mira',
    });
    confluence.authorization = 'Bearer another-token';
    const refused = await server.trackers.test('confluence');
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('401');
  });
});
