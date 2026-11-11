import { describe, expect, it } from 'vitest';
import { createConfluenceHost } from './confluence.js';
import { createGitHubHost } from './github.js';
import { createGitLabHost } from './gitlab.js';
import { createJiraHost } from './jira.js';

// Whatever wait a host asks for, wow asks again after `hosts.longestWaitMinutes` at the latest:
// a Retry-After of years or a limit reset decades away must not park a host until then.

const now = new Date('2026-11-03T09:00:00.000Z');
const clock = () => now;
const longestWaitMs = 30 * 60_000;
const capped = new Date(now.getTime() + longestWaitMs);
const years = String(60 * 60 * 24 * 365 * 30);
const farReset = String(Math.floor(now.getTime() / 1000) + 60 * 60 * 24 * 365 * 30);

const refusing =
  (headers: Record<string, string>, status = 429): typeof fetch =>
  () =>
    Promise.resolve(
      new Response(JSON.stringify({ message: 'Slow down' }), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    );
const answering =
  (headers: Record<string, string>): typeof fetch =>
  () =>
    Promise.resolve(
      new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    );

const options = (answer: typeof fetch) => ({
  timeoutMs: 1000,
  listFallbackCount: 5,
  clock,
  longestWaitMs,
  fetch: answer,
});

describe('a host that asks for a very long wait', () => {
  it('is asked again after the longest wait on GitHub, GitLab, Jira and Confluence', async () => {
    const github = createGitHubHost(
      {
        baseUrl: 'https://api.github.example.invalid',
        token: 't',
        owner: 'a',
        repo: 'b',
        labels: [],
      },
      'github.example.invalid',
      options(refusing({ 'retry-after': years })),
    );
    const gitlab = createGitLabHost(
      { baseUrl: 'https://gitlab.example.invalid', token: 't', projectPath: 'a/b' },
      'gitlab.example.invalid',
      options(refusing({ 'retry-after': years })),
    );
    const signIn = { authMode: 'pat' as const, email: '', token: 't' };
    const jira = createJiraHost(
      { ...signIn, baseUrl: 'https://jira.example.invalid' },
      'jira.example.invalid',
      options(refusing({ 'retry-after': years })),
    );
    const confluence = createConfluenceHost(
      { ...signIn, baseUrl: 'https://wiki.example.invalid' },
      'wiki.example.invalid',
      options(refusing({ 'retry-after': years })),
    );
    await expect(github.findForBranch('main')).rejects.toThrow(capped.toISOString());
    await expect(gitlab.findForBranch('main')).rejects.toThrow(capped.toISOString());
    await expect(jira.read('ABC-1')).rejects.toThrow(capped.toISOString());
    await expect(confluence.read({ kind: 'id', id: '1' })).rejects.toThrow(capped.toISOString());
    for (const adapter of [github, gitlab, jira, confluence]) {
      expect(adapter.waitUntil).toEqual(capped);
    }
  });

  it('bounds a request limit that resets decades from now', async () => {
    const github = createGitHubHost(
      {
        baseUrl: 'https://api.github.example.invalid',
        token: 't',
        owner: 'a',
        repo: 'b',
        labels: [],
      },
      'github.example.invalid',
      options(answering({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': farReset })),
    );
    const gitlab = createGitLabHost(
      { baseUrl: 'https://gitlab.example.invalid', token: 't', projectPath: 'a/b' },
      'gitlab.example.invalid',
      options(answering({ 'ratelimit-remaining': '0', 'ratelimit-reset': farReset })),
    );
    await github.findForBranch('main');
    await gitlab.findForBranch('main');
    expect(github.waitUntil).toEqual(capped);
    expect(gitlab.waitUntil).toEqual(capped);
  });
});
