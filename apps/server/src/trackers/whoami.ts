import { field, getJson, trimBase, type RequestOptions } from './http.js';
import type { GitHubConfig } from './github.js';
import { jiraAuthorization, type JiraConfig } from './jira.js';

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
