import type { CalendarItem } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { allDayItemsOn, placeTimedItems, snapMinute, visibleDays, workSpan } from './layout';
import { addDays, atMinute, isoDate, parseIsoDate, startOfDay, type LocalDate } from './time';

// The open risk of U9: the week of the October DST change. In Europe/Stockholm the clocks went
// back from 03:00 to 02:00 on Sunday 25 October 2026.
const zone = 'Europe/Stockholm';
const date = (text: string): LocalDate => {
  const parsed = parseIsoDate(text);
  if (!parsed) throw new Error(`bad date ${text}`);
  return parsed;
};

const item = (id: string, start: string, end: string, extra: Partial<CalendarItem> = {}) =>
  ({
    id,
    source: 'outlook',
    externalId: id,
    title: id,
    start,
    end,
    zone,
    allDay: false,
    location: null,
    joinUrl: null,
    body: null,
    projectId: null,
    backlogItemId: null,
    workflowId: null,
    runId: null,
    state: 'scheduled',
    updatedAt: start,
    ...extra,
  }) satisfies CalendarItem;

describe('the week that crosses the October change', () => {
  it('has seven days and the next week starts on the following Monday', () => {
    const days = visibleDays('week', date('2026-10-22'), 'monday').map(isoDate);
    expect(days).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
    ]);
    expect(isoDate(visibleDays('week', addDays(date('2026-10-22'), 7), 'monday')[0]!)).toBe(
      '2026-10-26',
    );
    expect(visibleDays('week', date('2026-10-28'), 'sunday').map(isoDate)[0]).toBe('2026-10-25');
  });

  it('gives the change day 25 hours', () => {
    const hours =
      (startOfDay(date('2026-10-26'), zone).getTime() -
        startOfDay(date('2026-10-25'), zone).getTime()) /
      3_600_000;
    expect(hours).toBe(25);
  });

  it('keeps a 09:15 meeting at 09:15 before and after the change', () => {
    expect(atMinute(date('2026-10-23'), 9 * 60 + 15, zone).toISOString()).toBe(
      '2026-10-23T07:15:00.000Z',
    );
    expect(atMinute(date('2026-10-26'), 9 * 60 + 15, zone).toISOString()).toBe(
      '2026-10-26T08:15:00.000Z',
    );
    const friday = placeTimedItems(
      [item('fri', '2026-10-23T07:15:00.000Z', '2026-10-23T07:30:00.000Z')],
      date('2026-10-23'),
      zone,
    );
    const sunday = placeTimedItems(
      [item('sun', '2026-10-25T08:15:00.000Z', '2026-10-25T08:30:00.000Z')],
      date('2026-10-25'),
      zone,
    );
    expect(friday.map(({ top, bottom }) => [top, bottom])).toEqual([[555, 570]]);
    expect(sunday.map(({ top, bottom }) => [top, bottom])).toEqual([[555, 570]]);
  });

  it('places an item through the repeated hour by its wall-clock times', () => {
    // 01:00 CEST to 04:00 CET is four real hours across the repeated 02:00–03:00.
    const [night] = placeTimedItems(
      [item('night', '2026-10-24T23:00:00.000Z', '2026-10-25T03:00:00.000Z')],
      date('2026-10-25'),
      zone,
    );
    expect([night?.top, night?.bottom]).toEqual([60, 240]);
  });
});

describe('placing items', () => {
  const day = date('2026-11-03');

  it('puts overlapping items side by side and leaves the rest full width', () => {
    const placed = placeTimedItems(
      [
        item('a', '2026-11-03T08:00:00.000Z', '2026-11-03T09:00:00.000Z'),
        item('b', '2026-11-03T08:30:00.000Z', '2026-11-03T09:30:00.000Z'),
        item('c', '2026-11-03T12:00:00.000Z', '2026-11-03T13:00:00.000Z'),
      ],
      day,
      zone,
    );
    expect(placed.map(({ item: { id }, lane, lanes }) => [id, lane, lanes])).toEqual([
      ['a', 0, 2],
      ['b', 1, 2],
      ['c', 0, 1],
    ]);
  });

  it('clips items that run across midnight and keeps all-day items out of the grid', () => {
    const late = item('late', '2026-11-03T22:00:00.000Z', '2026-11-04T01:00:00.000Z');
    const offsite = item('offsite', '2026-11-02T23:00:00.000Z', '2026-11-04T23:00:00.000Z', {
      allDay: true,
    });
    expect(
      placeTimedItems([late, offsite], day, zone).map(({ top, bottom }) => [top, bottom]),
    ).toEqual([[23 * 60, 1440]]);
    expect(
      placeTimedItems([late], addDays(day, 1), zone).map(({ top, bottom }) => [top, bottom]),
    ).toEqual([[0, 120]]);
    expect(allDayItemsOn([late, offsite], day, zone).map(({ id }) => id)).toEqual(['offsite']);
    expect(allDayItemsOn([offsite], addDays(day, 2), zone)).toEqual([]);
  });

  it('highlights work hours on work days only and snaps minutes', () => {
    const hours = { start: '08:00', end: '17:00', days: ['tuesday' as const] };
    expect(workSpan(hours, day)).toEqual({ top: 480, bottom: 1020 });
    expect(workSpan(hours, addDays(day, 1))).toBeUndefined();
    expect(snapMinute(554, 15)).toBe(555);
    expect(snapMinute(1500, 15)).toBe(1440);
  });

  it('reads only real dates from the URL', () => {
    expect(parseIsoDate('2026-02-30')).toBeUndefined();
    expect(parseIsoDate('2026-2-3')).toBeUndefined();
    expect(parseIsoDate('2026-02-28')).toEqual({ year: 2026, month: 2, day: 28 });
  });
});
