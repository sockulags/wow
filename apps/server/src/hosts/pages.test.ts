import type { ServerCommand } from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../server.js';
import { confluenceLinksIn, confluencePageOf } from './confluence.js';
import { MockConfluence, type MockPage } from './mock-confluence.js';
import { MockGitHub } from './mock-github.js';
import { MockJira } from './mock-jira.js';

// Links to Confluence pages as wow reads them, and Test connection to Confluence. Everything is
// invented: an Enterprise GitHub, a Jira Server and a Confluence Server that live in this file.

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
    clock: () => now,
    schedulerTimers: { setTimeout: () => undefined, clearTimeout: () => undefined },
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

  it('keeps brackets that belong to a title in the address', () => {
    const text = [
      `Plain ${wiki}/display/ENG/Plan+(draft), and`,
      `[the plan](${wiki}/display/ENG/Kettle+(v2)).`,
      `[${wiki}/display/ENG/Notes+[old]](${wiki}/pages/viewpage.action?pageId=456)`,
      `(${wiki}/pages/viewpage.action?pageId=789)`,
    ].join('\n');
    expect(confluenceLinksIn(text, wiki).map((link) => link.ref)).toEqual([
      'title:ENG/Plan (draft)',
      'title:ENG/Kettle (v2)',
      'title:ENG/Notes [old]',
      'id:456',
      'id:789',
    ]);
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
