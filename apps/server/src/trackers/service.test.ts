import type { BacklogItem, ServerCommand } from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CommandRejected } from '../core/orchestrator.js';
import { snapshot } from '../core/subscriptions.js';
import { outlookStatus } from '../db/schema.js';
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
      project: null,
      needsProject: false,
      targetSource: 'default',
      targetHost: null,
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

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });
const commit = (dir: string, message: string) =>
  git(
    dir,
    '-c',
    'user.name=Invented',
    '-c',
    'user.email=invented@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    message,
  );

// A project whose folder is an invented repository with `remote` as origin ('' for none), or a
// plain folder when `remote` is left out.
async function project(projectId: string, name: string, remote?: string): Promise<string> {
  const cwd = path.join(root, name.toLowerCase());
  await mkdir(cwd, { recursive: true });
  if (remote !== undefined) {
    git(cwd, 'init', '-q', '-b', 'main');
    if (remote !== '') git(cwd, 'remote', 'add', 'origin', remote);
  }
  dispatch({ type: 'project.create', projectId, name, cwd });
  return cwd;
}

// Owner decision F-4: tracker settings per project, the GitHub repository from the project's git
// remote, and the publish target from the item's card or the project chosen in the dialog.
describe('per-project trackers', () => {
  const ceiling = process.env['GIT_CEILING_DIRECTORIES'];
  beforeEach(() => {
    // The temporary folders must never be read as part of a repository around them.
    process.env['GIT_CEILING_DIRECTORIES'] = root;
  });
  afterEach(() => {
    if (ceiling === undefined) delete process.env['GIT_CEILING_DIRECTORIES'];
    else process.env['GIT_CEILING_DIRECTORIES'] = ceiling;
  });

  it('reports each project folder: remote, no repository, missing', async () => {
    await project('p-widgets', 'Widgets', 'git@github.com:acme/widgets.git');
    await project('p-plain', 'Plain');
    const gone = await project('p-gone', 'Gone');
    await rm(gone, { recursive: true });
    const found = await server.trackers.projectsGit();
    expect(Object.fromEntries(found.map((entry) => [entry.projectId, entry.status]))).toEqual({
      'p-widgets': 'ok',
      'p-plain': 'noRepository',
      'p-gone': 'folderMissing',
    });
    expect(
      found.find((entry) => entry.projectId === 'p-widgets')?.remotes[0]?.github,
    ).toMatchObject({ owner: 'acme', repo: 'widgets' });
  });

  it('prefills GitHub from the remote and publishes there for the project of the item card', async () => {
    await project('p-widgets', 'Widgets', 'https://github.com/acme/widgets.git');
    // The shared token in Settings → Trackers is used by every project.
    set('trackers.github.token', await server.secrets.set('setting:trackers.github.token', 'gh'));
    set('trackers.github.owner', 'default-owner');
    set('trackers.github.repo', 'default-repo');

    const trackers = await server.trackers.projectTrackers('p-widgets');
    const value = (key: string) => trackers.settings.find((entry) => entry.key === key);
    expect(value('trackers.github.repo')).toEqual({
      key: 'trackers.github.repo',
      value: 'widgets',
      source: 'gitRemote',
    });
    expect(value('trackers.github.token')?.source).toBe('global');

    // No card yet: the dialog has to ask, and the defaults show meanwhile.
    expect(await server.trackers.preview('b1', 'github')).toMatchObject({
      needsProject: true,
      project: null,
      target: 'default-owner/default-repo',
      targetSource: 'global',
    });
    expect(await server.trackers.preview('b1', 'github', 'p-widgets')).toMatchObject({
      needsProject: false,
      project: { id: 'p-widgets', name: 'Widgets', source: 'chosen' },
      target: 'acme/widgets',
      targetSource: 'gitRemote',
      targetHost: 'github.com',
      missing: [],
    });

    dispatch({
      type: 'card.create',
      cardId: 'c1',
      title: 'Fix the login',
      start: '2027-03-02T09:00:00Z',
      end: '2027-03-02T09:30:00Z',
      zone: 'UTC',
      projectId: 'p-widgets',
      backlogItemId: 'b1',
    });
    expect((await server.trackers.preview('b1', 'github')).project).toEqual({
      id: 'p-widgets',
      name: 'Widgets',
      source: 'card',
    });
    const created = await fixture('github-create-issue.json');
    let authorization: string | null = null;
    mock.use(
      http.post('https://api.github.com/repos/acme/widgets/issues', ({ request }) => {
        authorization = request.headers.get('authorization');
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    expect((await server.trackers.publish('b1', 'github')).key).toBe('acme/widgets#17');
    expect(authorization).toBe('Bearer gh');
  });

  it('names a <name>.ghe.com project by its own host, not its API host', async () => {
    await project('p-octo', 'Octo', 'https://octo.ghe.com/acme/widgets.git');
    set('trackers.github.token', await server.secrets.set('setting:trackers.github.token', 'gh'));
    dispatch({
      type: 'setting.set',
      key: 'trackers.github.baseUrl',
      scope: 'global',
      value: 'https://api.octo.ghe.com',
    });
    expect(await server.trackers.githubHost('p-octo')).toMatchObject({ name: 'octo.ghe.com' });
    expect(await server.trackers.preview('b1', 'github', 'p-octo')).toMatchObject({
      target: 'acme/widgets',
      targetHost: 'octo.ghe.com',
    });
  });

  it('lets a project override the remote and the shared token, and forgets its token on removal', async () => {
    await project('p-widgets', 'Widgets', 'git@github.com:acme/widgets.git');
    set('trackers.github.token', await server.secrets.set('setting:trackers.github.token', 'gh'));
    const scope = 'project:p-widgets';
    dispatch({ type: 'setting.set', key: 'trackers.github.repo', scope, value: 'widgets-issues' });
    const own = await server.secrets.set(
      'setting:project:p-widgets:trackers.github.token',
      'gh-widgets',
    );
    dispatch({ type: 'setting.set', key: 'trackers.github.token', scope, value: own });
    expect(await server.trackers.preview('b1', 'github', 'p-widgets')).toMatchObject({
      target: 'acme/widgets-issues',
      targetSource: 'project',
    });
    const trackers = await server.trackers.projectTrackers('p-widgets');
    expect(trackers.settings.find((entry) => entry.key === 'trackers.github.token')?.source).toBe(
      'project',
    );

    dispatch({ type: 'project.delete', projectId: 'p-widgets' });
    await server.trackers.idle();
    expect(await server.secrets.names()).toEqual(['setting:trackers.github.token']);
  });

  it('suggests the Jira key from history and the site of another project, and takes the email from Outlook', async () => {
    const cwd = await project('p-widgets', 'Widgets', '');
    git(cwd, 'checkout', '-q', '-b', 'feature/WID-7-dark-mode');
    commit(cwd, 'WID-8 Add the toggle');
    await project('p-billing', 'Billing');
    dispatch({
      type: 'setting.set',
      key: 'trackers.jira.baseUrl',
      scope: 'project:p-billing',
      value: 'https://acme.atlassian.net',
    });
    server.database.db
      .insert(outlookStatus)
      .values({
        id: 1,
        profile: {
          zone: null,
          workHours: null,
          firstDayOfWeek: null,
          address: 'me@example.invalid',
        },
      })
      .run();

    const trackers = await server.trackers.projectTrackers('p-widgets');
    expect(trackers.git).toMatchObject({ status: 'noRemote', branch: 'feature/WID-7-dark-mode' });
    expect(trackers.suggestions).toEqual([
      {
        key: 'trackers.jira.baseUrl',
        value: 'https://acme.atlassian.net',
        from: 'otherProject',
        detail: 'Used by Billing',
      },
      {
        key: 'trackers.jira.projectKey',
        value: 'WID',
        from: 'gitHistory',
        detail: 'Seen in 2 issues in recent commits and branches, such as WID-7',
      },
    ]);
    expect(trackers.settings.find((entry) => entry.key === 'trackers.jira.email')).toMatchObject({
      value: 'me@example.invalid',
      source: 'outlook',
    });
  });

  it('refuses an unknown project', async () => {
    await expect(server.trackers.preview('b1', 'github', 'nope')).rejects.toThrow(
      'No project nope',
    );
  });
});
