import type { BacklogItem, WorkflowRun } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { backlogCommands } from './commands';
import {
  allTags,
  filterItems,
  nextHour,
  parseTags,
  planRange,
  runProblem,
  sortItems,
} from './model';

const item = (id: string, overrides: Partial<BacklogItem> = {}): BacklogItem => ({
  id,
  title: `Item ${id}`,
  body: '',
  tags: [],
  state: 'idea',
  runId: null,
  remote: null,
  createdAt: '2026-11-02T08:00:00.000Z',
  ...overrides,
});

const items = [
  item('a', { title: 'Fix the login', tags: ['auth', 'bug'], state: 'planned' }),
  item('b', { title: 'Dark mode', body: 'Respect the **system** theme', tags: ['ui'] }),
  item('c', { title: 'Old idea', state: 'dropped', createdAt: '2026-10-01T08:00:00.000Z' }),
  item('d', { title: 'Shipped', state: 'done', tags: ['auth'] }),
];

const runIn = (state: WorkflowRun['state'], error?: string): WorkflowRun => ({
  id: 'r1',
  workflowId: 'w1',
  projectId: 'p1',
  calendarItemId: null,
  backlogItemId: 'a',
  state,
  currentStep: 0,
  steps: [
    {
      stepId: 's1',
      state: state === 'failed' ? 'failed' : 'done',
      artifactsFound: [],
      ...(error ? { error } : {}),
    },
  ],
  startedAt: '2026-11-02T08:00:00.000Z',
  endedAt: null,
});

describe('backlog model', () => {
  it('reads tags from one comma-separated line', () => {
    expect(parseTags(' auth, bug ,, auth,ui ')).toEqual(['auth', 'bug', 'ui']);
    expect(parseTags('')).toEqual([]);
  });

  it('filters by text in title, body or tags, by state and by tag', () => {
    const ids = (filter: Parameters<typeof filterItems>[1]) =>
      filterItems(items, filter).map((entry) => entry.id);
    expect(ids({ text: 'SYSTEM', state: '', tag: '' })).toEqual(['b']);
    expect(ids({ text: 'auth', state: '', tag: '' })).toEqual(['a', 'd']);
    expect(ids({ text: '', state: 'done', tag: '' })).toEqual(['d']);
    expect(ids({ text: '', state: '', tag: 'auth' })).toEqual(['a', 'd']);
    expect(ids({ text: '', state: 'planned', tag: 'ui' })).toEqual([]);
    expect(allTags(items)).toEqual(['auth', 'bug', 'ui']);
  });

  it('lists open work first and dropped items last', () => {
    expect(sortItems(items).map((entry) => entry.id)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('says why the last run did not finish', () => {
    expect(runProblem(runIn('failed', 'Tests failed'))).toBe('The run failed: Tests failed');
    expect(runProblem(runIn('stopped'))).toBe('The run was stopped.');
    expect(runProblem(runIn('running'))).toBeUndefined();
    expect(runProblem(runIn('done'))).toBeUndefined();
    expect(runProblem(undefined)).toBeUndefined();
  });

  it('turns the plan form into a card time in the calendar zone', () => {
    expect(planRange('2026-11-03', '09:30', 45, 'Europe/Stockholm')).toEqual({
      start: '2026-11-03T08:30:00.000Z',
      end: '2026-11-03T09:15:00.000Z',
    });
    expect(planRange('2026-02-30', '09:30', 45, 'UTC')).toBe('Give a date and a start time');
    expect(planRange('2026-11-03', '09:30', 0, 'UTC')).toBe('Give a length in minutes');
  });

  it('suggests the next whole hour, rolling over midnight', () => {
    expect(nextHour(new Date('2026-11-02T08:20:00.000Z'), 'Europe/Stockholm')).toEqual({
      date: '2026-11-02',
      start: '10:00',
    });
    expect(nextHour(new Date('2026-11-02T23:10:00.000Z'), 'UTC')).toEqual({
      date: '2026-11-03',
      start: '00:00',
    });
  });

  it('offers palette commands for every item and the open item', () => {
    const titles = (openItem?: BacklogItem) =>
      backlogCommands({ items, openItem }).map((command) => command.title);
    expect(titles()).toEqual([
      'New backlog item',
      'Backlog: Fix the login',
      'Backlog: Dark mode',
      'Backlog: Old idea',
      'Backlog: Shipped',
    ]);
    expect(titles(items[0]).slice(0, 4)).toEqual([
      'New backlog item',
      'Plan on calendar',
      'Publish to Jira',
      'Publish to GitHub',
    ]);
  });
});
