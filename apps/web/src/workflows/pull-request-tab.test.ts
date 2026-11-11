import type { ChangeRequest, HostRead } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { emptyPullRequest, runPullRequest } from './pull-request-tab';

const read = (changes: Partial<HostRead> = {}): HostRead => ({
  id: 'run:r1',
  projectId: 'tea',
  scope: 'run',
  host: 'github',
  hostName: 'ghe.example.invalid',
  branch: 'agent/U2-bell',
  changeRequestIds: ['tea:14'],
  fetchedAt: '2026-11-03T09:00:00.000Z',
  error: null,
  ...changes,
});

describe('the run’s pull request', () => {
  it('is the one its read names', () => {
    const request = { id: 'tea:14', number: 14 } as ChangeRequest;
    const other = { id: 'tea:12', number: 12 } as ChangeRequest;
    expect(runPullRequest(read(), [other, request])).toBe(request);
    expect(runPullRequest(read({ changeRequestIds: [] }), [request])).toBeUndefined();
    expect(runPullRequest(undefined, [request])).toBeUndefined();
  });

  it('says why there is none', () => {
    expect(emptyPullRequest(undefined)).toBe('The host has not been asked about this run yet.');
    expect(emptyPullRequest(read({ fetchedAt: null, changeRequestIds: [] }))).toBe(
      'The host could not be read, so this run has no pull request to show.',
    );
    expect(emptyPullRequest(read({ branch: null, changeRequestIds: [] }))).toBe(
      'The run’s folder is on no branch, so there is no pull request to look for.',
    );
    expect(emptyPullRequest(read({ changeRequestIds: [] }))).toBe(
      'No pull request has the branch agent/U2-bell as its head.',
    );
    expect(emptyPullRequest(read({ host: 'gitlab', changeRequestIds: [] }))).toBe(
      'No merge request has the branch agent/U2-bell as its head.',
    );
  });
});
