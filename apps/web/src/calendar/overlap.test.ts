import type { CalendarItem } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { placeTimedItems } from './layout';
import { layoutColumns, type ColumnPlacement } from './overlap';
import { parseIsoDate, type LocalDate } from './time';

const at = (clock: string): number => {
  const [hour, minute] = clock.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
};

const span = (id: string, from: string, to: string) => ({ id, top: at(from), bottom: at(to) });

const layout = (
  items: readonly { id: string; top: number; bottom: number }[],
  minLength?: number,
): Record<string, [column: number, span: number, columns: number]> =>
  Object.fromEntries(
    layoutColumns(items, minLength).map(({ id, column, span: covers, columns }) => [
      id,
      [column, covers, columns],
    ]),
  );

const left = (p: ColumnPlacement) => p.column / p.columns;
const right = (p: ColumnPlacement) => (p.column + p.span) / p.columns;

// No two placed items that overlap in time may share horizontal room.
function expectNoCover(
  placed: readonly (ColumnPlacement & { top: number; bottom: number; id: string })[],
  minLength = 0,
) {
  const covered: string[] = [];
  for (const a of placed) {
    for (const b of placed) {
      if (a.id >= b.id) continue;
      const aBottom = Math.max(a.bottom, a.top + minLength);
      const bBottom = Math.max(b.bottom, b.top + minLength);
      const inTime = (a.top < bBottom && b.top < aBottom) || a.top === b.top;
      const sideBySide = right(a) <= left(b) + 1e-9 || right(b) <= left(a) + 1e-9;
      if (inTime && !sideBySide) covered.push(`${a.id} and ${b.id}`);
    }
  }
  expect(covered).toEqual([]);
}

const zone = 'Europe/Stockholm';
const date = (text: string): LocalDate => {
  const parsed = parseIsoDate(text);
  if (!parsed) throw new Error(`bad date ${text}`);
  return parsed;
};
const columnsOf = (placed: ReturnType<typeof placeTimedItems>) =>
  placed.map(({ item: { id }, top, bottom, column, span: covers, columns }) => [
    id,
    top,
    bottom,
    column,
    covers,
    columns,
  ]);

describe('layoutColumns', () => {
  it('leaves items that do not overlap full width', () => {
    expect(
      layout([
        span('a', '09:00', '10:00'),
        span('b', '10:00', '11:00'),
        span('c', '13:00', '14:00'),
      ]),
    ).toEqual({ a: [0, 1, 1], b: [0, 1, 1], c: [0, 1, 1] });
  });

  it('puts two overlapping items side by side at half width', () => {
    const items = [span('a', '09:00', '10:00'), span('b', '09:30', '10:30')];
    expect(layout(items)).toEqual({ a: [0, 1, 2], b: [1, 1, 2] });
    expectNoCover(layoutColumns(items));
  });

  it('keeps a chain in one cluster and reuses the column A frees for C', () => {
    // A and C do not overlap, but both overlap B, so all three share the cluster's two columns.
    const items = [
      span('a', '09:00', '10:00'),
      span('b', '09:30', '11:00'),
      span('c', '10:00', '11:30'),
      span('d', '12:00', '13:00'),
    ];
    expect(layout(items)).toEqual({
      a: [0, 1, 2],
      b: [1, 1, 2],
      c: [0, 1, 2],
      d: [0, 1, 1],
    });
    expectNoCover(layoutColumns(items));
  });

  it('splits items with identical times evenly, in input order', () => {
    const items = [
      span('x', '10:00', '11:00'),
      span('y', '10:00', '11:00'),
      span('z', '10:00', '11:00'),
    ];
    expect(layout(items)).toEqual({ x: [0, 1, 3], y: [1, 1, 3], z: [2, 1, 3] });
    expectNoCover(layoutColumns(items));
  });

  it('puts the longer of two items starting together first', () => {
    expect(layout([span('short', '10:00', '10:30'), span('long', '10:00', '12:00')])).toEqual({
      long: [0, 1, 2],
      short: [1, 1, 2],
    });
  });

  it('lets an item stretch right over columns that stay free', () => {
    // a and b take two columns; c starts after b ends and only collides with a, so it gets
    // column 1 alone; d collides with nothing in column 1 and stretches over it.
    const items = [
      span('a', '09:00', '12:00'),
      span('b', '09:00', '10:00'),
      span('c', '10:00', '11:00'),
      span('e', '09:30', '10:30'),
      span('d', '11:00', '12:00'),
    ];
    expect(layout(items)).toEqual({
      a: [0, 1, 3],
      b: [1, 1, 3],
      e: [2, 1, 3],
      c: [1, 1, 3],
      d: [1, 2, 3],
    });
    expectNoCover(layoutColumns(items));
  });

  it('stretches only over columns that stay free for its whole length', () => {
    const items = [
      span('a', '09:00', '09:30'),
      span('b', '09:00', '11:00'),
      span('c', '09:00', '09:30'),
      span('d', '10:00', '10:30'),
    ];
    // b is longest and goes first. a cannot stretch (c is beside it); d can, over c's column.
    expect(layout(items)).toEqual({
      b: [0, 1, 3],
      a: [1, 1, 3],
      c: [2, 1, 3],
      d: [1, 2, 3],
    });
    expectNoCover(layoutColumns(items));
  });

  it('separates zero-length items at the same moment and inside another item', () => {
    const items = [
      span('meeting', '10:00', '11:00'),
      span('ping', '10:30', '10:30'),
      span('pong', '10:30', '10:30'),
      span('after', '11:00', '11:00'),
    ];
    expect(layout(items)).toEqual({
      meeting: [0, 1, 3],
      ping: [1, 1, 3],
      pong: [2, 1, 3],
      // Touching the end is not overlapping.
      after: [0, 1, 1],
    });
    expectNoCover(layoutColumns(items));
  });

  it('gives short items their drawn length so their blocks do not cover the next one', () => {
    const items = [span('reminder', '09:00', '09:05'), span('standup', '09:15', '09:30')];
    expect(layout(items)).toEqual({ reminder: [0, 1, 1], standup: [0, 1, 1] });
    // At a zoom where a block is never shorter than 30 minutes, the two collide.
    expect(layout(items, 30)).toEqual({ reminder: [0, 1, 2], standup: [1, 1, 2] });
    expectNoCover(layoutColumns(items, 30), 30);
  });

  it('keeps every overlapping pair apart in a busy day', () => {
    // A fixed pseudo-random day: 40 items starting on quarter hours between 08:00 and 16:00.
    let seed = 7;
    const next = () => {
      seed = (seed * 48271) % 2147483647;
      return seed;
    };
    const items = Array.from({ length: 40 }, (_, index) => {
      const top = 8 * 60 + (next() % 32) * 15;
      return { id: `i${String(index).padStart(2, '0')}`, top, bottom: top + (next() % 8) * 15 };
    });
    const placed = layoutColumns(items, 10);
    expect(placed).toHaveLength(40);
    expectNoCover(placed, 10);
    for (const item of placed) expect(item.column + item.span).toBeLessThanOrEqual(item.columns);
  });

  it('returns nothing for nothing', () => {
    expect(layoutColumns([])).toEqual([]);
  });
});

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
    organizer: null,
    projectId: null,
    backlogItemId: null,
    workflowId: null,
    runId: null,
    state: 'scheduled',
    updatedAt: start,
    ...extra,
  }) satisfies CalendarItem;

describe('placeTimedItems in columns', () => {
  it('lays out Outlook items and local cards together and keeps all-day items out', () => {
    const placed = placeTimedItems(
      [
        item('review', '2026-11-03T09:00:00.000Z', '2026-11-03T10:00:00.000Z'),
        item('focus', '2026-11-03T09:30:00.000Z', '2026-11-03T11:00:00.000Z', { source: 'local' }),
        item('offsite', '2026-11-02T23:00:00.000Z', '2026-11-04T23:00:00.000Z', { allDay: true }),
      ],
      date('2026-11-03'),
      zone,
    );
    expect(columnsOf(placed)).toEqual([
      ['review', 600, 660, 0, 1, 2],
      ['focus', 630, 720, 1, 1, 2],
    ]);
  });

  it('places an item crossing midnight in both days with what it overlaps there', () => {
    const items = [
      item('deploy', '2026-11-03T22:00:00.000Z', '2026-11-04T01:00:00.000Z'),
      item('late', '2026-11-03T22:30:00.000Z', '2026-11-03T22:45:00.000Z'),
      item('early', '2026-11-04T00:00:00.000Z', '2026-11-04T00:30:00.000Z'),
    ];
    expect(columnsOf(placeTimedItems(items, date('2026-11-03'), zone))).toEqual([
      ['deploy', 1380, 1440, 0, 1, 2],
      ['late', 1410, 1425, 1, 1, 2],
    ]);
    expect(columnsOf(placeTimedItems(items, date('2026-11-04'), zone))).toEqual([
      ['deploy', 0, 120, 0, 1, 2],
      ['early', 60, 90, 1, 1, 2],
    ]);
  });

  it('lays out the repeated hour of the October DST change by wall-clock time', () => {
    // Sunday 25 October 2026 in Stockholm: 02:00–03:00 happens twice. The first 02:30 (CEST) and
    // the second (CET) are an hour apart in real time but at the same place on the grid.
    const items = [
      item('first', '2026-10-25T00:30:00.000Z', '2026-10-25T00:45:00.000Z'),
      item('second', '2026-10-25T01:30:00.000Z', '2026-10-25T01:45:00.000Z'),
      item('morning', '2026-10-25T08:00:00.000Z', '2026-10-25T09:00:00.000Z'),
      item('brunch', '2026-10-25T08:30:00.000Z', '2026-10-25T09:30:00.000Z'),
    ];
    expect(columnsOf(placeTimedItems(items, date('2026-10-25'), zone))).toEqual([
      ['first', 150, 165, 0, 1, 2],
      ['second', 150, 165, 1, 1, 2],
      ['morning', 540, 600, 0, 1, 2],
      ['brunch', 570, 630, 1, 1, 2],
    ]);
  });

  it('uses the shortest drawn length it is given', () => {
    const items = [
      item('ping', '2026-11-03T08:00:00.000Z', '2026-11-03T08:00:00.000Z'),
      item('standup', '2026-11-03T08:15:00.000Z', '2026-11-03T08:30:00.000Z'),
    ];
    expect(columnsOf(placeTimedItems(items, date('2026-11-03'), zone))).toEqual([
      ['ping', 540, 540, 0, 1, 1],
      ['standup', 555, 570, 0, 1, 1],
    ]);
    expect(columnsOf(placeTimedItems(items, date('2026-11-03'), zone, 22.5))).toEqual([
      ['ping', 540, 540, 0, 1, 2],
      ['standup', 555, 570, 1, 1, 2],
    ]);
  });
});
