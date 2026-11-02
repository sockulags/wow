import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createGitHubIssue, type GitHubConfig } from './github.js';
import { TrackerError } from './http.js';
import { createJiraIssue, type JiraConfig } from './jira.js';

// The tracker clients against recorded answers (fixtures/, invented data in the trackers' shapes)
// served by msw, so the requests they send are checked as the trackers would see them.

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;

interface Seen {
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

const seen: Seen[] = [];
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  seen.length = 0;
});
afterAll(() => server.close());

function answer(method: 'post', url: string, status: number, body: unknown) {
  server.use(
    http[method](url, async ({ request }) => {
      seen.push({ url: request.url, headers: request.headers, body: await request.json() });
      return HttpResponse.json(body as Record<string, unknown>, { status });
    }),
  );
}

const timedOut = () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));

const issue = { title: 'Fix the login', body: 'The **login** fails on Mondays.\n\n- step one' };
const options = { timeoutMs: 5000 };

describe('Jira client', () => {
  const cloud: JiraConfig = {
    baseUrl: 'https://acme.atlassian.example/',
    authMode: 'cloud-basic',
    email: 'me@acme.example',
    token: 'jira-api-token',
    projectKey: 'WOW',
    issueType: 'Task',
  };

  it('creates a Cloud issue with basic auth and the minimal v2 payload', async () => {
    answer(
      'post',
      'https://acme.atlassian.example/rest/api/2/issue',
      201,
      await fixture('jira-create-issue.json'),
    );
    const created = await createJiraIssue(cloud, issue, options);
    expect(created).toEqual({ key: 'WOW-42', url: 'https://acme.atlassian.example/browse/WOW-42' });
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('me@acme.example:jira-api-token').toString('base64')}`,
    );
    expect(request?.headers.get('content-type')).toBe('application/json');
    expect(request?.body).toEqual({
      fields: {
        project: { key: 'WOW' },
        issuetype: { name: 'Task' },
        summary: 'Fix the login',
        description: 'The **login** fails on Mondays.\n\n- step one',
      },
    });
  });

  it('uses a bearer token for a personal access token on Jira Server', async () => {
    answer(
      'post',
      'https://jira.acme.example/jira/rest/api/2/issue',
      201,
      await fixture('jira-create-issue.json'),
    );
    const created = await createJiraIssue(
      { ...cloud, baseUrl: 'https://jira.acme.example/jira', authMode: 'pat', email: '' },
      issue,
      options,
    );
    expect(created.url).toBe('https://jira.acme.example/jira/browse/WOW-42');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer jira-api-token');
  });

  it('names the field Jira wants when it refuses the issue', async () => {
    answer(
      'post',
      'https://acme.atlassian.example/rest/api/2/issue',
      400,
      await fixture('jira-missing-field.json'),
    );
    await expect(createJiraIssue(cloud, issue, options)).rejects.toThrow(
      new TrackerError('Jira answered 400: components: Component/s is required.', 400),
    );
  });

  it('passes on what Jira says about permissions', async () => {
    answer(
      'post',
      'https://acme.atlassian.example/rest/api/2/issue',
      403,
      await fixture('jira-unauthorized.json'),
    );
    const failure = await createJiraIssue(cloud, issue, options).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TrackerError);
    expect((failure as TrackerError).status).toBe(403);
    expect((failure as TrackerError).message).toBe(
      'Jira answered 403: You do not have permission to create issues in this project.',
    );
  });

  it('reports a request that timed out', async () => {
    await expect(
      createJiraIssue(cloud, issue, { timeoutMs: 1234, fetch: timedOut }),
    ).rejects.toThrow('Jira could not be reached: no answer within 1234 ms');
  });
});

describe('GitHub client', () => {
  const github: GitHubConfig = {
    baseUrl: 'https://api.github.com',
    token: 'github-token',
    owner: 'acme',
    repo: 'wow',
    labels: ['from-wow'],
  };

  it('creates an issue with title, body and labels', async () => {
    answer(
      'post',
      'https://api.github.com/repos/acme/wow/issues',
      201,
      await fixture('github-create-issue.json'),
    );
    const created = await createGitHubIssue(github, issue, options);
    expect(created).toEqual({ key: 'acme/wow#17', url: 'https://github.com/acme/wow/issues/17' });
    const [request] = seen;
    expect(request?.headers.get('authorization')).toBe('Bearer github-token');
    expect(request?.headers.get('accept')).toBe('application/vnd.github+json');
    expect(request?.headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(request?.body).toEqual({ ...issue, labels: ['from-wow'] });
  });

  it('talks to GitHub Enterprise under its own API URL and leaves out empty labels', async () => {
    answer(
      'post',
      'https://ghe.acme.example/api/v3/repos/acme/wow/issues',
      201,
      await fixture('github-create-issue.json'),
    );
    await createGitHubIssue(
      { ...github, baseUrl: 'https://ghe.acme.example/api/v3/', labels: [] },
      issue,
      options,
    );
    expect(seen[0]?.body).toEqual(issue);
  });

  it('passes on a validation failure', async () => {
    answer(
      'post',
      'https://api.github.com/repos/acme/wow/issues',
      422,
      await fixture('github-validation-failed.json'),
    );
    await expect(createGitHubIssue(github, issue, options)).rejects.toThrow(
      'GitHub answered 422: Validation Failed; title missing_field',
    );
  });
});
