import type { ChangeRequest, HostCheck } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import {
  changeRequestStateLabel,
  checksLabel,
  failingChecks,
  lastFetchedLabel,
  type HostReadFacts,
} from './labels';

// The words for what a host said. All invented.

const request = (changes: Partial<ChangeRequest> = {}): ChangeRequest =>
  ({
    id: 'tea:14',
    number: 14,
    title: 'Ring twice',
    url: 'https://ghe.example.invalid/acme/tea/pull/14',
    state: 'open',
    draft: false,
    checkState: 'none',
    checks: [],
    ...changes,
  }) as ChangeRequest;

const check = (name: string, state: HostCheck['state']): HostCheck =>
  ({ name, state, url: null }) as HostCheck;

const when = (iso: string) => `<${iso.slice(11, 16)}>`;

describe('what the host said, in words', () => {
  it('names a pull request state, with Draft for an open draft', () => {
    expect(changeRequestStateLabel(request())).toBe('Open');
    expect(changeRequestStateLabel(request({ draft: true }))).toBe('Draft');
    expect(changeRequestStateLabel(request({ state: 'merged', draft: true }))).toBe('Merged');
    expect(changeRequestStateLabel(request({ state: 'closed' }))).toBe('Closed');
  });

  it('sums the checks up and lists the failing ones', () => {
    expect(checksLabel(request())).toBe('No checks');
    expect(
      checksLabel(request({ checkState: 'success', checks: [check('test', 'success')] })),
    ).toBe('1 check passed');
    const mixed = request({
      checkState: 'failure',
      checks: [check('test', 'failure'), check('lint', 'pending'), check('build', 'success')],
    });
    expect(checksLabel(mixed)).toBe('1 of 3 checks failed');
    expect(checksLabel({ ...mixed, checkState: 'pending' })).toBe('1 of 3 checks still running');
    expect(failingChecks(mixed).map((failing) => failing.name)).toEqual(['test']);
  });

  it('says when a read was last fetched and from where, with the time it is given', () => {
    const read: Pick<HostReadFacts, 'fetchedAt' | 'host' | 'hostName'> = {
      host: 'github',
      hostName: 'ghe.example.invalid',
      fetchedAt: '2026-11-03T09:00:00.000Z',
    };
    expect(lastFetchedLabel(read, when)).toBe('Last fetched <09:00> from ghe.example.invalid');
    expect(lastFetchedLabel({ ...read, hostName: '' }, when)).toBe(
      'Last fetched <09:00> from GitHub',
    );
    expect(lastFetchedLabel({ ...read, fetchedAt: null }, when)).toBe('Not fetched yet');
    expect(lastFetchedLabel(undefined, when)).toBe('Not fetched yet');
  });
});
