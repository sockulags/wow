import { describe, expect, it } from 'vitest';
import { calendarWindow, zonedInstant } from './zone.js';

describe('calendar window', () => {
  it('runs from the start of the week to the end of the lookahead in the calendar zone', () => {
    // Wednesday 4 November 2026, 10:00 in Stockholm (UTC+1).
    const window = calendarWindow(new Date('2026-11-04T09:00:00Z'), {
      zone: 'Europe/Stockholm',
      firstDayOfWeek: 'monday',
      lookaheadDays: 14,
    });
    expect(window).toEqual({ from: '2026-11-01T23:00:00.000Z', to: '2026-11-18T23:00:00.000Z' });
  });

  it('honours a Sunday week start and crosses a DST change', () => {
    // Thursday 26 March 2026 in New York (UTC-4).
    const window = calendarWindow(new Date('2026-03-26T15:00:00Z'), {
      zone: 'America/New_York',
      firstDayOfWeek: 'sunday',
      lookaheadDays: 1,
    });
    expect(window).toEqual({ from: '2026-03-22T04:00:00.000Z', to: '2026-03-28T04:00:00.000Z' });

    // Tuesday 27 October 2026 in Stockholm: the week began on Saturday in summer time (UTC+2)
    // and summer time ended on Sunday 25 October (UTC+1).
    const stockholm = calendarWindow(new Date('2026-10-27T08:00:00Z'), {
      zone: 'Europe/Stockholm',
      firstDayOfWeek: 'saturday',
      lookaheadDays: 0,
    });
    expect(stockholm).toEqual({ from: '2026-10-23T22:00:00.000Z', to: '2026-10-27T23:00:00.000Z' });
  });

  it('places a wall-clock time in its zone', () => {
    expect(
      zonedInstant(
        { year: 2026, month: 7, day: 1, hour: 9, minute: 15 },
        'Europe/Stockholm',
      ).toISOString(),
    ).toBe('2026-07-01T07:15:00.000Z');
  });
});
