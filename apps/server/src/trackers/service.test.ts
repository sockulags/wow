import type { BacklogItem, ServerCommand } from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CommandRejected } from '../core/orchestrator.js';
import { snapshot } from '../core/subscriptions.js';
import { startServer, type RunningServer } from '../server.js';

// Behavior 30 on the server: preview, publish on confirm, key and URL stored on the item, and a
// second publish refused in favour of the existing issue.

const fixture = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;

const mock = setupServer();
let requests = 0;
let root: string;
let server: RunningServer;
let ids = 0;

const dispatch = (command: ServerCommand) => server.engine.dispatch(`t${++ids}`, command);
const item = () => (snapshot(server.database.db, { topic: 'backlogItems' }) as BacklogItem[])[0];
const set = (key: string, value: unknown) =>
  dispatch({ type: 'setting.set', key, scope: 'global', value });

beforeAll(() => mock.listen({ onUnhandledFrame: 'error' }));
afterAll(() => mock.close());

beforeEach(async () => {
  requests = 0;
  root = await mkdtemp(path.join(tmpdir(), 'wow-trackers-'));
  server = await startServer({
    home: root,
    env: {},
    platform: 'linux',
    port: 0,
    protector: plainProtector,
    logSink: () => undefined,
    userHome: root,
    watchSkills: () => ({ close: () => Promise.resolve() }),
  });
  dispatch({
    type: 'backlog.create',
    backlogItemId: 'b1',
    title: 'Fix the login',
    body: 'The **login** fails on Mondays.',
    tags: ['auth'],
  });
});

afterEach(async () => {
  mock.resetHandlers();
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

async function configureGitHub() {
  set('trackers.github.owner', 'acme');
  set('trackers.github.repo', 'wow');
  set('trackers.github.labels', ['from-wow']);
  set('trackers.github.token', await server.secrets.set('setting:trackers.github.token', 'gh'));
  const created = await fixture('github-create-issue.json');
  mock.use(
    http.post('https://api.github.com/repos/acme/wow/issues', () => {
      requests += 1;
      return HttpResponse.json(created, { status: 201 });
    }),
  );
}

describe('tracker service', () => {
  it('previews the issue and names what is not set up yet', async () => {
    expect(await server.trackers.preview('b1', 'jira')).toEqual({
      service: 'jira',
      target: '',
      title: 'Fix the login',
      body: 'The **login** fails on Mondays.',
      issueType: 'Task',
      labels: [],
      missing: [
        'trackers.jira.baseUrl',
        'trackers.jira.email',
        'trackers.jira.token',
        'trackers.jira.projectKey',
      ],
      existing: null,
    });
    set('trackers.jira.authMode', 'pat');
    expect((await server.trackers.preview('b1', 'jira')).missing).not.toContain(
      'trackers.jira.email',
    );
    const refused = await server.trackers.publish('b1', 'jira').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CommandRejected);
    expect((refused as CommandRejected).message).toBe(
      'Jira is not set up: fill in Jira URL, Jira token, Jira project key in Settings → Trackers',
    );
    expect(item()?.remote).toBeNull();
  });

  it('publishes once, stores key and URL, and refuses a second publish', async () => {
    await configureGitHub();
    const preview = await server.trackers.preview('b1', 'github');
    expect(preview).toMatchObject({ target: 'acme/wow', labels: ['from-wow'], missing: [] });

    const remote = await server.trackers.publish('b1', 'github');
    expect(remote).toEqual({
      service: 'github',
      key: 'acme/wow#17',
      url: 'https://github.com/acme/wow/issues/17',
    });
    expect(item()?.remote).toEqual(remote);
    expect((await server.trackers.preview('b1', 'jira')).existing).toEqual(remote);

    const again = await server.trackers.publish('b1', 'github').catch((error: unknown) => error);
    expect(again).toBeInstanceOf(CommandRejected);
    expect((again as CommandRejected).code).toBe('conflict');
    expect(requests).toBe(1);
  });

  it('sends the title edited in the preview and the tags picked as labels', async () => {
    set('trackers.github.owner', 'acme');
    set('trackers.github.repo', 'wow');
    set('trackers.github.labels', ['from-wow']);
    set('trackers.github.token', await server.secrets.set('setting:trackers.github.token', 'gh'));
    const created = await fixture('github-create-issue.json');
    let sent: unknown;
    mock.use(
      http.post('https://api.github.com/repos/acme/wow/issues', async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    await server.trackers.publish('b1', 'github', {
      title: ' Login on Mondays ',
      labels: ['auth'],
    });
    expect(sent).toEqual({
      title: 'Login on Mondays',
      body: 'The **login** fails on Mondays.',
      labels: ['from-wow', 'auth'],
    });
  });

  it('creates one issue when publish is pressed twice before the first answer', async () => {
    await configureGitHub();
    const [first, second] = await Promise.all([
      server.trackers.publish('b1', 'github'),
      server.trackers.publish('b1', 'github'),
    ]);
    expect(second).toEqual(first);
    expect(requests).toBe(1);
  });

  it('keeps the item unpublished when the tracker refuses', async () => {
    await configureGitHub();
    const refusal = await fixture('github-validation-failed.json');
    mock.use(
      http.post('https://api.github.com/repos/acme/wow/issues', () =>
        HttpResponse.json(refusal, { status: 422 }),
      ),
    );
    await expect(server.trackers.publish('b1', 'github')).rejects.toThrow(
      'GitHub answered 422: Validation Failed; title missing_field',
    );
    expect(item()?.remote).toBeNull();
  });
});
