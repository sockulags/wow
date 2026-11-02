import {
  TrackerError,
  field,
  postJson,
  trimBase,
  type CreatedIssue,
  type NewIssue,
  type RequestOptions,
} from './http.js';

export interface GitHubConfig {
  // https://api.github.com, or https://<host>/api/v3 for GitHub Enterprise Server.
  readonly baseUrl: string;
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly labels: readonly string[];
}

// GitHub renders markdown, so the body goes as written. Labels are the configured ones plus the
// tags picked in the preview.
export function gitHubIssuePayload(config: GitHubConfig, issue: NewIssue) {
  const labels = [...new Set([...config.labels, ...(issue.labels ?? [])])];
  return {
    title: issue.title,
    body: issue.body,
    ...(labels.length > 0 ? { labels } : {}),
  };
}

export async function createGitHubIssue(
  config: GitHubConfig,
  issue: NewIssue,
  options: RequestOptions,
): Promise<CreatedIssue> {
  const owner = encodeURIComponent(config.owner);
  const repo = encodeURIComponent(config.repo);
  const answer = await postJson(
    'GitHub',
    `${trimBase(config.baseUrl)}/repos/${owner}/${repo}/issues`,
    {
      authorization: `Bearer ${config.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    gitHubIssuePayload(config, issue),
    options,
  );
  const number = field(answer, 'number');
  const url = field(answer, 'html_url');
  if (typeof number !== 'number' || typeof url !== 'string') {
    throw new TrackerError('GitHub created no issue number; check the GitHub API URL');
  }
  return { key: `${config.owner}/${config.repo}#${number}`, url };
}
