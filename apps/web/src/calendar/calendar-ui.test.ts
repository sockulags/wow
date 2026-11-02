import type { CalendarItem, Project, Workflow, WorkflowRun } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { durationLabel, formRange, lastUsedProjectId, triggerSummary } from './card-form';
import { applyCardKey, cardKeyChange, gridMove, nextStop, type GridStop } from './grid-keys';
import { cardKind, meetingPlace } from './items';
import { capColumns, placeTimedItems, visibleDays } from './layout';
import { formatDays, formatWorkHours } from './settings-fields';
import { blockLines } from './time-grid';
import {
  formatDateRange,
  formatOffset,
  formatZone,
  isoDate,
  isoWeek,
  parseIsoDate,
  type LocalDate,
} from './time';

const zone = 'Europe/Stockholm';
const date = (text: string): LocalDate => {
  const parsed = parseIsoDate(text);
  if (!parsed) throw new Error(text);
  return parsed;
};

const item = (id: string, start: string, end: string, extra: Partial<CalendarItem> = {}) =>
  ({
    id,
    source: 'local',
    externalId: null,
    title: id,
    start,
    end,
    zone,
    allDay: false,
    location: null,
    joinUrl: null,
    body: null,
    organizer: null,
    projectId: null,
    backlogItemId: null,
    workflowId: null,
    runId: null,
    state: 'scheduled',
    updatedAt: start,
    ...extra,
  }) satisfies CalendarItem;

describe('card dialog rules (audit B-03, B-04, B-18)', () => {
  it('refuses an end before the start instead of making an overnight card', () => {
    expect(formRange({ date: '2026-11-02', start: '14:45', end: '10:00' }, zone)).toEqual({
      ok: false,
      field: 'end',
      message: 'Ends before it starts',
    });
    expect(formRange({ date: '2026-11-02', start: '10:00', end: '10:00' }, zone)).toMatchObject({
      ok: false,
    });
    expect(formRange({ date: '2026-11-31', start: '10:00', end: '11:00' }, zone)).toMatchObject({
      ok: false,
      field: 'date',
    });
  });

  it('gives the instants and the length, with 00:00 as the end of the day', () => {
    expect(formRange({ date: '2026-11-02', start: '09:00', end: '10:30' }, zone)).toEqual({
      ok: true,
      start: '2026-11-02T08:00:00.000Z',
      end: '2026-11-02T09:30:00.000Z',
      minutes: 90,
    });
    expect(formRange({ date: '2026-11-02', start: '23:00', end: '00:00' }, zone)).toMatchObject({
      ok: true,
      minutes: 60,
    });
    expect(durationLabel(90)).toBe('1 h 30 min');
    expect(durationLabel(45)).toBe('45 min');
    expect(durationLabel(120)).toBe('2 h');
  });

  it('prefills the project of the card changed last', () => {
    const projects = [
      { id: 'demo', name: 'Demo' },
      { id: 'web', name: 'Web' },
    ] as Project[];
    const cards = [
      item('a', '2026-11-02T08:00:00.000Z', '2026-11-02T09:00:00.000Z', {
        projectId: 'demo',
        updatedAt: '2026-11-01T08:00:00.000Z',
      }),
      item('b', '2026-11-02T08:00:00.000Z', '2026-11-02T09:00:00.000Z', {
        projectId: 'web',
        updatedAt: '2026-11-02T08:00:00.000Z',
      }),
      item('c', '2026-11-02T08:00:00.000Z', '2026-11-02T09:00:00.000Z', {
        projectId: 'gone',
        updatedAt: '2026-11-03T08:00:00.000Z',
      }),
    ];
    expect(lastUsedProjectId(cards, projects)).toBe('web');
    expect(lastUsedProjectId([], projects)).toBe('');
  });

  it('says what a trigger will do', () => {
    const workflow = {
      id: 'wf',
      name: 'Feature',
      steps: [
        { gateBefore: false, gateAfter: true },
        { gateBefore: false, gateAfter: true },
        { gateBefore: false, gateAfter: false },
      ],
    } as Workflow;
    const project = { id: 'demo', name: 'Demo' } as Project;
    const base = { workflow, project, start: '2026-11-02T15:30:00.000Z', zone, run: undefined };
    expect(triggerSummary({ ...base, workflow: undefined })).toEqual({ tone: 'none' });
    expect(triggerSummary({ ...base, project: undefined })).toEqual({
      tone: 'warning',
      text: 'Will not run: pick a project.',
    });
    expect(triggerSummary(base)).toEqual({
      tone: 'info',
      text: 'Starts at 16:30 in Demo · 3 steps, 2 gates',
    });
    expect(triggerSummary({ ...base, run: { id: 'r1', state: 'waiting' } as WorkflowRun })).toEqual(
      { tone: 'run', text: 'The workflow run is waiting for you.', runId: 'r1' },
    );
  });
});

describe('cards and meetings (audit B-01, B-06)', () => {
  it('tells triggers from plain cards and cards that will not run', () => {
    const at = ['2026-11-02T08:00:00.000Z', '2026-11-02T09:00:00.000Z'] as const;
    expect(cardKind(item('plain', ...at))).toBe('plain');
    expect(cardKind(item('lost', ...at, { workflowId: 'wf' }))).toBe('unrunnable');
    expect(cardKind(item('trigger', ...at, { workflowId: 'wf', projectId: 'p' }))).toBe('trigger');
  });

  it('names a meeting place without raw Teams links', () => {
    const teams = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0';
    expect(meetingPlace(teams, teams)).toBe('Teams meeting');
    expect(meetingPlace('Microsoft Teams Meeting', teams)).toBe('Teams meeting');
    expect(meetingPlace(null, teams)).toBe('Teams meeting');
    expect(meetingPlace('https://meet.example/abc', null)).toBe('Online meeting');
    expect(meetingPlace('Room Ferrite', null)).toBe('Room Ferrite');
    expect(meetingPlace(null, null)).toBeNull();
  });
});

describe('week layout (audit B-02, F-7)', () => {
  const day = date('2026-11-03');
  const cluster = ['a', 'b', 'c', 'd'].map((id, index) =>
    item(
      id,
      `2026-11-03T09:${String(index * 10).padStart(2, '0')}:00.000Z`,
      '2026-11-03T10:30:00.000Z',
    ),
  );

  it('caps a crowded cluster and puts the rest behind one chip', () => {
    const placed = placeTimedItems(cluster, day, zone);
    expect(placed.map((entry) => entry.columns)).toEqual([4, 4, 4, 4]);
    const { shown, overflow } = capColumns(placed, 2);
    expect(shown.map((entry) => [entry.item.id, entry.column, entry.columns])).toEqual([
      ['a', 0, 2],
    ]);
    expect(overflow).toHaveLength(1);
    expect(overflow[0]?.items.map((entry) => entry.id)).toEqual(['b', 'c', 'd']);
    expect(overflow[0]).toMatchObject({ column: 1, columns: 2 });
  });

  it('leaves clusters that fit alone', () => {
    const placed = placeTimedItems(cluster.slice(0, 2), day, zone);
    expect(capColumns(placed, 2)).toEqual({ shown: placed, overflow: [] });
    expect(capColumns(placeTimedItems(cluster, day, zone), 4).overflow).toEqual([]);
  });

  it('leaves the weekend out when asked', () => {
    expect(visibleDays('week', day, 'monday', false).map(isoDate)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
    ]);
    expect(visibleDays('week', day, 'sunday', true)).toHaveLength(7);
  });
});

describe('block layout (audit B-13)', () => {
  it('wraps the title into the lines a block has left', () => {
    expect(blockLines(18)).toEqual({
      titleLines: 1,
      showTime: false,
      showButton: false,
      showExtra: false,
    });
    expect(blockLines(48)).toMatchObject({ titleLines: 1, showTime: true });
    expect(blockLines(96)).toMatchObject({ titleLines: 3, showTime: true });
    // Join becomes an icon until there is room for a button row.
    expect(blockLines(48, { button: true })).toMatchObject({ showButton: false });
    expect(blockLines(72, { button: true })).toMatchObject({ showButton: true, titleLines: 1 });
  });
});

describe('toolbar wording (audit B-09, B-12)', () => {
  it('writes ranges the short way', () => {
    expect(formatDateRange(date('2026-11-02'), date('2026-11-08'))).toBe('2–8 Nov 2026');
    expect(formatDateRange(date('2026-11-30'), date('2026-12-06'))).toBe('30 Nov – 6 Dec 2026');
    expect(formatDateRange(date('2026-12-28'), date('2027-01-03'))).toBe(
      '28 Dec 2026 – 3 Jan 2027',
    );
    expect(formatDateRange(date('2026-11-02'), date('2026-11-08'), false)).toBe('2–8 Nov');
  });

  it('numbers ISO weeks', () => {
    expect(isoWeek(date('2026-11-02'))).toBe(45);
    expect(isoWeek(date('2026-01-01'))).toBe(1);
    expect(isoWeek(date('2027-01-01'))).toBe(53);
    expect(isoWeek(date('2025-12-29'))).toBe(1);
  });

  it('names a zone by its city and offset', () => {
    const winter = new Date('2026-11-02T12:00:00Z');
    expect(formatZone('Europe/Stockholm', winter)).toBe('Stockholm, UTC+1');
    expect(formatZone('America/New_York', winter)).toBe('New York, UTC-5');
    expect(formatOffset('Asia/Kolkata', winter)).toBe('UTC+5:30');
  });

  it('writes work hours with capitalized day ranges', () => {
    expect(formatDays(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'])).toBe('Mon–Fri');
    expect(formatDays(['friday', 'monday', 'wednesday'])).toBe('Mon, Wed, Fri');
    expect(formatWorkHours({ start: '08:30', end: '17:00', days: ['saturday', 'sunday'] })).toBe(
      '08:30–17:00, Sat, Sun',
    );
  });
});

const press = (
  key: string,
  modifiers: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {},
) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

describe('grid keys (audit B-07)', () => {
  const stops: GridStop[] = [
    { key: '0:a', dayIndex: 0, top: 540 },
    { key: '0:b', dayIndex: 0, top: 720 },
    { key: '2:c', dayIndex: 2, top: 700 },
    { key: '2:d', dayIndex: 2, top: 900 },
  ];
  it('moves within a day, across days by time, and to the ends', () => {
    expect(nextStop(stops, '0:a', 'down')).toBe('0:b');
    expect(nextStop(stops, '0:b', 'down')).toBe('0:b');
    expect(nextStop(stops, '0:b', 'right')).toBe('2:c');
    expect(nextStop(stops, '2:d', 'left')).toBe('0:b');
    expect(nextStop(stops, '0:a', 'left')).toBe('0:a');
    expect(nextStop(stops, '2:c', 'end')).toBe('2:d');
    expect(nextStop(stops, '2:d', 'first')).toBe('0:a');
    expect(nextStop(stops, 'gone', 'down')).toBe('0:a');
  });

  it('reads plain arrows as moves and Alt arrows as card changes', () => {
    expect(gridMove(press('ArrowDown'))).toBe('down');
    expect(gridMove(press('Home', { ctrlKey: true }))).toBe('first');
    expect(gridMove(press('ArrowDown', { altKey: true }))).toBeUndefined();
    expect(cardKeyChange(press('ArrowDown', { altKey: true }), 15)).toEqual({
      kind: 'move',
      minutes: 15,
      days: 0,
    });
    expect(cardKeyChange(press('ArrowLeft', { altKey: true }), 15)).toEqual({
      kind: 'move',
      minutes: 0,
      days: -1,
    });
    expect(cardKeyChange(press('ArrowUp', { altKey: true, shiftKey: true }), 15)).toEqual({
      kind: 'resize',
      minutes: -15,
    });
    expect(cardKeyChange(press('ArrowDown'), 15)).toBeUndefined();
  });

  it('moves a card by snap steps and days, keeps its clock time, and never shrinks it away', () => {
    const card = { start: '2026-10-24T08:00:00.000Z', end: '2026-10-24T08:30:00.000Z' };
    expect(applyCardKey(card, { kind: 'move', minutes: 15, days: 0 }, zone, 15)).toEqual({
      start: '2026-10-24T08:15:00.000Z',
      end: '2026-10-24T08:45:00.000Z',
    });
    // Across the October DST change the card stays at 10:00 local time.
    expect(applyCardKey(card, { kind: 'move', minutes: 0, days: 1 }, zone, 15)).toEqual({
      start: '2026-10-25T09:00:00.000Z',
      end: '2026-10-25T09:30:00.000Z',
    });
    expect(applyCardKey(card, { kind: 'resize', minutes: -30 }, zone, 15)).toEqual({
      start: card.start,
      end: '2026-10-24T08:15:00.000Z',
    });
    const late = { start: '2026-11-02T22:45:00.000Z', end: '2026-11-02T23:00:00.000Z' };
    expect(applyCardKey(late, { kind: 'move', minutes: 15, days: 0 }, zone, 15).start).toBe(
      '2026-11-02T23:00:00.000Z',
    );
  });
});
