import { TrackerError, field, getJson, trimBase, type RequestOptions } from './http.js';
import type { GitHubConfig } from './github.js';
import { gitLabApi, gitLabHeaders, gitLabProjectId, type GitLabConfig } from './gitlab.js';
import { jiraAuthorization, type JiraConfig } from './jira.js';
import type { ConfluenceSignIn } from '../hosts/confluence.js';

// "Test connection" (audit E-08): who the stored credentials sign in as. Throws TrackerError with
// the tracker's own message when they do not work.

export async function jiraWhoAmI(config: JiraConfig, options: RequestOptions): Promise<string> {
  const answer = await getJson(
    'Jira',
    `${trimBase(config.baseUrl)}/rest/api/2/myself`,
    { authorization: jiraAuthorization(config) },
    options,
  );
  const name = field(answer, 'displayName');
  const email = field(answer, 'emailAddress');
  const parts = [name, email].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  return parts.length > 0 ? parts.join(' · ') : 'Signed in';
}

export async function gitHubWhoAmI(config: GitHubConfig, options: RequestOptions): Promise<string> {
  const headers = {
    authorization: `Bearer ${config.token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  const base = trimBase(config.baseUrl);
  const user = await getJson('GitHub', `${base}/user`, headers, options);
  const login = field(user, 'login');
  // The repository must be reachable with this token too, or publishing fails later.
  if (config.owner !== '' && config.repo !== '') {
    await getJson(
      'GitHub',
      `${base}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`,
      headers,
      options,
    );
  }
  return typeof login === 'string' && login !== '' ? login : 'Signed in';
}

// GitLab answers who the token belongs to and, signed in, which version it runs; the version
// says which API wow is talking to (merge request search differs between versions).
export async function gitLabWhoAmI(
  config: GitLabConfig,
  given: RequestOptions,
): Promise<{ account: string; version: string | null }> {
  const api = gitLabApi(config.baseUrl);
  const headers = gitLabHeaders(config.token);
  // The token is in its own header, which fetch would carry along a redirect to another origin.
  const options: RequestOptions = { ...given, redirect: 'manual' };
  const user = await getJson('GitLab', `${api}/user`, headers, options);
  const username = field(user, 'username');
  const name = field(user, 'name');
  const version = field(await getJson('GitLab', `${api}/version`, headers, options), 'version');
  // The project must be readable with this token too, or no merge request can be.
  if (config.projectPath !== '') {
    await getJson(
      'GitLab',
      `${api}/projects/${gitLabProjectId(config.projectPath)}`,
      headers,
      options,
    );
  }
  const parts = [
    typeof name === 'string' && name !== '' ? name : undefined,
    typeof username === 'string' && username !== '' ? `@${username}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return {
    account: parts.length > 0 ? parts.join(' ') : 'Signed in',
    version: typeof version === 'string' && version !== '' ? version : null,
  };
}

// Confluence answers who the token belongs to; a redirect (to a sign-in page) is turned down
// rather than followed with the token.
export async function confluenceWhoAmI(
  config: ConfluenceSignIn,
  options: RequestOptions,
): Promise<string> {
  const answer = await getJson(
    'Confluence',
    `${trimBase(config.baseUrl)}/rest/api/user/current`,
    { authorization: jiraAuthorization(config) },
    { ...options, redirect: 'manual' },
  );
  // Without a valid token Server and Data Center answer an anonymous user instead of refusing.
  if (field(answer, 'type') === 'anonymous') {
    throw new TrackerError(
      'Confluence answered as an anonymous user: the token was not accepted. Check the Confluence token.',
    );
  }
  const name = field(answer, 'displayName');
  const user = field(answer, 'username') ?? field(answer, 'email');
  const parts = [name, user].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  return parts.length > 0 ? parts.join(' · ') : 'Signed in';
}
