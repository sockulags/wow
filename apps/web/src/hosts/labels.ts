import {
  hostKindLabels,
  settingsRegistry,
  type ChangeRequest,
  type HostCheck,
  type HostRead,
} from '@wow/contracts';

// The words for what a host read returned: a pull request's state and checks, when it was
// fetched, and the setting a host error points at. The server decides every status.

// "Open", "Draft", "Merged" or "Closed".
export const changeRequestStateLabel = (request: Pick<ChangeRequest, 'state' | 'draft'>): string =>
  request.state === 'merged'
    ? 'Merged'
    : request.state === 'closed'
      ? 'Closed'
      : request.draft
        ? 'Draft'
        : 'Open';

export const failingChecks = (request: Pick<ChangeRequest, 'checks'>): HostCheck[] =>
  request.checks.filter((check) => check.state === 'failure');

// "No checks", "3 checks passed", "1 of 3 checks still running" or "2 of 5 checks failed".
export function checksLabel(request: Pick<ChangeRequest, 'checkState' | 'checks'>): string {
  const total = request.checks.length;
  const count = (state: HostCheck['state']) =>
    request.checks.filter((check) => check.state === state).length;
  const checks = total === 1 ? 'check' : 'checks';
  switch (request.checkState) {
    case 'none':
      return 'No checks';
    case 'success':
      return `${total} ${checks} passed`;
    case 'pending':
      return `${count('pending')} of ${total} ${checks} still running`;
    case 'failure':
      return `${count('failure')} of ${total} ${checks} failed`;
  }
}

// "Last fetched 09:02 from github.com", or that nothing was fetched yet.
export function lastFetchedLabel(
  read: Pick<HostRead, 'fetchedAt' | 'host' | 'hostName'> | undefined,
  when: (iso: string) => string,
): string {
  if (!read?.fetchedAt) return 'Not fetched yet';
  return `Last fetched ${when(read.fetchedAt)} from ${read.hostName || hostKindLabels[read.host]}`;
}

// The label of the setting a host error points at, for the link to it.
export const settingLabel = (key: string): string =>
  Object.hasOwn(settingsRegistry, key)
    ? settingsRegistry[key as keyof typeof settingsRegistry].label
    : key;

// The Settings page a setting is on; Trackers for one the registry does not know.
// The Settings page a setting is on; Trackers for one the registry does not know.
export const settingGroup = (key: string): string =>
  Object.hasOwn(settingsRegistry, key)
    ? settingsRegistry[key as keyof typeof settingsRegistry].group
    : 'trackers';
