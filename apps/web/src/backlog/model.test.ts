import type { BacklogItem, WorkflowRun } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { backlogCommands } from './commands';
import type { CalendarItem } from '@wow/contracts';
import {
  allTags,
  busyTimes,
  emptyFilter,
  filterItems,
  isManualState,
  lastPlanningWorkflow,
  nextFreeSlot,
  nextHour,
  overlaps,
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

const meeting = (title: string, start: string, end: string, extra: Partial<CalendarItem> = {}) =>
  ({
    id: title,
    source: 'outlook',
    externalId: null,
    title,
    start,
    end,
    zone: 'UTC',
    allDay: false,
    location: null,
    joinUrl: null,
    body: null,
    projectId: null,
    backlogItemId: null,
    workflowId: null,
    runId: null,
    state: 'scheduled',
    updatedAt: '2026-11-01T08:00:00.000Z',
    ...extra,
  }) satisfies CalendarItem;

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
    // The default list shows open work: done and dropped items wait for a filter.
    expect(ids(emptyFilter)).toEqual(['a', 'b']);
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
    expect(planRange('2026-11-03', '09:30', '10:15', 'Europe/Stockholm')).toEqual({
      start: '2026-11-03T08:30:00.000Z',
      end: '2026-11-03T09:15:00.000Z',
    });
    expect(planRange('2026-02-30', '09:30', '10:00', 'UTC')).toBe('Give a date and a start time');
    expect(planRange('2026-11-03', '09:30', '09:30', 'UTC')).toBe(
      'The end has to be after the start',
    );
  });

  it('suggests the next free slot in work hours, around meetings', () => {
    const workHours = { start: '09:00', end: '17:00', days: ['monday', 'tuesday'] as const };
    const busy = busyTimes([
      meeting('Standup', '2026-11-02T09:00:00.000Z', '2026-11-02T09:15:00.000Z'),
      meeting('Design review', '2026-11-02T09:30:00.000Z', '2026-11-02T11:00:00.000Z'),
      meeting('Cancelled', '2026-11-02T11:00:00.000Z', '2026-11-02T12:00:00.000Z', {
        state: 'cancelled',
      }),
    ]);
    const slot = (now: string, minutes = 30) =>
      nextFreeSlot({
        now: new Date(now),
        zone: 'UTC',
        workHours: { ...workHours, days: [...workHours.days] },
        busy,
        minutes,
        snapMinutes: 15,
        days: 7,
      });
    // Monday 08:00: the 15 minutes after standup are too short, so after the review.
    expect(slot('2026-11-02T08:00:00.000Z')).toEqual({
      date: '2026-11-02',
      start: '11:00',
      end: '11:30',
    });
    expect(slot('2026-11-02T08:00:00.000Z', 15)).toEqual({
      date: '2026-11-02',
      start: '09:15',
      end: '09:30',
    });
    // Monday evening: the next work day starts at 09:00.
    expect(slot('2026-11-02T18:00:00.000Z')).toEqual({
      date: '2026-11-03',
      start: '09:00',
      end: '09:30',
    });
    expect(
      overlaps(
        busy,
        Date.parse('2026-11-02T10:00:00.000Z'),
        Date.parse('2026-11-02T10:30:00.000Z'),
      ).map((entry) => entry.title),
    ).toEqual(['Design review']);
  });

  it('remembers the workflow last used for planning', () => {
    expect(
      lastPlanningWorkflow([
        meeting('Old', '2026-11-02T09:00:00.000Z', '2026-11-02T10:00:00.000Z', {
          source: 'local',
          backlogItemId: 'a',
          workflowId: 'w-old',
          updatedAt: '2026-10-01T08:00:00.000Z',
        }),
        meeting('New', '2026-11-02T09:00:00.000Z', '2026-11-02T10:00:00.000Z', {
          source: 'local',
          backlogItemId: 'b',
          workflowId: 'w-new',
          updatedAt: '2026-11-01T08:00:00.000Z',
        }),
        meeting('Plain card', '2026-11-02T09:00:00.000Z', '2026-11-02T10:00:00.000Z', {
          source: 'local',
          workflowId: 'w-plain',
          updatedAt: '2026-11-02T08:00:00.000Z',
        }),
      ]),
    ).toBe('w-new');
  });

  it('lets the user set only Idea and Dropped (F-12)', () => {
    expect(
      ['idea', 'planned', 'running', 'done', 'dropped'].filter((state) =>
        isManualState(state as BacklogItem['state']),
      ),
    ).toEqual(['idea', 'dropped']);
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
      'Fix the login',
      'Dark mode',
      'Old idea',
      'Shipped',
    ]);
    expect(titles(items[0]).slice(0, 4)).toEqual([
      'New backlog item',
      'Plan on calendar',
      'Publish to Jira',
      'Publish to GitHub',
    ]);
  });
});
