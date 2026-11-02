import type { ServerCommand } from '@wow/contracts';
import { plainProtector } from '@wow/secrets';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../server.js';

// "Test connection" in Settings → Trackers (audit E-08): signs in and says as whom.

const mock = setupServer();
let root: string;
let server: RunningServer;
let ids = 0;

const set = (key: string, value: unknown) =>
  server.engine.dispatch(`t${++ids}`, {
    type: 'setting.set',
    key,
    scope: 'global',
    value,
  } satisfies ServerCommand);

beforeAll(() => mock.listen({ onUnhandledFrame: 'error' }));
afterAll(() => mock.close());

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'wow-tracker-test-'));
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
});

afterEach(async () => {
  mock.resetHandlers();
  await server.stop();
  await rm(root, { recursive: true, force: true });
});

describe('tracker test connection', () => {
  it('names what is missing before it sends anything', async () => {
    expect(await server.trackers.test('jira')).toMatchObject({
      ok: false,
      missing: ['trackers.jira.baseUrl', 'trackers.jira.email', 'trackers.jira.token'],
      message: 'Fill in Jira URL, Jira email, Jira token first.',
    });
  });

  it('signs in to Jira and reports the account', async () => {
    set('trackers.jira.baseUrl', 'https://acme.atlassian.example');
    set('trackers.jira.email', 'ada@example.com');
    set('trackers.jira.token', await server.secrets.set('setting:trackers.jira.token', 'tok'));
    mock.use(
      http.get('https://acme.atlassian.example/rest/api/2/myself', ({ request }) =>
        request.headers.get('authorization')?.startsWith('Basic ')
          ? HttpResponse.json({ displayName: 'Ada Lovelace', emailAddress: 'ada@example.com' })
          : new HttpResponse(null, { status: 401 }),
      ),
    );
    expect(await server.trackers.test('jira')).toMatchObject({
      ok: true,
      account: 'Ada Lovelace · ada@example.com',
      missing: ['trackers.jira.projectKey'],
    });
  });

  it('reports a refused GitHub token as an answer', async () => {
    set('trackers.github.token', await server.secrets.set('setting:trackers.github.token', 'bad'));
    mock.use(
      http.get('https://api.github.com/user', () =>
        HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
      ),
    );
    expect(await server.trackers.test('github')).toMatchObject({
      ok: false,
      account: null,
      message: 'GitHub answered 401: Bad credentials',
    });
  });
});
