import { beforeAll, describe, expect, it } from 'vitest';
import { loadFixtures, type OutlookFixtures } from './fixtures.js';
import { MockOutlookSource } from './mock-source.js';
import { OutlookError } from './source.js';
import { FakeClock } from './testing.js';
import { calendarWindow } from './zone.js';

const zone = 'Europe/Stockholm';
// Wednesday 4 November 2026, 10:00 in Stockholm.
const clock = new FakeClock('2026-11-04T09:00:00Z');
const window = calendarWindow(clock.now(), { zone, firstDayOfWeek: 'monday', lookaheadDays: 6 });

let fixtures: OutlookFixtures;
beforeAll(async () => {
  fixtures = await loadFixtures();
});

const source = () => new MockOutlookSource({ fixtures, clock, zone });

describe('MockOutlookSource', () => {
  it('expands recurring meetings once per occurrence with the series entry id', async () => {
    const items = await source().calendar(window);
    const standups = items.filter((item) => item.entryId === 'mock-standup');
    // Monday 2 to Friday 6, then Monday 9 and Tuesday 10 November.
    expect(standups.map((item) => item.start)).toEqual([
      '2026-11-02T08:15:00.000Z',
      '2026-11-03T08:15:00.000Z',
      '2026-11-04T08:15:00.000Z',
      '2026-11-05T08:15:00.000Z',
      '2026-11-06T08:15:00.000Z',
      '2026-11-09T08:15:00.000Z',
      '2026-11-10T08:15:00.000Z',
    ]);
    expect(standups.every((item) => item.isRecurring)).toBe(true);
    expect(standups[0]?.joinUrl).toMatch(/^https:\/\/teams\.microsoft\.com\/l\/meetup-join\//);
  });

  it('covers all-day, cancelled and Teams-in-location items and sorts by start', async () => {
    const items = await source().calendar(window);
    const offsite = items.find((item) => item.entryId === 'mock-offsite');
    expect(offsite).toMatchObject({
      isAllDay: true,
      start: '2026-11-06T23:00:00.000Z',
      end: '2026-11-08T23:00:00.000Z',
    });
    expect(items.find((item) => item.entryId === 'mock-architecture-sync')?.isCancelled).toBe(true);
    expect(items.find((item) => item.entryId === 'mock-design-review')?.joinUrl).toContain(
      'teams.microsoft.com',
    );
    const starts = items.map((item) => Date.parse(item.start));
    expect(starts).toEqual([...starts].toSorted((a, b) => a - b));
  });

  it('leaves out items outside the window', async () => {
    const items = await source().calendar({
      from: '2026-11-04T23:00:00.000Z',
      to: '2026-11-05T23:00:00.000Z',
    });
    expect(items.map((item) => item.entryId)).toEqual([
      'mock-standup',
      'mock-design-review',
      'mock-one-on-one',
    ]);
  });

  it('fails every read while unavailable and records opened items', async () => {
    const mock = source();
    await mock.open('mock-design-review');
    expect(mock.opened).toEqual(['mock-design-review']);
    mock.setUnavailable('Outlook is not running');
    expect(await mock.ping()).toMatchObject({ outlook: 'unavailable' });
    await expect(mock.calendar(window)).rejects.toBeInstanceOf(OutlookError);
    await expect(mock.profile()).rejects.toMatchObject({ code: 'unavailable' });
    mock.setUnavailable(null);
    expect(await mock.ping()).toMatchObject({ outlook: 'available' });
  });

  it('rejects fixtures that mix one-off and recurring placement', () => {
    expect(
      () =>
        new MockOutlookSource({
          fixtures: {
            appointments: [
              {
                entryId: 'x',
                subject: 'x',
                dayOffset: 0,
                weekdays: ['monday'],
                time: '09:00',
                minutes: 10,
              },
            ],
          },
        }),
    ).toThrow('Give either dayOffset or weekdays');
  });
});
