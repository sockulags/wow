import type { ChangeRequest, HostRead, PlanIntent, PlanUnit, Project } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { planCommands } from './commands';
import {
  intentsDirectoryOf,
  planFilePath,
  unitThreadText,
  changeRequestStateLabel,
  checksLabel,
  failingChecks,
  lastFetchedLabel,
  openPlan,
  planRead,
  plansByProject,
  problemLabel,
  revisionLabel,
  staleLabel,
  validatePlanSearch,
} from './model';

const project = (id: string, name: string): Project => ({
  id,
  name,
  cwd: `/work/${id}`,
  defaultProviderInstanceId: null,
  defaultModel: null,
  createdAt: '2026-11-10T08:00:00.000Z',
});

const unit = (key: string, title: string): PlanUnit => ({
  key,
  title,
  line: 12,
  dependsOn: [],
  blocked: null,
  contract: null,
  status: 'unknown',
  statusReason: 'This plan is not followed, so only its files are read',
  changeRequestId: null,
});

const intent = (
  projectId: string,
  intentId: string,
  changes: Partial<PlanIntent> = {},
): PlanIntent => ({
  id: `${projectId}:${intentId}`,
  projectId,
  intentId,
  title: `Title of ${intentId}`,
  hasIntent: true,
  status: 'accepted',
  rev: 1,
  spec: null,
  plan: null,
  source: null,
  units: [],
  problems: [],
  followed: false,
  ...changes,
});

describe('plans model', () => {
  it('says status and revision, leaving out what a file does not say', () => {
    expect(revisionLabel('accepted', 2)).toBe('accepted · rev 2');
    expect(revisionLabel(null, 2)).toBe('rev 2');
    expect(revisionLabel('done', null)).toBe('done');
    expect(revisionLabel(null, null)).toBe('No status');
  });

  it('says what a stale spec or plan was built on', () => {
    const stale = { rev: 1, status: 'accepted', stale: { builtOn: 1, current: 2 } };
    expect(staleLabel('spec', stale)).toBe('Stale: built on intent@1, intent.md is at rev 2');
    expect(staleLabel('plan', stale)).toBe('Stale: built on spec@1, spec.md is at rev 2');
    expect(staleLabel('plan', { ...stale, stale: null })).toBeUndefined();
  });

  it('names a problem by file and line', () => {
    expect(problemLabel({ file: 'plan', line: 11, message: 'Unit key U1 appears twice' })).toBe(
      'plan.md line 11: Unit key U1 appears twice',
    );
  });

  it('lists every project by name with its intents by id', () => {
    const grouped = plansByProject(
      [project('b', 'Tea'), project('a', 'Garden'), project('c', 'Empty')],
      [intent('b', '2026-02-kettle'), intent('a', '2026-03-beds'), intent('b', '2026-01-timer')],
    );
    expect(
      grouped.map(({ project: own, intents }) => [own.name, intents.map((row) => row.intentId)]),
    ).toEqual([
      ['Empty', []],
      ['Garden', ['2026-03-beds']],
      ['Tea', ['2026-01-timer', '2026-02-kettle']],
    ]);
  });

  it('reads the open plan from the path and the open unit from the search', () => {
    const rows = [intent('a', '2026-03-beds'), intent('b', '2026-03-beds')];
    expect(openPlan('/plans/b/2026-03-beds', rows)?.id).toBe('b:2026-03-beds');
    expect(openPlan('/plans', rows)).toBeUndefined();
    expect(openPlan('/plans/c/2026-03-beds', rows)).toBeUndefined();
    expect(openPlan('/plans/b/%zz', rows)).toBeUndefined();
    expect(openPlan('/plans/%E0%A4%A/2026-03-beds', rows)).toBeUndefined();
    expect(openPlan('/plans/b/2026%2D03-beds', rows)?.id).toBe('b:2026-03-beds');
    expect(validatePlanSearch({ unit: 'U2' })).toEqual({ unit: 'U2' });
    expect(validatePlanSearch({ unit: 2 })).toEqual({});
    expect(validatePlanSearch({})).toEqual({});
  });
});

const request = (changes: Partial<ChangeRequest> = {}): ChangeRequest => ({
  id: 'b:14',
  projectId: 'b',
  host: 'github',
  number: 14,
  title: 'Ring the bell at zero',
  url: 'https://ghe.example.invalid/acme/tea/pull/14',
  state: 'open',
  draft: false,
  mergedAt: null,
  headBranch: 'agent/U2-bell',
  headSha: 'b2b2b2b',
  units: [{ intentId: '2026-01-timer', unitKey: 'U2' }],
  checkState: 'none',
  checks: [],
  comments: [],
  newestCommentId: null,
  ...changes,
});

const check = (name: string, state: 'success' | 'failure' | 'pending') => ({
  name,
  state,
  url: null,
});
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

  it('says when a plan was last fetched and from where, with the time it is given', () => {
    const read: HostRead = {
      id: 'plan:b:2026-01-timer',
      projectId: 'b',
      scope: 'plan',
      host: 'github',
      hostName: 'ghe.example.invalid',
      branch: null,
      changeRequestIds: [],
      fetchedAt: '2026-11-03T09:00:00.000Z',
      error: null,
    };
    expect(planRead([read], { id: 'b:2026-01-timer' })).toBe(read);
    expect(planRead([read], { id: 'b:2026-02-kettle' })).toBeUndefined();
    expect(lastFetchedLabel(read, when)).toBe('Last fetched <09:00> from ghe.example.invalid');
    expect(lastFetchedLabel({ ...read, hostName: '' }, when)).toBe(
      'Last fetched <09:00> from GitHub',
    );
    expect(lastFetchedLabel({ ...read, fetchedAt: null }, when)).toBe('Not fetched yet');
    expect(lastFetchedLabel(undefined, when)).toBe('Not fetched yet');
  });
});

describe('plan palette commands', () => {
  const tea = intent('b', '2026-01-timer', {
    title: 'A tea timer',
    rev: 2,
    units: [unit('U1', 'Count down'), unit('U2', 'Ring the bell')],
  });
  const data = { intents: [tea, intent('a', '2026-03-beds')], projects: [project('b', 'Tea')] };

  it('offers a refresh and every intent, the intents only when searching', () => {
    const commands = planCommands({ ...data, openIntent: undefined });
    expect(commands.map((command) => command.id)).toEqual([
      'plans.refresh',
      'plan.b:2026-01-timer',
      'plan.a:2026-03-beds',
    ]);
    expect(commands[1]).toMatchObject({
      title: 'A tea timer',
      detail: 'Plan · Tea · accepted · rev 2',
      searchOnly: true,
      group: 'Plans',
    });
    expect(commands[0]?.searchOnly).toBeUndefined();
  });

  it('offers the units of the open plan', () => {
    const commands = planCommands({ ...data, openIntent: tea });
    expect(commands.slice(1, 4).map((command) => command.title)).toEqual([
      'Plan: follow',
      'Unit U1: Count down',
      'Unit U2: Ring the bell',
    ]);
  });

  it('offers Follow, and for a followed plan Refresh and each unit’s pull request', () => {
    const followed = {
      ...tea,
      followed: true,
      units: [
        unit('U1', 'Count down'),
        { ...unit('U2', 'Ring the bell'), changeRequestId: 'b:14' },
      ],
    };
    const commands = planCommands({ ...data, openIntent: followed, changeRequests: [request()] });
    expect(commands.slice(1, 4).map((command) => command.title)).toEqual([
      'Plan: stop following',
      'Plan: refresh pull requests now',
      'Open pull request #14 of U2 on the host',
    ]);
  });
});

// Agent workbench spec 84: a plan's files open from the project's intents folder, and a unit's
// thread starts from its contract.
describe('plan files and unit threads', () => {
  it("finds a plan file in the project's own intents folder, else the global one", () => {
    const rows = [{ key: 'plans.intentsDirectory', scope: 'project:tea', value: 'docs/plans/' }];
    expect(intentsDirectoryOf(rows, 'tea', 'intents')).toBe('docs/plans/');
    expect(intentsDirectoryOf(rows, 'other', 'intents')).toBe('intents');
    expect(planFilePath('docs/plans/', '2026-07-tea', 'spec.md')).toBe(
      'docs/plans/2026-07-tea/spec.md',
    );
  });

  it("writes the unit's contract into the first message, field by field", () => {
    const withContract: PlanUnit = {
      ...unit('U2', 'Ring the bell'),
      contract: [
        { name: 'Outcome', value: 'The bell rings when the tea is ready.' },
        { name: 'Boundaries', value: null },
        { name: 'Acceptance', value: '- Given a timer, then it rings.' },
      ],
    };
    expect(
      unitThreadText(intent('tea', '2026-07-tea'), withContract, 'intents/2026-07-tea/plan.md'),
    ).toBe(
      [
        'Work on unit U2 "Ring the bell" of "Title of 2026-07-tea" (intents/2026-07-tea/plan.md).',
        '',
        'Its contract:',
        '',
        'Outcome: The bell rings when the tea is ready.',
        'Acceptance: - Given a timer, then it rings.',
      ].join('\n'),
    );
  });

  it('has palette commands for the files and for a thread per unit', () => {
    const open = intent('tea', '2026-07-tea', {
      spec: { rev: 1, status: 'accepted', stale: null },
      units: [unit('U2', 'Ring the bell')],
    });
    const titles = planCommands({
      intents: [open],
      projects: [project('tea', 'Tea')],
      openIntent: open,
      directoryOf: () => 'intents',
    }).map((command) => command.title);
    expect(titles).toContain('Plan: open intent.md');
    expect(titles).toContain('Plan: open spec.md');
    expect(titles).not.toContain('Plan: open plan.md');
    expect(titles).toContain('Start a thread for U2: Ring the bell');
  });
});
