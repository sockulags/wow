import type { JiraAuthMode } from '@wow/contracts';
import {
  TrackerError,
  field,
  postJson,
  trimBase,
  type CreatedIssue,
  type NewIssue,
  type RequestOptions,
} from './http.js';
import { jiraLabel, markdownToJira } from './jira-markup.js';

export interface JiraConfig {
  readonly baseUrl: string;
  readonly authMode: JiraAuthMode;
  // Only for cloud-basic.
  readonly email: string;
  readonly token: string;
  readonly projectKey: string;
  readonly issueType: string;
}

// REST API v2 on purpose: Jira Cloud, Server and Data Center all accept it with the same field
// names, and its description is a wiki-markup string, so the markdown body is converted
// (jira-markup.ts). v3 is Cloud only and wants the description as an Atlassian Document. The
// payload stays minimal (project, type, summary, description, labels when picked), so a project
// with extra required fields answers 400 with the field named in the message.
export function jiraIssuePayload(config: JiraConfig, issue: NewIssue) {
  const labels = [...new Set((issue.labels ?? []).map(jiraLabel).filter((label) => label !== ''))];
  return {
    fields: {
      project: { key: config.projectKey },
      issuetype: { name: config.issueType },
      summary: issue.title,
      description: markdownToJira(issue.body),
      ...(labels.length > 0 ? { labels } : {}),
    },
  };
}

export function jiraAuthorization(
  config: Pick<JiraConfig, 'authMode' | 'email' | 'token'>,
): string {
  if (config.authMode === 'pat') return `Bearer ${config.token}`;
  return `Basic ${Buffer.from(`${config.email}:${config.token}`, 'utf8').toString('base64')}`;
}

export async function createJiraIssue(
  config: JiraConfig,
  issue: NewIssue,
  options: RequestOptions,
): Promise<CreatedIssue> {
  const base = trimBase(config.baseUrl);
  const answer = await postJson(
    'Jira',
    `${base}/rest/api/2/issue`,
    { authorization: jiraAuthorization(config) },
    jiraIssuePayload(config, issue),
    options,
  );
  const key = field(answer, 'key');
  if (typeof key !== 'string' || key === '') {
    throw new TrackerError('Jira created no issue key; check the Jira URL');
  }
  return { key, url: `${base}/browse/${encodeURIComponent(key)}` };
}
